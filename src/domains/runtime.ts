import type {
  HomeAssistantApiInfo,
  HomeAssistantClient,
  HomeAssistantConfig,
  HomeAssistantEventType,
  HomeAssistantServiceDefinition,
  SystemHealth,
} from "../homeassistant/client.js";
import type { HomeAssistantEvent } from "../homeassistant/websocket.js";
import { AppError } from "../shared/errors.js";
import type { EntityState, PageInput, Pagination } from "../shared/types.js";
import { paginate } from "../shared/types.js";

export const MAX_RUNTIME_EVENT_COUNT = 250;
export const MAX_RUNTIME_EVENT_COLLECTION_MS = 120_000;

export interface RuntimePage<T> {
  items: T[];
  pagination: Pagination;
}

export interface StateListOptions extends PageInput {
  query?: string;
  domain?: string;
  state?: string;
  areaId?: string;
  deviceId?: string;
  includeUnavailable?: boolean;
}

export interface RuntimeServiceDefinition extends HomeAssistantServiceDefinition {
  domain: string;
  service: string;
  id: string;
}

export interface ServiceListOptions extends PageInput {
  query?: string;
  domain?: string;
}

export interface EventTypeListOptions extends PageInput {
  query?: string;
  minimumListeners?: number;
}

export interface RuntimeCollectEventsOptions {
  eventType?: string;
  count?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HomeAssistantRuntimeInfo {
  api: HomeAssistantApiInfo;
  config: HomeAssistantConfig;
  system_health: SystemHealth;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function includesQuery(values: readonly unknown[], query: string | undefined): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const text = values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((token) => text.includes(token));
}

function normalizedIdentifier(value: string, label: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(result)) {
    throw new AppError("HA_INVALID_REQUEST", `Invalid Home Assistant ${label}`, {
      details: { value },
    });
  }
  return result;
}

/** Current state, action definition, event, and instance-health access. */
export class RuntimeService {
  constructor(readonly client: HomeAssistantClient) {}

  getState(entityId: string): Promise<EntityState> {
    return this.client.getState(entityId.trim().toLowerCase());
  }

  async listStates(options: StateListOptions = {}): Promise<RuntimePage<EntityState>> {
    const needsRelationships = options.areaId !== undefined || options.deviceId !== undefined;
    const [states, entityRegistry, deviceRegistry] = await Promise.all([
      this.client.getStates(),
      needsRelationships ? this.client.getEntityRegistry() : Promise.resolve([]),
      options.areaId !== undefined ? this.client.getDeviceRegistry() : Promise.resolve([]),
    ]);
    const entityById = new Map(
      entityRegistry.map((entity) => [entity.entity_id.toLowerCase(), entity]),
    );
    const deviceById = new Map(deviceRegistry.map((device) => [device.id, device]));
    const includeUnavailable = options.includeUnavailable ?? true;
    const filtered = states
      .filter((state) => {
        const entityId = state.entity_id.toLowerCase();
        const entity = entityById.get(entityId);
        const device = entity?.device_id ? deviceById.get(entity.device_id) : undefined;
        const areaId = entity?.area_id ?? device?.area_id ?? undefined;
        const domain = entityId.split(".", 1)[0] ?? "";
        const friendlyName = state.attributes.friendly_name;
        return (
          (includeUnavailable || !["unavailable", "unknown"].includes(state.state.toLowerCase())) &&
          (options.domain === undefined || domain === options.domain.toLowerCase()) &&
          (options.state === undefined || state.state === options.state) &&
          (options.areaId === undefined || areaId === options.areaId) &&
          (options.deviceId === undefined || entity?.device_id === options.deviceId) &&
          includesQuery(
            [entityId, state.state, typeof friendlyName === "string" ? friendlyName : undefined],
            options.query,
          )
        );
      })
      .sort((left, right) => compareText(left.entity_id, right.entity_id));
    return paginate(filtered, options);
  }

  listStatesByArea(
    areaId: string,
    options: Omit<StateListOptions, "areaId"> = {},
  ): Promise<RuntimePage<EntityState>> {
    if (areaId.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Home Assistant area ID cannot be empty");
    }
    return this.listStates({ ...options, areaId });
  }

  listStatesByDevice(
    deviceId: string,
    options: Omit<StateListOptions, "deviceId"> = {},
  ): Promise<RuntimePage<EntityState>> {
    if (deviceId.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Home Assistant device ID cannot be empty");
    }
    return this.listStates({ ...options, deviceId });
  }

  async listServices(
    options: ServiceListOptions = {},
  ): Promise<RuntimePage<RuntimeServiceDefinition>> {
    const domains = await this.client.getServices();
    const services = domains
      .flatMap((domain): RuntimeServiceDefinition[] => {
        const definitions = domain.services;
        if (Array.isArray(definitions)) {
          return definitions
            .filter((service): service is string => typeof service === "string")
            .map((service) => ({
              domain: domain.domain,
              service,
              id: `${domain.domain}.${service}`,
            }));
        }
        return Object.entries(definitions).map(([service, definition]) => ({
          ...definition,
          domain: domain.domain,
          service,
          id: `${domain.domain}.${service}`,
        }));
      })
      .filter(
        (service) =>
          (options.domain === undefined || service.domain === options.domain.toLowerCase()) &&
          includesQuery(
            [service.id, service.name, service.description, ...Object.keys(service.fields ?? {})],
            options.query,
          ),
      )
      .sort((left, right) => compareText(left.id, right.id));
    return paginate(services, options);
  }

  async getService(domain: string, service: string): Promise<RuntimeServiceDefinition> {
    const normalizedDomain = normalizedIdentifier(domain, "service domain");
    const normalizedService = normalizedIdentifier(service, "service name");
    const match = (await this.listServices({ domain: normalizedDomain, limit: 500 })).items.find(
      (item) => item.service === normalizedService,
    );
    if (match === undefined) {
      throw new AppError("HA_SERVICE_NOT_FOUND", "Home Assistant service is not registered", {
        details: { domain: normalizedDomain, service: normalizedService },
      });
    }
    return match;
  }

  searchServices(
    query: string,
    options: Omit<ServiceListOptions, "query"> = {},
  ): Promise<RuntimePage<RuntimeServiceDefinition>> {
    if (query.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Service search query cannot be empty");
    }
    return this.listServices({ ...options, query });
  }

  async listEventTypes(
    options: EventTypeListOptions = {},
  ): Promise<RuntimePage<HomeAssistantEventType>> {
    const minimumListeners = options.minimumListeners ?? 0;
    if (!Number.isSafeInteger(minimumListeners) || minimumListeners < 0) {
      throw new AppError(
        "HA_INVALID_REQUEST",
        "Minimum Home Assistant event listener count must be a non-negative integer",
      );
    }
    const eventTypes = (await this.client.getEventTypes())
      .filter(
        (eventType) =>
          eventType.listener_count >= minimumListeners &&
          includesQuery([eventType.event], options.query),
      )
      .sort((left, right) => compareText(left.event, right.event));
    return paginate(eventTypes, options);
  }

  async getEventType(eventType: string): Promise<HomeAssistantEventType> {
    const normalized = eventType.trim();
    if (normalized.length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Home Assistant event type cannot be empty");
    }
    const match = (await this.client.getEventTypes()).find((item) => item.event === normalized);
    if (match === undefined) {
      throw new AppError("HA_EVENT_TYPE_NOT_FOUND", "Home Assistant event type is not registered", {
        details: { event_type: normalized },
      });
    }
    return match;
  }

  collectEvents<T = Record<string, unknown>>(
    options: RuntimeCollectEventsOptions = {},
  ): Promise<Array<HomeAssistantEvent<T>>> {
    const count = options.count ?? 1;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUNTIME_EVENT_COUNT) {
      throw new AppError(
        "HA_EVENT_COLLECTION_LIMIT",
        `Event count must be between 1 and ${MAX_RUNTIME_EVENT_COUNT}`,
        { details: { requested_count: count, maximum_count: MAX_RUNTIME_EVENT_COUNT } },
      );
    }
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_RUNTIME_EVENT_COLLECTION_MS
    ) {
      throw new AppError(
        "HA_EVENT_COLLECTION_LIMIT",
        `Event collection duration must be between 1ms and ${MAX_RUNTIME_EVENT_COLLECTION_MS}ms`,
        {
          details: {
            requested_timeout_ms: timeoutMs,
            maximum_timeout_ms: MAX_RUNTIME_EVENT_COLLECTION_MS,
          },
        },
      );
    }
    if (options.eventType !== undefined && options.eventType.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Home Assistant event type cannot be empty");
    }
    return this.client.collectEvents<T>({
      count,
      timeoutMs,
      ...(options.eventType === undefined ? {} : { eventType: options.eventType.trim() }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  getApiInfo(): Promise<HomeAssistantApiInfo> {
    return this.client.getInfo();
  }

  getConfig(): Promise<HomeAssistantConfig> {
    return this.client.getConfig();
  }

  getSystemHealth(): Promise<SystemHealth> {
    return this.client.getSystemHealth();
  }

  async getHomeAssistantInfo(): Promise<HomeAssistantRuntimeInfo> {
    const [api, config, systemHealth] = await Promise.all([
      this.getApiInfo(),
      this.getConfig(),
      this.getSystemHealth(),
    ]);
    return { api, config, system_health: systemHealth };
  }

  getInfo(): Promise<HomeAssistantRuntimeInfo> {
    return this.getHomeAssistantInfo();
  }
}

export function createRuntimeService(client: HomeAssistantClient): RuntimeService {
  return new RuntimeService(client);
}
