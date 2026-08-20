import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
} from "../shared/types.js";

export interface EntityDetails extends EntityRegistryEntry {
  state: EntityState | null;
  device: DeviceRegistryEntry | null;
  area: AreaRegistryEntry | null;
  area_assignment: "entity" | "device" | null;
  config_entry: ConfigEntry | null;
  config_entries: ConfigEntry[];
}

export interface DeviceDetails extends DeviceRegistryEntry {
  area: AreaRegistryEntry | null;
  entities: EntityRegistryEntry[];
  config_entry_records: ConfigEntry[];
}

export interface AreaDetails extends AreaRegistryEntry {
  devices: DeviceRegistryEntry[];
  entities: EntityRegistryEntry[];
  directly_assigned_entities: EntityRegistryEntry[];
  device_assigned_entities: EntityRegistryEntry[];
}

export interface EntityUpdate {
  name?: string | null;
  icon?: string | null;
  area_id?: string | null;
  disabled_by?: "user" | null;
  hidden_by?: "user" | null;
  labels?: string[];
  categories?: Record<string, string>;
}

export interface EntityRegistryUpdateResult {
  entity_entry: EntityRegistryEntry;
  reload_delay: number | null;
  require_restart: boolean;
}

export interface DeviceUpdate {
  name_by_user?: string | null;
  area_id?: string | null;
  disabled_by?: "user" | null;
  labels?: string[];
}

export interface AreaCreate {
  name: string;
  aliases?: string[];
  floor_id?: string | null;
  icon?: string | null;
  labels?: string[];
  picture?: string | null;
}

export type AreaUpdate = Partial<AreaCreate>;

const ENTITY_UPDATE_FIELDS = new Set([
  "name",
  "icon",
  "area_id",
  "disabled_by",
  "hidden_by",
  "labels",
  "categories",
]);
const DEVICE_UPDATE_FIELDS = new Set(["name_by_user", "area_id", "disabled_by", "labels"]);
const AREA_FIELDS = new Set(["name", "aliases", "floor_id", "icon", "labels", "picture"]);
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** Administrative access to Home Assistant's entity, device, and area registries. */
export class RegistryAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  async listEntities(): Promise<EntityDetails[]> {
    const [entities, devices, areas, configEntries, states] = await Promise.all([
      this.internal("config/entity_registry/list", () => this.client.getEntityRegistry()),
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/area_registry/list", () => this.client.getAreaRegistry()),
      this.internal("config_entries/get", () => this.client.getConfigEntries()),
      this.client.getStates(),
    ]);
    return enrichEntities(entities, devices, areas, configEntries, states);
  }

  async getEntity(entityId: string): Promise<EntityDetails> {
    assertEntityId(entityId);
    const [entity, devices, areas, configEntries, states] = await Promise.all([
      this.internal("config/entity_registry/get", () =>
        this.client.wsCommand<EntityRegistryEntry>({
          type: "config/entity_registry/get",
          entity_id: entityId,
        }),
      ),
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/area_registry/list", () => this.client.getAreaRegistry()),
      this.internal("config_entries/get", () => this.client.getConfigEntries()),
      this.client.getStates(),
    ]);
    return enrichEntities([entity], devices, areas, configEntries, states)[0]!;
  }

  async updateEntity(entityId: string, changes: EntityUpdate): Promise<EntityRegistryUpdateResult> {
    assertEntityId(entityId);
    assertAllowedUpdate(changes, ENTITY_UPDATE_FIELDS, "entity");
    if (Object.hasOwn(changes, "area_id") && changes.area_id !== null) {
      await this.requireArea(changes.area_id!);
    }
    const response = await this.internal("config/entity_registry/update", () =>
      this.client.wsCommand<unknown>({
        type: "config/entity_registry/update",
        entity_id: entityId,
        ...changes,
      }),
    );
    this.client.invalidateCache("registries");
    return entityUpdateFromResponse(response);
  }

  async renameEntity(entityId: string, newEntityId: string): Promise<EntityRegistryUpdateResult> {
    assertEntityId(entityId);
    assertEntityId(newEntityId);
    if (entityId.split(".", 1)[0] !== newEntityId.split(".", 1)[0]) {
      throw new AppError(
        "ENTITY_DOMAIN_CHANGE_UNSUPPORTED",
        "An entity can be renamed only within its existing domain",
        { details: { entity_id: entityId, new_entity_id: newEntityId } },
      );
    }

    const [entities, states] = await Promise.all([
      this.internal("config/entity_registry/list", () =>
        this.client.wsCommand<EntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
      ),
      this.client.getStates(),
    ]);
    const current = entities.find((entry) => sameText(entry.entity_id, entityId));
    if (current === undefined) throw notFound("entity", entityId);
    if (sameText(entityId, newEntityId)) {
      return { entity_entry: current, reload_delay: null, require_restart: false };
    }
    if (
      entities.some((entry) => sameText(entry.entity_id, newEntityId)) ||
      states.some((state) => sameText(state.entity_id, newEntityId))
    ) {
      throw new AppError("ENTITY_ID_CONFLICT", `Entity ${newEntityId} already exists`, {
        details: { entity_id: entityId, new_entity_id: newEntityId },
      });
    }

    const response = await this.internal("config/entity_registry/update", () =>
      this.client.wsCommand<unknown>({
        type: "config/entity_registry/update",
        entity_id: entityId,
        new_entity_id: newEntityId,
      }),
    );
    this.client.invalidateCache("registries");
    return entityUpdateFromResponse(response);
  }

  moveEntity(entityId: string, areaId: string | null): Promise<EntityRegistryUpdateResult> {
    return this.updateEntity(entityId, { area_id: areaId });
  }

  assignEntityToArea(entityId: string, areaId: string): Promise<EntityRegistryUpdateResult> {
    return this.moveEntity(entityId, areaId);
  }

  unassignEntityFromArea(entityId: string): Promise<EntityRegistryUpdateResult> {
    return this.moveEntity(entityId, null);
  }

  disableEntity(entityId: string): Promise<EntityRegistryUpdateResult> {
    return this.updateEntity(entityId, { disabled_by: "user" });
  }

  enableEntity(entityId: string): Promise<EntityRegistryUpdateResult> {
    return this.updateEntity(entityId, { disabled_by: null });
  }

  async listDevices(): Promise<DeviceDetails[]> {
    const [devices, entities, areas, configEntries] = await Promise.all([
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/entity_registry/list", () => this.client.getEntityRegistry()),
      this.internal("config/area_registry/list", () => this.client.getAreaRegistry()),
      this.internal("config_entries/get", () => this.client.getConfigEntries()),
    ]);
    return enrichDevices(devices, entities, areas, configEntries);
  }

  async getDevice(deviceId: string): Promise<DeviceDetails> {
    assertIdentifier(deviceId, "device ID");
    const devices = await this.listDevices();
    const device = devices.find((entry) => entry.id === deviceId);
    if (device === undefined) throw notFound("device", deviceId);
    return device;
  }

  async updateDevice(deviceId: string, changes: DeviceUpdate): Promise<DeviceRegistryEntry> {
    assertIdentifier(deviceId, "device ID");
    assertAllowedUpdate(changes, DEVICE_UPDATE_FIELDS, "device");
    if (Object.hasOwn(changes, "area_id") && changes.area_id !== null) {
      await this.requireArea(changes.area_id!);
    }
    const result = await this.internal("config/device_registry/update", () =>
      this.client.wsCommand<DeviceRegistryEntry>({
        type: "config/device_registry/update",
        device_id: deviceId,
        ...changes,
      }),
    );
    this.client.invalidateCache("registries");
    return result;
  }

  renameDevice(deviceId: string, name: string | null): Promise<DeviceRegistryEntry> {
    if (name !== null && name.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Device name cannot be empty");
    }
    return this.updateDevice(deviceId, { name_by_user: name });
  }

  moveDevice(deviceId: string, areaId: string | null): Promise<DeviceRegistryEntry> {
    return this.updateDevice(deviceId, { area_id: areaId });
  }

  assignDeviceToArea(deviceId: string, areaId: string): Promise<DeviceRegistryEntry> {
    return this.moveDevice(deviceId, areaId);
  }

  unassignDeviceFromArea(deviceId: string): Promise<DeviceRegistryEntry> {
    return this.moveDevice(deviceId, null);
  }

  disableDevice(deviceId: string): Promise<DeviceRegistryEntry> {
    return this.updateDevice(deviceId, { disabled_by: "user" });
  }

  enableDevice(deviceId: string): Promise<DeviceRegistryEntry> {
    return this.updateDevice(deviceId, { disabled_by: null });
  }

  async listAreas(): Promise<AreaDetails[]> {
    const [areas, devices, entities] = await Promise.all([
      this.internal("config/area_registry/list", () => this.client.getAreaRegistry()),
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/entity_registry/list", () => this.client.getEntityRegistry()),
    ]);
    return enrichAreas(areas, devices, entities);
  }

  async getArea(areaId: string): Promise<AreaDetails> {
    assertIdentifier(areaId, "area ID");
    const areas = await this.listAreas();
    const area = areas.find((entry) => entry.area_id === areaId);
    if (area === undefined) throw notFound("area", areaId);
    return area;
  }

  async createArea(input: AreaCreate): Promise<AreaRegistryEntry> {
    assertAllowedFields(input, AREA_FIELDS, "area");
    assertName(input.name, "Area name");
    const result = await this.internal("config/area_registry/create", () =>
      this.client.wsCommand<AreaRegistryEntry>({
        type: "config/area_registry/create",
        ...input,
      }),
    );
    this.client.invalidateCache("registries");
    return result;
  }

  async updateArea(areaId: string, changes: AreaUpdate): Promise<AreaRegistryEntry> {
    assertIdentifier(areaId, "area ID");
    assertAllowedUpdate(changes, AREA_FIELDS, "area");
    if (changes.name !== undefined) assertName(changes.name, "Area name");
    const result = await this.internal("config/area_registry/update", () =>
      this.client.wsCommand<AreaRegistryEntry>({
        type: "config/area_registry/update",
        area_id: areaId,
        ...changes,
      }),
    );
    this.client.invalidateCache("registries");
    return result;
  }

  async deleteArea(areaId: string): Promise<unknown> {
    assertIdentifier(areaId, "area ID");
    const result = await this.internal("config/area_registry/delete", () =>
      this.client.wsCommand<unknown>({
        type: "config/area_registry/delete",
        area_id: areaId,
      }),
    );
    this.client.invalidateCache("registries");
    return result;
  }

  private async requireArea(areaId: string): Promise<void> {
    assertIdentifier(areaId, "area ID");
    const areas = await this.internal("config/area_registry/list", () =>
      this.client.getAreaRegistry(),
    );
    if (!areas.some((area) => area.area_id === areaId)) throw notFound("area", areaId);
  }

  private async internal<T>(commandType: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof AppError && error.code === "HA_WS_UNSUPPORTED") {
        throw new AppError(
          "HA_INTERNAL_API_UNAVAILABLE",
          `Home Assistant does not support the ${commandType} registry operation in this version`,
          {
            details: { command_type: commandType },
            cause: error,
          },
        );
      }
      throw error;
    }
  }
}

function entityUpdateFromResponse(response: unknown): EntityRegistryUpdateResult {
  const record =
    response !== null && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  const candidate =
    record?.entity_entry !== null &&
    typeof record?.entity_entry === "object" &&
    !Array.isArray(record.entity_entry)
      ? (record.entity_entry as Record<string, unknown>)
      : record;
  if (candidate === null || typeof candidate.entity_id !== "string") {
    throw new AppError(
      "HA_INVALID_RESPONSE",
      "Home Assistant returned an invalid entity-registry update response",
    );
  }
  return {
    entity_entry: candidate as unknown as EntityRegistryEntry,
    reload_delay: typeof record?.reload_delay === "number" ? record.reload_delay : null,
    require_restart: record?.require_restart === true,
  };
}

export function createRegistryAdministration(client: HomeAssistantClient): RegistryAdministration {
  return new RegistryAdministration(client);
}

function enrichEntities(
  entities: readonly EntityRegistryEntry[],
  devices: readonly DeviceRegistryEntry[],
  areas: readonly AreaRegistryEntry[],
  configEntries: readonly ConfigEntry[],
  states: readonly EntityState[],
): EntityDetails[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const areaById = new Map(areas.map((area) => [area.area_id, area]));
  const configEntryById = new Map(configEntries.map((entry) => [entry.entry_id, entry]));
  const stateById = new Map(states.map((state) => [state.entity_id.toLowerCase(), state]));
  return [...entities]
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id))
    .map((entity) => {
      const device = entity.device_id ? (deviceById.get(entity.device_id) ?? null) : null;
      const areaId = entity.area_id ?? device?.area_id ?? null;
      const configEntryIds = new Set(device?.config_entries ?? []);
      if (device?.config_entry_id) configEntryIds.add(device.config_entry_id);
      if (entity.config_entry_id) configEntryIds.add(entity.config_entry_id);
      return {
        ...entity,
        state: stateById.get(entity.entity_id.toLowerCase()) ?? null,
        device,
        area: areaId ? (areaById.get(areaId) ?? null) : null,
        area_assignment: entity.area_id ? "entity" : device?.area_id ? "device" : null,
        config_entry: entity.config_entry_id
          ? (configEntryById.get(entity.config_entry_id) ?? null)
          : null,
        config_entries: [...configEntryIds]
          .flatMap((entryId) => {
            const entry = configEntryById.get(entryId);
            return entry === undefined ? [] : [entry];
          })
          .sort((left, right) => left.entry_id.localeCompare(right.entry_id)),
      };
    });
}

function enrichDevices(
  devices: readonly DeviceRegistryEntry[],
  entities: readonly EntityRegistryEntry[],
  areas: readonly AreaRegistryEntry[],
  configEntries: readonly ConfigEntry[],
): DeviceDetails[] {
  const areaById = new Map(areas.map((area) => [area.area_id, area]));
  const configEntryById = new Map(configEntries.map((entry) => [entry.entry_id, entry]));
  return [...devices]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((device) => {
      const entryIds = new Set(device.config_entries ?? []);
      if (device.config_entry_id) entryIds.add(device.config_entry_id);
      return {
        ...device,
        area: device.area_id ? (areaById.get(device.area_id) ?? null) : null,
        entities: entities
          .filter((entity) => entity.device_id === device.id)
          .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
        config_entry_records: [...entryIds]
          .flatMap((entryId) => {
            const entry = configEntryById.get(entryId);
            return entry === undefined ? [] : [entry];
          })
          .sort((left, right) => left.entry_id.localeCompare(right.entry_id)),
      };
    });
}

function enrichAreas(
  areas: readonly AreaRegistryEntry[],
  devices: readonly DeviceRegistryEntry[],
  entities: readonly EntityRegistryEntry[],
): AreaDetails[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  return [...areas]
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.area_id.localeCompare(right.area_id),
    )
    .map((area) => {
      const areaDevices = devices
        .filter((device) => device.area_id === area.area_id)
        .sort((left, right) => left.id.localeCompare(right.id));
      const direct = entities
        .filter((entity) => entity.area_id === area.area_id)
        .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
      const inherited = entities
        .filter(
          (entity) =>
            !entity.area_id &&
            entity.device_id !== null &&
            entity.device_id !== undefined &&
            deviceById.get(entity.device_id)?.area_id === area.area_id,
        )
        .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
      return {
        ...area,
        devices: areaDevices,
        entities: [...direct, ...inherited].sort((left, right) =>
          left.entity_id.localeCompare(right.entity_id),
        ),
        directly_assigned_entities: direct,
        device_assigned_entities: inherited,
      };
    });
}

function assertEntityId(value: string): void {
  if (typeof value !== "string" || !ENTITY_ID.test(value)) {
    throw new AppError(
      "HA_INVALID_REQUEST",
      "Entity ID must contain a lowercase domain and object ID separated by a period",
      { details: { entity_id: value } },
    );
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("HA_INVALID_REQUEST", `${label} cannot be empty`);
  }
}

function assertName(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("HA_INVALID_REQUEST", `${label} cannot be empty`);
  }
}

function assertAllowedUpdate(value: object, allowed: ReadonlySet<string>, resource: string): void {
  assertAllowedFields(value, allowed, resource);
  if (Object.keys(value).length === 0) {
    throw new AppError("HA_INVALID_REQUEST", `At least one ${resource} field must be updated`);
  }
}

function assertAllowedFields(value: object, allowed: ReadonlySet<string>, resource: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("HA_INVALID_REQUEST", `${resource} fields must be an object`);
  }
  const unsupported = Object.keys(value).filter(
    (key) => !allowed.has(key) || (value as Record<string, unknown>)[key] === undefined,
  );
  if (unsupported.length > 0) {
    throw new AppError("HA_INVALID_REQUEST", `Unsupported ${resource} field`, {
      details: { unsupported_fields: unsupported.sort() },
    });
  }
}

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function notFound(resource: string, id: string): AppError {
  return new AppError("HA_NOT_FOUND", `Home Assistant ${resource} ${id} was not found`, {
    details: { resource, id },
  });
}
