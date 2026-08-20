import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  PageInput,
  Pagination,
} from "../shared/types.js";
import { paginate } from "../shared/types.js";

export interface DiscoveryPage<T> {
  items: T[];
  pagination: Pagination;
}

export interface AreaReference {
  area_id: string;
  name: string;
}

export interface DeviceReference {
  device_id: string;
  name?: string;
}

export interface EntityReference {
  entity_id: string;
  name?: string;
}

export interface IntegrationReference {
  entry_id: string;
  domain: string;
  title: string;
}

export interface EnrichedArea extends AreaRegistryEntry {
  devices: DeviceReference[];
  entities: EntityReference[];
  integrations: IntegrationReference[];
  platforms: string[];
}

export interface EnrichedDevice extends DeviceRegistryEntry {
  area?: AreaReference;
  entities: EntityReference[];
  integrations: IntegrationReference[];
  platforms: string[];
}

export interface EnrichedEntity extends EntityRegistryEntry {
  domain: string;
  effective_area_id?: string;
  area_source?: "entity" | "device";
  area?: AreaReference;
  device?: DeviceReference;
  integrations: IntegrationReference[];
}

export interface EnrichedIntegration extends ConfigEntry {
  devices: DeviceReference[];
  entities: EntityReference[];
  areas: AreaReference[];
  platforms: string[];
}

export interface PlatformRelationship {
  platform: string;
  devices: DeviceReference[];
  entities: EntityReference[];
  areas: AreaReference[];
  integrations: IntegrationReference[];
}

export interface DiscoverySnapshot {
  areas: EnrichedArea[];
  devices: EnrichedDevice[];
  entities: EnrichedEntity[];
  integrations: EnrichedIntegration[];
  platforms: PlatformRelationship[];
}

export interface DiscoveryListOptions extends PageInput {
  query?: string;
  areaId?: string;
  deviceId?: string;
  integrationId?: string;
  platform?: string;
  domain?: string;
  includeDisabled?: boolean;
}

export type DiscoveryKind = "area" | "device" | "entity" | "integration" | "platform";

export interface DiscoverySearchOptions extends PageInput {
  kinds?: readonly DiscoveryKind[];
}

export interface DiscoverySearchResult {
  kind: DiscoveryKind;
  id: string;
  name: string;
  score: number;
  record:
    EnrichedArea | EnrichedDevice | EnrichedEntity | EnrichedIntegration | PlatformRelationship;
}

const KIND_ORDER: Record<DiscoveryKind, number> = {
  area: 0,
  device: 1,
  entity: 2,
  integration: 3,
  platform: 4,
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function deviceName(device: DeviceRegistryEntry): string | undefined {
  return device.name_by_user ?? device.name ?? undefined;
}

function entityName(entity: EntityRegistryEntry): string | undefined {
  return entity.name ?? entity.original_name ?? undefined;
}

function deviceReference(device: DeviceRegistryEntry): DeviceReference {
  const name = deviceName(device);
  return { device_id: device.id, ...(name === undefined ? {} : { name }) };
}

function entityReference(entity: EntityRegistryEntry): EntityReference {
  const name = entityName(entity);
  return { entity_id: entity.entity_id, ...(name === undefined ? {} : { name }) };
}

function areaReference(area: AreaRegistryEntry): AreaReference {
  return { area_id: area.area_id, name: area.name };
}

function integrationReference(integration: ConfigEntry): IntegrationReference {
  return {
    entry_id: integration.entry_id,
    domain: integration.domain,
    title: integration.title,
  };
}

function integrationIdsForDevice(device: DeviceRegistryEntry): string[] {
  return [
    ...new Set(
      [device.config_entry_id, ...(device.config_entries ?? [])].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort(compareText);
}

function searchable(values: readonly unknown[]): string {
  return values
    .flatMap((value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [],
    )
    .join(" ")
    .toLowerCase();
}

function matchesQuery(value: string, query: string | undefined): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const haystack = value.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}

function notDisabled(value: { disabled_by?: string | null }, includeDisabled: boolean): boolean {
  return includeDisabled || value.disabled_by == null;
}

/** Read-only registry discovery with compact, non-circular relationships. */
export class DiscoveryService {
  constructor(readonly client: HomeAssistantClient) {}

  async getSnapshot(): Promise<DiscoverySnapshot> {
    const [areaRegistry, deviceRegistry, entityRegistry, configEntries] = await Promise.all([
      this.client.getAreaRegistry(),
      this.client.getDeviceRegistry(),
      this.client.getEntityRegistry(),
      this.client.getConfigEntries(),
    ]);

    const areaById = new Map(areaRegistry.map((area) => [area.area_id, area]));
    const deviceById = new Map(deviceRegistry.map((device) => [device.id, device]));
    const integrationById = new Map(configEntries.map((entry) => [entry.entry_id, entry]));

    const enrichedEntities: EnrichedEntity[] = entityRegistry.map((entity) => {
      const device = entity.device_id ? deviceById.get(entity.device_id) : undefined;
      const effectiveAreaId = entity.area_id ?? device?.area_id ?? undefined;
      const area = effectiveAreaId ? areaById.get(effectiveAreaId) : undefined;
      const integrationIds = new Set<string>();
      if (entity.config_entry_id) integrationIds.add(entity.config_entry_id);
      if (device !== undefined) {
        for (const entryId of integrationIdsForDevice(device)) integrationIds.add(entryId);
      }
      const integrations = [...integrationIds]
        .flatMap((entryId): IntegrationReference[] => {
          const integration = integrationById.get(entryId);
          return integration === undefined ? [] : [integrationReference(integration)];
        })
        .sort((left, right) => compareText(left.entry_id, right.entry_id));
      return {
        ...entity,
        domain: entity.entity_id.split(".", 1)[0] ?? "",
        ...(effectiveAreaId === undefined ? {} : { effective_area_id: effectiveAreaId }),
        ...(entity.area_id
          ? { area_source: "entity" as const }
          : device?.area_id
            ? { area_source: "device" as const }
            : {}),
        ...(area === undefined ? {} : { area: areaReference(area) }),
        ...(device === undefined ? {} : { device: deviceReference(device) }),
        integrations,
      };
    });

    const entitiesByDevice = new Map<string, EnrichedEntity[]>();
    for (const entity of enrichedEntities) {
      if (!entity.device_id) continue;
      const entries = entitiesByDevice.get(entity.device_id) ?? [];
      entries.push(entity);
      entitiesByDevice.set(entity.device_id, entries);
    }

    const enrichedDevices: EnrichedDevice[] = deviceRegistry.map((device) => {
      const area = device.area_id ? areaById.get(device.area_id) : undefined;
      const entities = entitiesByDevice.get(device.id) ?? [];
      const integrations = integrationIdsForDevice(device)
        .flatMap((entryId): IntegrationReference[] => {
          const integration = integrationById.get(entryId);
          return integration === undefined ? [] : [integrationReference(integration)];
        })
        .sort((left, right) => compareText(left.entry_id, right.entry_id));
      const platforms = [...new Set(entities.flatMap((entity) => entity.platform ?? []))].sort(
        compareText,
      );
      return {
        ...device,
        ...(area === undefined ? {} : { area: areaReference(area) }),
        entities: entities
          .map(entityReference)
          .sort((left, right) => compareText(left.entity_id, right.entity_id)),
        integrations,
        platforms,
      };
    });

    const enrichedAreas: EnrichedArea[] = areaRegistry.map((area) => {
      const devices = enrichedDevices.filter((device) => device.area_id === area.area_id);
      const entities = enrichedEntities.filter(
        (entity) => entity.effective_area_id === area.area_id,
      );
      const integrationIds = new Set([
        ...devices.flatMap((device) => device.integrations.map(({ entry_id }) => entry_id)),
        ...entities.flatMap((entity) => entity.integrations.map(({ entry_id }) => entry_id)),
      ]);
      return {
        ...area,
        devices: devices
          .map(deviceReference)
          .sort((left, right) => compareText(left.device_id, right.device_id)),
        entities: entities
          .map(entityReference)
          .sort((left, right) => compareText(left.entity_id, right.entity_id)),
        integrations: [...integrationIds]
          .flatMap((entryId): IntegrationReference[] => {
            const integration = integrationById.get(entryId);
            return integration === undefined ? [] : [integrationReference(integration)];
          })
          .sort((left, right) => compareText(left.entry_id, right.entry_id)),
        platforms: [...new Set(entities.flatMap((entity) => entity.platform ?? []))].sort(
          compareText,
        ),
      };
    });

    const enrichedIntegrations: EnrichedIntegration[] = configEntries.map((integration) => {
      const devices = enrichedDevices.filter((device) =>
        device.integrations.some(({ entry_id }) => entry_id === integration.entry_id),
      );
      const entities = enrichedEntities.filter((entity) =>
        entity.integrations.some(({ entry_id }) => entry_id === integration.entry_id),
      );
      const relatedAreaIds = new Set([
        ...devices.flatMap((device) => device.area_id ?? []),
        ...entities.flatMap((entity) => entity.effective_area_id ?? []),
      ]);
      return {
        ...integration,
        devices: devices
          .map(deviceReference)
          .sort((left, right) => compareText(left.device_id, right.device_id)),
        entities: entities
          .map(entityReference)
          .sort((left, right) => compareText(left.entity_id, right.entity_id)),
        areas: [...relatedAreaIds]
          .flatMap((areaId): AreaReference[] => {
            const area = areaById.get(areaId);
            return area === undefined ? [] : [areaReference(area)];
          })
          .sort((left, right) => compareText(left.area_id, right.area_id)),
        platforms: [...new Set(entities.flatMap((entity) => entity.platform ?? []))].sort(
          compareText,
        ),
      };
    });

    const platformNames = [
      ...new Set(
        enrichedEntities
          .map((entity) => entity.platform)
          .filter(
            (platform): platform is string => typeof platform === "string" && platform !== "",
          ),
      ),
    ].sort(compareText);
    const platforms: PlatformRelationship[] = platformNames.map((platform) => {
      const entities = enrichedEntities.filter((entity) => entity.platform === platform);
      const deviceIds = new Set(
        entities
          .map((entity) => entity.device_id)
          .filter((id): id is string => typeof id === "string"),
      );
      const areaIds = new Set(
        entities
          .map((entity) => entity.effective_area_id)
          .filter((id): id is string => typeof id === "string"),
      );
      const integrationIds = new Set(
        entities.flatMap((entity) => entity.integrations.map(({ entry_id }) => entry_id)),
      );
      return {
        platform,
        devices: [...deviceIds]
          .flatMap((deviceId): DeviceReference[] => {
            const device = deviceById.get(deviceId);
            return device === undefined ? [] : [deviceReference(device)];
          })
          .sort((left, right) => compareText(left.device_id, right.device_id)),
        entities: entities
          .map(entityReference)
          .sort((left, right) => compareText(left.entity_id, right.entity_id)),
        areas: [...areaIds]
          .flatMap((areaId): AreaReference[] => {
            const area = areaById.get(areaId);
            return area === undefined ? [] : [areaReference(area)];
          })
          .sort((left, right) => compareText(left.area_id, right.area_id)),
        integrations: [...integrationIds]
          .flatMap((entryId): IntegrationReference[] => {
            const integration = integrationById.get(entryId);
            return integration === undefined ? [] : [integrationReference(integration)];
          })
          .sort((left, right) => compareText(left.entry_id, right.entry_id)),
      };
    });

    return {
      areas: enrichedAreas.sort((left, right) => compareText(left.area_id, right.area_id)),
      devices: enrichedDevices.sort((left, right) => compareText(left.id, right.id)),
      entities: enrichedEntities.sort((left, right) =>
        compareText(left.entity_id, right.entity_id),
      ),
      integrations: enrichedIntegrations.sort((left, right) =>
        compareText(left.entry_id, right.entry_id),
      ),
      platforms,
    };
  }

  async listAreas(options: DiscoveryListOptions = {}): Promise<DiscoveryPage<EnrichedArea>> {
    const { areas } = await this.getSnapshot();
    return paginate(
      areas.filter(
        (area) =>
          (options.areaId === undefined || area.area_id === options.areaId) &&
          (options.integrationId === undefined ||
            area.integrations.some(({ entry_id }) => entry_id === options.integrationId)) &&
          (options.platform === undefined || area.platforms.includes(options.platform)) &&
          matchesQuery(
            searchable([area.area_id, area.name, area.aliases ?? [], area.labels ?? []]),
            options.query,
          ),
      ),
      options,
    );
  }

  async getArea(areaId: string): Promise<EnrichedArea> {
    const area = (await this.getSnapshot()).areas.find((item) => item.area_id === areaId);
    if (area === undefined) throw notFound("area", areaId);
    return area;
  }

  async listDevices(options: DiscoveryListOptions = {}): Promise<DiscoveryPage<EnrichedDevice>> {
    const { devices } = await this.getSnapshot();
    return paginate(
      devices.filter(
        (device) =>
          notDisabled(device, options.includeDisabled ?? true) &&
          (options.deviceId === undefined || device.id === options.deviceId) &&
          (options.areaId === undefined || device.area_id === options.areaId) &&
          (options.integrationId === undefined ||
            device.integrations.some(({ entry_id }) => entry_id === options.integrationId)) &&
          (options.platform === undefined || device.platforms.includes(options.platform)) &&
          matchesQuery(
            searchable([
              device.id,
              device.name,
              device.name_by_user,
              device.manufacturer,
              device.model,
              device.labels ?? [],
              device.area?.name,
            ]),
            options.query,
          ),
      ),
      options,
    );
  }

  async getDevice(deviceId: string): Promise<EnrichedDevice> {
    const device = (await this.getSnapshot()).devices.find((item) => item.id === deviceId);
    if (device === undefined) throw notFound("device", deviceId);
    return device;
  }

  async listEntities(options: DiscoveryListOptions = {}): Promise<DiscoveryPage<EnrichedEntity>> {
    const { entities } = await this.getSnapshot();
    return paginate(
      entities.filter(
        (entity) =>
          notDisabled(entity, options.includeDisabled ?? true) &&
          (options.areaId === undefined || entity.effective_area_id === options.areaId) &&
          (options.deviceId === undefined || entity.device_id === options.deviceId) &&
          (options.integrationId === undefined ||
            entity.integrations.some(({ entry_id }) => entry_id === options.integrationId)) &&
          (options.platform === undefined || entity.platform === options.platform) &&
          (options.domain === undefined || entity.domain === options.domain) &&
          matchesQuery(
            searchable([
              entity.entity_id,
              entity.name,
              entity.original_name,
              entity.platform,
              entity.labels ?? [],
              entity.area?.name,
              entity.device?.name,
              entity.integrations.map(({ domain, title }) => `${domain} ${title}`),
            ]),
            options.query,
          ),
      ),
      options,
    );
  }

  async getEntity(entityId: string): Promise<EnrichedEntity> {
    const normalized = entityId.toLowerCase();
    const entity = (await this.getSnapshot()).entities.find(
      (item) => item.entity_id.toLowerCase() === normalized,
    );
    if (entity === undefined) throw notFound("entity", entityId);
    return entity;
  }

  async listIntegrations(
    options: DiscoveryListOptions = {},
  ): Promise<DiscoveryPage<EnrichedIntegration>> {
    const { integrations } = await this.getSnapshot();
    return paginate(
      integrations.filter(
        (integration) =>
          notDisabled(integration, options.includeDisabled ?? true) &&
          (options.integrationId === undefined || integration.entry_id === options.integrationId) &&
          (options.domain === undefined || integration.domain === options.domain) &&
          (options.areaId === undefined ||
            integration.areas.some(({ area_id }) => area_id === options.areaId)) &&
          (options.deviceId === undefined ||
            integration.devices.some(({ device_id }) => device_id === options.deviceId)) &&
          (options.platform === undefined || integration.platforms.includes(options.platform)) &&
          matchesQuery(
            searchable([
              integration.entry_id,
              integration.domain,
              integration.title,
              integration.state,
              integration.source,
            ]),
            options.query,
          ),
      ),
      options,
    );
  }

  async getIntegration(entryId: string): Promise<EnrichedIntegration> {
    const integration = (await this.getSnapshot()).integrations.find(
      (item) => item.entry_id === entryId,
    );
    if (integration === undefined) throw notFound("integration", entryId);
    return integration;
  }

  async listPlatforms(
    options: DiscoveryListOptions = {},
  ): Promise<DiscoveryPage<PlatformRelationship>> {
    const { platforms } = await this.getSnapshot();
    return paginate(
      platforms.filter(
        (platform) =>
          (options.platform === undefined || platform.platform === options.platform) &&
          (options.areaId === undefined ||
            platform.areas.some(({ area_id }) => area_id === options.areaId)) &&
          (options.deviceId === undefined ||
            platform.devices.some(({ device_id }) => device_id === options.deviceId)) &&
          (options.integrationId === undefined ||
            platform.integrations.some(({ entry_id }) => entry_id === options.integrationId)) &&
          matchesQuery(
            searchable([
              platform.platform,
              platform.entities.map(({ entity_id }) => entity_id),
              platform.integrations.map(({ domain, title }) => `${domain} ${title}`),
            ]),
            options.query,
          ),
      ),
      options,
    );
  }

  async getPlatform(platformName: string): Promise<PlatformRelationship> {
    const normalized = platformName.toLowerCase();
    const platform = (await this.getSnapshot()).platforms.find(
      (item) => item.platform.toLowerCase() === normalized,
    );
    if (platform === undefined) throw notFound("platform", platformName);
    return platform;
  }

  async search(
    query: string,
    options: DiscoverySearchOptions = {},
  ): Promise<DiscoveryPage<DiscoverySearchResult>> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Discovery search query cannot be empty");
    }
    const selectedKinds = options.kinds === undefined ? undefined : new Set(options.kinds);
    const snapshot = await this.getSnapshot();
    const candidates: Array<{
      kind: DiscoveryKind;
      id: string;
      name: string;
      text: string;
      record: DiscoverySearchResult["record"];
    }> = [
      ...snapshot.areas.map((record) => ({
        kind: "area" as const,
        id: record.area_id,
        name: record.name,
        text: searchable([record.area_id, record.name, record.aliases ?? []]),
        record,
      })),
      ...snapshot.devices.map((record) => ({
        kind: "device" as const,
        id: record.id,
        name: deviceName(record) ?? record.id,
        text: searchable([
          record.id,
          record.name,
          record.name_by_user,
          record.manufacturer,
          record.model,
        ]),
        record,
      })),
      ...snapshot.entities.map((record) => ({
        kind: "entity" as const,
        id: record.entity_id,
        name: entityName(record) ?? record.entity_id,
        text: searchable([record.entity_id, record.name, record.original_name, record.platform]),
        record,
      })),
      ...snapshot.integrations.map((record) => ({
        kind: "integration" as const,
        id: record.entry_id,
        name: record.title,
        text: searchable([record.entry_id, record.domain, record.title]),
        record,
      })),
      ...snapshot.platforms.map((record) => ({
        kind: "platform" as const,
        id: record.platform,
        name: record.platform,
        text: searchable([record.platform]),
        record,
      })),
    ];
    const tokens = normalized.split(/\s+/);
    const results = candidates
      .filter(
        (candidate) =>
          (selectedKinds === undefined || selectedKinds.has(candidate.kind)) &&
          tokens.every((token) => candidate.text.includes(token)),
      )
      .map((candidate): DiscoverySearchResult => {
        const id = candidate.id.toLowerCase();
        const name = candidate.name.toLowerCase();
        const score =
          id === normalized
            ? 100
            : name === normalized
              ? 90
              : id.startsWith(normalized)
                ? 80
                : name.startsWith(normalized)
                  ? 70
                  : 50;
        return { ...candidate, score };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
          compareText(left.id, right.id),
      );
    return paginate(results, options);
  }
}

export function createDiscoveryService(client: HomeAssistantClient): DiscoveryService {
  return new DiscoveryService(client);
}

function notFound(kind: DiscoveryKind, id: string): AppError {
  return new AppError("HA_NOT_FOUND", `Home Assistant ${kind} was not found`, {
    details: { kind, id },
  });
}
