import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import type { ConfigEntry, DeviceRegistryEntry, EntityRegistryEntry } from "../shared/types.js";

export interface IntegrationDetails extends ConfigEntry {
  devices: DeviceRegistryEntry[];
  entities: EntityRegistryEntry[];
}

export interface IntegrationUpdate {
  title?: string;
  pref_disable_new_entities?: boolean;
  pref_disable_polling?: boolean;
}

export interface IntegrationMutationResult {
  config_entry: ConfigEntry;
  require_restart: boolean;
}

const UPDATE_FIELDS = new Set(["title", "pref_disable_new_entities", "pref_disable_polling"]);

/** Administrative access to Home Assistant config entries. */
export class IntegrationAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  async listIntegrations(domain?: string): Promise<IntegrationDetails[]> {
    if (domain !== undefined) assertIdentifier(domain, "integration domain");
    const [entries, devices, entities] = await Promise.all([
      this.internal("config_entries/get", () => this.client.getConfigEntries(domain)),
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/entity_registry/list", () => this.client.getEntityRegistry()),
    ]);
    return enrichIntegrations(entries, devices, entities);
  }

  async getIntegration(entryId: string): Promise<IntegrationDetails> {
    assertIdentifier(entryId, "config entry ID");
    const [entry, devices, entities] = await Promise.all([
      this.internal("config_entries/get_single", async () =>
        configEntryFromResponse(
          await this.client.wsCommand<unknown>({
            type: "config_entries/get_single",
            entry_id: entryId,
          }),
        ),
      ),
      this.internal("config/device_registry/list", () => this.client.getDeviceRegistry()),
      this.internal("config/entity_registry/list", () => this.client.getEntityRegistry()),
    ]);
    return enrichIntegrations([entry], devices, entities)[0]!;
  }

  async updateIntegration(
    entryId: string,
    changes: IntegrationUpdate,
  ): Promise<IntegrationMutationResult> {
    assertIdentifier(entryId, "config entry ID");
    assertUpdate(changes);
    if (changes.title !== undefined && changes.title.trim().length === 0) {
      throw new AppError("HA_INVALID_REQUEST", "Integration title cannot be empty");
    }
    const response = await this.internal("config_entries/update", () =>
      this.client.wsCommand<unknown>({
        type: "config_entries/update",
        entry_id: entryId,
        ...changes,
      }),
    );
    this.invalidateRelatedCaches();
    return integrationMutationFromResponse(response);
  }

  async disableIntegration(entryId: string): Promise<IntegrationMutationResult> {
    return this.setDisabled(entryId, "user");
  }

  async enableIntegration(entryId: string): Promise<IntegrationMutationResult> {
    return this.setDisabled(entryId, null);
  }

  async reloadIntegration(entryId: string): Promise<unknown> {
    assertIdentifier(entryId, "config entry ID");
    const result = await this.client.restRequest<unknown>(
      `/api/config/config_entries/entry/${encodeURIComponent(entryId)}/reload`,
      { method: "POST", responseType: "json" },
    );
    this.client.invalidateCache("all");
    return result;
  }

  list(domain?: string): Promise<IntegrationDetails[]> {
    return this.listIntegrations(domain);
  }

  get(entryId: string): Promise<IntegrationDetails> {
    return this.getIntegration(entryId);
  }

  update(entryId: string, changes: IntegrationUpdate): Promise<IntegrationMutationResult> {
    return this.updateIntegration(entryId, changes);
  }

  disable(entryId: string): Promise<IntegrationMutationResult> {
    return this.disableIntegration(entryId);
  }

  enable(entryId: string): Promise<IntegrationMutationResult> {
    return this.enableIntegration(entryId);
  }

  reload(entryId: string): Promise<unknown> {
    return this.reloadIntegration(entryId);
  }

  private async setDisabled(
    entryId: string,
    disabledBy: "user" | null,
  ): Promise<IntegrationMutationResult> {
    assertIdentifier(entryId, "config entry ID");
    const response = await this.internal("config_entries/disable", () =>
      this.client.wsCommand<unknown>({
        type: "config_entries/disable",
        entry_id: entryId,
        disabled_by: disabledBy,
      }),
    );
    this.invalidateRelatedCaches();
    const configEntry = await this.internal("config_entries/get_single", async () =>
      configEntryFromResponse(
        await this.client.wsCommand<unknown>({
          type: "config_entries/get_single",
          entry_id: entryId,
        }),
      ),
    );
    return {
      config_entry: configEntry,
      require_restart: responseRequireRestart(response),
    };
  }

  private invalidateRelatedCaches(): void {
    this.client.invalidateCache("config_entries");
    this.client.invalidateCache("registries");
  }

  private async internal<T>(commandType: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof AppError && error.code === "HA_WS_UNSUPPORTED") {
        throw new AppError(
          "HA_INTERNAL_API_UNAVAILABLE",
          `Home Assistant does not support the ${commandType} config-entry operation in this version`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configEntryFromResponse(response: unknown): ConfigEntry {
  const candidate =
    isRecord(response) && isRecord(response.config_entry) ? response.config_entry : response;
  if (
    !isRecord(candidate) ||
    typeof candidate.entry_id !== "string" ||
    typeof candidate.domain !== "string" ||
    typeof candidate.title !== "string"
  ) {
    throw new AppError("HA_INVALID_RESPONSE", "Home Assistant returned an invalid config entry");
  }
  return candidate as unknown as ConfigEntry;
}

function responseRequireRestart(response: unknown): boolean {
  return isRecord(response) && response.require_restart === true;
}

function integrationMutationFromResponse(response: unknown): IntegrationMutationResult {
  return {
    config_entry: configEntryFromResponse(response),
    require_restart: responseRequireRestart(response),
  };
}

export function createIntegrationAdministration(
  client: HomeAssistantClient,
): IntegrationAdministration {
  return new IntegrationAdministration(client);
}

function enrichIntegrations(
  entries: readonly ConfigEntry[],
  devices: readonly DeviceRegistryEntry[],
  entities: readonly EntityRegistryEntry[],
): IntegrationDetails[] {
  return [...entries]
    .sort(
      (left, right) =>
        left.domain.localeCompare(right.domain) ||
        left.title.localeCompare(right.title) ||
        left.entry_id.localeCompare(right.entry_id),
    )
    .map((entry) => {
      const relatedDevices = devices
        .filter(
          (device) =>
            device.config_entry_id === entry.entry_id ||
            device.config_entries?.includes(entry.entry_id) === true,
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const relatedDeviceIds = new Set(relatedDevices.map((device) => device.id));
      return {
        ...entry,
        devices: relatedDevices,
        entities: entities
          .filter(
            (entity) =>
              entity.config_entry_id === entry.entry_id ||
              (entity.device_id !== null &&
                entity.device_id !== undefined &&
                relatedDeviceIds.has(entity.device_id)),
          )
          .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
      };
    });
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("HA_INVALID_REQUEST", `${label} cannot be empty`);
  }
}

function assertUpdate(changes: IntegrationUpdate): void {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new AppError("HA_INVALID_REQUEST", "Config-entry update fields must be an object");
  }
  const unsupported = Object.keys(changes).filter(
    (key) => !UPDATE_FIELDS.has(key) || (changes as Record<string, unknown>)[key] === undefined,
  );
  if (unsupported.length > 0) {
    throw new AppError("HA_INVALID_REQUEST", "Unsupported config-entry update field", {
      details: { unsupported_fields: unsupported.sort(), supported_fields: [...UPDATE_FIELDS] },
    });
  }
  if (Object.keys(changes).length === 0) {
    throw new AppError("HA_INVALID_REQUEST", "At least one config-entry field must be updated");
  }
}
