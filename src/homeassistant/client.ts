import type { Settings } from "../config/settings.js";
import { AppError } from "../shared/errors.js";
import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
} from "../shared/types.js";
import { TtlCache } from "./cache.js";
import {
  HomeAssistantRestClient,
  type RestClientOptions,
  type RestRequestOptions,
} from "./rest.js";
import {
  HomeAssistantWebSocketClient,
  type CollectEventsOptions,
  type EventHandler,
  type HomeAssistantEvent,
  type WebSocketCommand,
  type WebSocketCommandOptions,
} from "./websocket.js";

export interface HomeAssistantClientOptions {
  url: string;
  token: string;
  requestTimeoutMs?: number;
  websocketTimeoutMs?: number;
  verifyTls?: boolean;
  registryTtlMs?: number;
  servicesTtlMs?: number;
}

export interface HomeAssistantClientDependencies {
  rest?: HomeAssistantRestClient;
  websocket?: HomeAssistantWebSocketClient;
}

export interface HomeAssistantApiInfo {
  message: string;
  [key: string]: unknown;
}

export interface HomeAssistantConfig {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  unit_system?: Record<string, unknown>;
  location_name?: string;
  time_zone?: string;
  version?: string;
  state?: string;
  external_url?: string | null;
  internal_url?: string | null;
  [key: string]: unknown;
}

export interface HomeAssistantServiceDefinition {
  name?: string;
  description?: string;
  fields?: Record<string, unknown>;
  target?: Record<string, unknown>;
  response?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HomeAssistantServiceDomain {
  domain: string;
  services: Record<string, HomeAssistantServiceDefinition>;
}

export interface HomeAssistantEventType {
  event: string;
  listener_count: number;
}

export interface ServiceCallExtendedResponse<T = unknown> {
  changed_states: EntityState[];
  service_response: T;
}

export type ServiceCallResponse<T = unknown> = EntityState[] | ServiceCallExtendedResponse<T>;

export interface ServiceCallOptions {
  returnResponse?: boolean;
}

export interface FireEventResponse {
  message: string;
  [key: string]: unknown;
}

export interface ConfigCheckResult {
  result: string;
  errors: string | null;
  [key: string]: unknown;
}

export interface SystemLogEntry {
  name: string;
  message: string[];
  level: string;
  source?: [string, number];
  timestamp: number;
  first_occurred?: number;
  exception?: string;
  count?: number;
}

export interface SystemHealth {
  complete: boolean;
  domains: Record<string, unknown>;
  raw_events: unknown[];
}
export type CacheScope = "all" | "services" | "registries" | "config_entries";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WEBSOCKET_TIMEOUT_MS = 30_000;
const DEFAULT_REGISTRY_TTL_MS = 30_000;
const DEFAULT_SERVICES_TTL_MS = 30_000;

/** High-level access to Home Assistant's public REST API and administrative WS API. */
export class HomeAssistantClient {
  readonly rest: HomeAssistantRestClient;
  readonly websocket: HomeAssistantWebSocketClient;

  private readonly cache: TtlCache<string, unknown>;
  private readonly registryTtlMs: number;
  private readonly servicesTtlMs: number;

  constructor(
    settings: Settings | HomeAssistantClientOptions,
    dependencies: HomeAssistantClientDependencies = {},
  ) {
    const options = normalizeOptions(settings);
    this.registryTtlMs = options.registryTtlMs;
    this.servicesTtlMs = options.servicesTtlMs;
    this.cache = new TtlCache({ defaultTtlMs: this.registryTtlMs });

    const restOptions: RestClientOptions = {
      baseUrl: options.url,
      token: options.token,
      timeoutMs: options.requestTimeoutMs,
      verifyTls: options.verifyTls,
    };
    this.rest = dependencies.rest ?? new HomeAssistantRestClient(restOptions);
    this.websocket =
      dependencies.websocket ??
      new HomeAssistantWebSocketClient({
        baseUrl: options.url,
        token: options.token,
        timeoutMs: options.websocketTimeoutMs,
        verifyTls: options.verifyTls,
      });
  }

  get connected(): boolean {
    return this.websocket.connected;
  }

  connect(): Promise<void> {
    return this.websocket.connect();
  }

  getInfo(): Promise<HomeAssistantApiInfo> {
    return this.rest.request<HomeAssistantApiInfo>("/api/", { responseType: "json" });
  }

  getApiInfo(): Promise<HomeAssistantApiInfo> {
    return this.getInfo();
  }

  getConfig(): Promise<HomeAssistantConfig> {
    return this.rest.request<HomeAssistantConfig>("/api/config", { responseType: "json" });
  }

  getStates(): Promise<EntityState[]> {
    return this.rest.request<EntityState[]>("/api/states", { responseType: "json" });
  }

  getState(entityId: string): Promise<EntityState> {
    return this.rest.request<EntityState>(`/api/states/${pathSegment(entityId, "entity ID")}`, {
      responseType: "json",
    });
  }

  getServices(): Promise<HomeAssistantServiceDomain[]> {
    return this.cached("services", this.servicesTtlMs, () =>
      this.rest.request<HomeAssistantServiceDomain[]>("/api/services", { responseType: "json" }),
    );
  }

  getEventTypes(): Promise<HomeAssistantEventType[]> {
    return this.rest.request<HomeAssistantEventType[]>("/api/events", { responseType: "json" });
  }

  callService<T = unknown>(
    domain: string,
    service: string,
    data: Record<string, unknown> = {},
    options: ServiceCallOptions = {},
  ): Promise<ServiceCallResponse<T>> {
    const query = options.returnResponse === true ? "?return_response" : "";
    return this.rest.request<ServiceCallResponse<T>>(
      `/api/services/${pathSegment(domain, "service domain")}/${pathSegment(service, "service name")}${query}`,
      { method: "POST", body: data, responseType: "json" },
    );
  }

  fireEvent(
    eventType: string,
    eventData: Record<string, unknown> = {},
  ): Promise<FireEventResponse> {
    return this.rest.request<FireEventResponse>(
      `/api/events/${pathSegment(eventType, "event type")}`,
      { method: "POST", body: eventData, responseType: "json" },
    );
  }

  restRequest<T = unknown>(path: string, options: RestRequestOptions = {}): Promise<T> {
    return this.rest.request<T>(path, options);
  }

  wsCommand<T = unknown>(
    command: WebSocketCommand,
    options: WebSocketCommandOptions = {},
  ): Promise<T> {
    return this.websocket.command<T>(command, options);
  }

  getEntityRegistry(): Promise<EntityRegistryEntry[]> {
    return this.cached("registry:entities", this.registryTtlMs, () =>
      this.wsCommand<EntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
    );
  }

  getDeviceRegistry(): Promise<DeviceRegistryEntry[]> {
    return this.cached("registry:devices", this.registryTtlMs, () =>
      this.wsCommand<DeviceRegistryEntry[]>({ type: "config/device_registry/list" }),
    );
  }

  getAreaRegistry(): Promise<AreaRegistryEntry[]> {
    return this.cached("registry:areas", this.registryTtlMs, () =>
      this.wsCommand<AreaRegistryEntry[]>({ type: "config/area_registry/list" }),
    );
  }

  getConfigEntries(domain?: string): Promise<ConfigEntry[]> {
    const command: WebSocketCommand = { type: "config_entries/get" };
    if (domain !== undefined) command.domain = domain;
    return this.cached(`config_entries:${domain ?? "*"}`, this.registryTtlMs, () =>
      this.wsCommand<ConfigEntry[]>(command),
    );
  }

  async getSystemHealth(): Promise<SystemHealth> {
    const events = await this.websocket.collectSubscription<Record<string, unknown>>(
      { type: "system_health/info" },
      {
        maxEvents: 1_000,
        timeoutMs: 30_000,
        until: (event) => event.type === "finish",
      },
    );
    const initial = events.find((event) => event.type === "initial");
    const domains = initial !== undefined && isRecord(initial.data) ? initial.data : {};
    return {
      complete: events.some((event) => event.type === "finish"),
      domains,
      raw_events: events,
    };
  }

  collectSystemHealth(): Promise<SystemHealth> {
    return this.getSystemHealth();
  }

  checkConfig(): Promise<ConfigCheckResult> {
    return this.rest.request<ConfigCheckResult>("/api/config/core/check_config", {
      method: "POST",
      responseType: "json",
    });
  }

  getLogs(): Promise<string> {
    return this.rest.request<string>("/api/error_log", { responseType: "text" });
  }

  getErrorLog(): Promise<string> {
    return this.getLogs();
  }

  getSystemLog(): Promise<SystemLogEntry[]> {
    return this.wsCommand<SystemLogEntry[]>({ type: "system_log/list" });
  }

  subscribeEvents<T = Record<string, unknown>>(
    eventType: string | undefined,
    handler: EventHandler<T>,
  ): Promise<() => Promise<void>> {
    return this.websocket.subscribeEvents(eventType, handler);
  }

  collectEvents<T = Record<string, unknown>>(
    options: CollectEventsOptions = {},
  ): Promise<Array<HomeAssistantEvent<T>>> {
    return this.websocket.collectEvents<T>(options);
  }

  invalidateCache(scope: CacheScope = "all"): number {
    if (scope === "all") return this.cache.invalidate();
    if (scope === "services") return this.cache.invalidate((key) => key === "services");
    if (scope === "config_entries") {
      return this.cache.invalidate((key) => key.startsWith("config_entries:"));
    }
    return this.cache.invalidate((key) => key.startsWith("registry:"));
  }

  async close(): Promise<void> {
    try {
      await this.websocket.close();
    } finally {
      this.rest.close();
      this.cache.clear();
    }
  }

  private async cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    return (await this.cache.getOrLoad(key, loader, ttlMs)) as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NormalizedOptions {
  url: string;
  token: string;
  requestTimeoutMs: number;
  websocketTimeoutMs: number;
  verifyTls: boolean;
  registryTtlMs: number;
  servicesTtlMs: number;
}

function normalizeOptions(settings: Settings | HomeAssistantClientOptions): NormalizedOptions {
  if ("homeAssistant" in settings) {
    return {
      url: settings.homeAssistant.url,
      token: settings.homeAssistant.token,
      requestTimeoutMs: settings.homeAssistant.requestTimeoutMs,
      websocketTimeoutMs: settings.homeAssistant.websocketTimeoutMs,
      verifyTls: settings.homeAssistant.verifyTls,
      registryTtlMs: settings.cache.registryTtlMs,
      servicesTtlMs: settings.cache.servicesTtlMs,
    };
  }
  return {
    url: settings.url,
    token: settings.token,
    requestTimeoutMs: settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    websocketTimeoutMs: settings.websocketTimeoutMs ?? DEFAULT_WEBSOCKET_TIMEOUT_MS,
    verifyTls: settings.verifyTls ?? true,
    registryTtlMs: settings.registryTtlMs ?? DEFAULT_REGISTRY_TTL_MS,
    servicesTtlMs: settings.servicesTtlMs ?? DEFAULT_SERVICES_TTL_MS,
  };
}

function pathSegment(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new AppError("HA_INVALID_REQUEST", `Home Assistant ${label} cannot be empty`);
  }
  return encodeURIComponent(value);
}
