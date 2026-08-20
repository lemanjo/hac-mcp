import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import type { EntityRegistryEntry, EntityState } from "../shared/types.js";

export const HELPER_TYPES = [
  "input_boolean",
  "input_button",
  "input_text",
  "input_number",
  "input_datetime",
  "input_select",
  "counter",
  "timer",
  "schedule",
] as const;

export type HelperType = (typeof HELPER_TYPES)[number];
export type HelperRecord = Record<string, unknown>;
export type HelperConfiguration = Record<string, unknown>;

export interface HelperDetails extends HelperRecord {
  helper_type: HelperType;
  helper_id: string;
  entity_id: string;
  registry: EntityRegistryEntry | null;
  state: EntityState | null;
}

const ALLOWED_HELPER_TYPES = new Set<string>(HELPER_TYPES);
const HELPER_ID_FIELDS = new Set(HELPER_TYPES.map((type) => `${type}_id`));
const HELPER_ID = /^[a-z0-9_]+$/;

/** Administrative access to Home Assistant storage-backed helpers. */
export class HelperAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  async listHelpers(type: HelperType): Promise<HelperDetails[]> {
    assertHelperType(type);
    const [records, entities, states] = await Promise.all([
      this.listRecords(type),
      this.client.getEntityRegistry(),
      this.client.getStates(),
    ]);
    const entityById = new Map(entities.map((entity) => [entity.entity_id.toLowerCase(), entity]));
    const stateById = new Map(states.map((state) => [state.entity_id.toLowerCase(), state]));
    return records
      .map((record) => {
        const helperId = recordId(type, record);
        const entityId = recordEntityId(type, record, helperId);
        return {
          ...record,
          helper_type: type,
          helper_id: helperId,
          entity_id: entityId,
          registry: entityById.get(entityId.toLowerCase()) ?? null,
          state: stateById.get(entityId.toLowerCase()) ?? null,
        };
      })
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
  }

  async getHelper(type: HelperType, id: string): Promise<HelperDetails> {
    const helperId = normalizeHelperId(type, id);
    const helpers = await this.listHelpers(type);
    const helper = helpers.find((record) => record.helper_id === helperId);
    if (helper === undefined) throw helperNotFound(type, helperId);
    return helper;
  }

  async createHelper(type: HelperType, configuration: HelperConfiguration): Promise<HelperRecord> {
    assertHelperType(type);
    assertConfiguration(configuration, "create");
    const result = await this.internal<HelperRecord>(type, "create", {
      ...configuration,
      type: `${type}/create`,
    });
    this.client.invalidateCache("registries");
    return result;
  }

  async updateHelper(
    type: HelperType,
    id: string,
    changes: HelperConfiguration,
  ): Promise<HelperRecord> {
    const helperId = normalizeHelperId(type, id);
    assertConfiguration(changes, "update");
    if (Object.keys(changes).length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "At least one helper field must be updated");
    }
    const records = await this.listRecords(type);
    const current = records.find((record) => recordId(type, record) === helperId);
    if (current === undefined) throw helperNotFound(type, helperId);

    // Storage helper update schemas generally require all configurable fields.
    const merged = { ...current, ...changes };
    delete merged.id;
    delete merged.entity_id;
    delete merged.helper_type;
    delete merged.helper_id;
    delete merged.type;
    delete merged[`${type}_id`];
    const result = await this.internal<HelperRecord>(type, "update", {
      ...merged,
      type: `${type}/update`,
      [`${type}_id`]: helperId,
    });
    this.client.invalidateCache("registries");
    return result;
  }

  async deleteHelper(type: HelperType, id: string): Promise<unknown> {
    const helperId = normalizeHelperId(type, id);
    const result = await this.internal<unknown>(type, "delete", {
      type: `${type}/delete`,
      [`${type}_id`]: helperId,
    });
    this.client.invalidateCache("registries");
    return result;
  }

  list(type: HelperType): Promise<HelperDetails[]> {
    return this.listHelpers(type);
  }

  get(type: HelperType, id: string): Promise<HelperDetails> {
    return this.getHelper(type, id);
  }

  create(type: HelperType, configuration: HelperConfiguration): Promise<HelperRecord> {
    return this.createHelper(type, configuration);
  }

  update(type: HelperType, id: string, changes: HelperConfiguration): Promise<HelperRecord> {
    return this.updateHelper(type, id, changes);
  }

  delete(type: HelperType, id: string): Promise<unknown> {
    return this.deleteHelper(type, id);
  }

  private listRecords(type: HelperType): Promise<HelperRecord[]> {
    assertHelperType(type);
    return this.internal<HelperRecord[]>(type, "list", { type: `${type}/list` });
  }

  private async internal<T>(
    helperType: HelperType,
    operation: "list" | "create" | "update" | "delete",
    command: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.wsCommand<T>(command as { type: string });
    } catch (error) {
      if (error instanceof AppError && error.code === "HA_WS_UNSUPPORTED") {
        throw new AppError(
          "HELPER_STORAGE_API_UNAVAILABLE",
          `${helperType} helper ${operation} is unavailable through the storage helper API in this Home Assistant version; use the Home Assistant config flow instead`,
          {
            details: { helper_type: helperType, operation },
            cause: error,
          },
        );
      }
      throw error;
    }
  }
}

export function createHelperAdministration(client: HomeAssistantClient): HelperAdministration {
  return new HelperAdministration(client);
}

function assertHelperType(type: string): asserts type is HelperType {
  if (!ALLOWED_HELPER_TYPES.has(type)) {
    throw new AppError(
      "HELPER_TYPE_UNSUPPORTED",
      `${type || "The requested helper type"} is not a supported storage helper type; helpers backed by config flow must be managed through Home Assistant's config-flow API or UI`,
      { details: { helper_type: type, allowed_types: [...HELPER_TYPES] } },
    );
  }
}

function normalizeHelperId(type: HelperType, value: string): string {
  assertHelperType(type);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("HA_INVALID_REQUEST", "Helper ID cannot be empty");
  }
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split(".");
  if (parts.length === 2 && parts[0] !== type) {
    throw new AppError("HA_INVALID_REQUEST", `Helper ${value} is not in the ${type} domain`);
  }
  const helperId = parts.length === 2 ? parts[1]! : normalized;
  if (parts.length > 2 || !HELPER_ID.test(helperId)) {
    throw new AppError(
      "HA_INVALID_REQUEST",
      "Helper ID must use lowercase letters, digits, and underscores",
    );
  }
  return helperId;
}

function recordId(type: HelperType, record: HelperRecord): string {
  const direct = record.id ?? record[`${type}_id`];
  if (typeof direct === "string") return normalizeHelperId(type, direct);
  if (typeof record.entity_id === "string") return normalizeHelperId(type, record.entity_id);
  throw new AppError("HA_INVALID_RESPONSE", `${type}/list returned a helper without an ID`, {
    details: { helper_type: type },
  });
}

function recordEntityId(type: HelperType, record: HelperRecord, helperId: string): string {
  if (typeof record.entity_id !== "string") return `${type}.${helperId}`;
  const normalizedId = normalizeHelperId(type, record.entity_id);
  return `${type}.${normalizedId}`;
}

function assertConfiguration(value: HelperConfiguration, operation: "create" | "update"): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("HA_INVALID_REQUEST", `Helper ${operation} configuration must be an object`);
  }
  const reserved = Object.keys(value).filter(
    (key) =>
      key === "type" ||
      key === "id" ||
      key === "entity_id" ||
      key === "helper_id" ||
      HELPER_ID_FIELDS.has(key),
  );
  if (reserved.length > 0) {
    throw new AppError("HA_INVALID_REQUEST", "Helper identity fields cannot be changed", {
      details: { reserved_fields: reserved.sort() },
    });
  }
}

function helperNotFound(type: HelperType, id: string): AppError {
  return new AppError("HA_NOT_FOUND", `Home Assistant helper ${type}.${id} was not found`, {
    details: { helper_type: type, helper_id: id },
  });
}
