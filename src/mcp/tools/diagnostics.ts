import { z } from "zod/v4";

import type { Application } from "../../app.js";
import { loadConfigurationCatalog } from "../../config/catalog.js";
import {
  buildDependencyGraph,
  findAutomationErrors,
  findBrokenAutomationReferences,
  findDisabledEntities,
  findDevicesWithoutArea,
  findDuplicateEntities,
  findEntitiesWithoutArea,
  findOrphanedEntities,
  findStaleSensors,
  findUnavailableEntities,
  findUnusedHelpers,
  unifiedSearch,
  type ConfigurationFileRecord,
  type DiagnosticsInput,
  type ResourceConfig,
  type SearchKind,
} from "../../diagnostics/index.js";
import {
  MAX_LOG_BYTES,
  MAX_LOG_ENTRIES,
  MAX_LOG_LINES,
  type LogQueryOptions,
  type LogSeverity,
} from "../../domains/logs.js";
import {
  HomeAssistantEditorRestAdapter,
  runtimeResourcesFromStates,
  type ResourceDomain,
  type RuntimeResource,
} from "../../domains/resources.js";
import { redactSecrets } from "../../security/secrets.js";
import { AppError } from "../../shared/errors.js";
import { paginate } from "../../shared/types.js";
import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
} from "../../shared/types.js";
import { entityId, pageFields } from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";

const MAX_EDITABLE_RESOURCES = 500;
const RESOURCE_FETCH_CONCURRENCY = 10;
const identifier = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .max(255);
const resourceIdentifier = z.string().trim().min(1).max(255);
const searchKinds = [
  "entity",
  "device",
  "area",
  "automation",
  "script",
  "scene",
  "helper",
  "integration",
  "config_file",
] as const satisfies readonly SearchKind[];

interface SnapshotError {
  source: string;
  id?: string;
  code: string;
  message: string;
}

interface DiagnosticsSnapshot extends DiagnosticsInput {
  states: EntityState[];
  entityRegistry: EntityRegistryEntry[];
  deviceRegistry: DeviceRegistryEntry[];
  areaRegistry: AreaRegistryEntry[];
  integrations: ConfigEntry[];
  automations: ResourceConfig[];
  scripts: ResourceConfig[];
  scenes: ResourceConfig[];
  configFiles: ConfigurationFileRecord[];
  source_errors: SnapshotError[];
}

interface OrphanedDevice {
  device_id: string;
  name?: string;
  reason: "missing_config_entry" | "no_registry_relationships";
  missing_config_entry_ids: string[];
}

function snapshotError(source: string, error: unknown, id?: string): SnapshotError {
  return {
    source,
    ...(id === undefined ? {} : { id }),
    code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
  source: string,
  errors: SnapshotError[],
  fallback: T,
): T {
  if (result.status === "fulfilled") return result.value;
  errors.push(snapshotError(source, result.reason));
  return fallback;
}

async function loadEditableResources(
  app: Application,
  domain: ResourceDomain,
  runtime: readonly RuntimeResource[],
  errors: SnapshotError[],
): Promise<ResourceConfig[]> {
  const editable = runtime.filter(
    (resource): resource is RuntimeResource & { config_id: string } =>
      resource.editable && resource.config_id !== null,
  );
  if (editable.length > MAX_EDITABLE_RESOURCES) {
    errors.push({
      source: `${domain}_configs`,
      code: "SNAPSHOT_RESOURCE_LIMIT",
      message: `Only the first ${MAX_EDITABLE_RESOURCES} editable ${domain} configs were fetched`,
    });
  }
  const selected = editable.slice(0, MAX_EDITABLE_RESOURCES);
  const adapter = new HomeAssistantEditorRestAdapter(app.client);
  const resources: ResourceConfig[] = [];

  for (let offset = 0; offset < selected.length; offset += RESOURCE_FETCH_CONCURRENCY) {
    const batch = selected.slice(offset, offset + RESOURCE_FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((resource) => adapter.get(domain, resource.config_id)),
    );
    results.forEach((result, index) => {
      const runtimeResource = batch[index]!;
      if (result.status === "rejected") {
        errors.push(snapshotError(`${domain}_config`, result.reason, runtimeResource.config_id));
        return;
      }
      resources.push({
        kind: domain,
        id: runtimeResource.config_id,
        entity_id: runtimeResource.entity_id,
        ...(runtimeResource.name === null ? {} : { name: runtimeResource.name }),
        config: redactSecrets(result.value, app.settings.filesystem.allowSecretValues),
      });
    });
  }
  return resources;
}

async function buildDiagnosticsSnapshot(app: Application): Promise<DiagnosticsSnapshot> {
  const errors: SnapshotError[] = [];
  const [
    statesResult,
    entitiesResult,
    devicesResult,
    areasResult,
    integrationsResult,
    configFilesResult,
  ] = await Promise.allSettled([
    app.client.getStates(),
    app.client.getEntityRegistry(),
    app.client.getDeviceRegistry(),
    app.client.getAreaRegistry(),
    app.client.getConfigEntries(),
    loadConfigurationCatalog(app.filesystem, app.settings, { maxFiles: 200 }),
  ]);
  const states = settledValue(statesResult, "states", errors, [] as EntityState[]);
  const entityRegistry = settledValue(
    entitiesResult,
    "entity_registry",
    errors,
    [] as EntityRegistryEntry[],
  );
  const deviceRegistry = settledValue(
    devicesResult,
    "device_registry",
    errors,
    [] as DeviceRegistryEntry[],
  );
  const areaRegistry = settledValue(
    areasResult,
    "area_registry",
    errors,
    [] as AreaRegistryEntry[],
  );
  const integrations = settledValue(
    integrationsResult,
    "config_entries",
    errors,
    [] as ConfigEntry[],
  );
  const configFiles = settledValue(configFilesResult, "configuration_files", errors, {
    files: [] as ConfigurationFileRecord[],
    scanned: 0,
    truncated: false,
  });
  if (configFiles.truncated) {
    errors.push({
      source: "configuration_files",
      code: "SNAPSHOT_RESOURCE_LIMIT",
      message: "The configuration-file catalog reached its bounded scan limit",
    });
  }

  const [automations, scripts, scenes] = await Promise.all([
    loadEditableResources(
      app,
      "automation",
      runtimeResourcesFromStates(states, "automation"),
      errors,
    ),
    loadEditableResources(app, "script", runtimeResourcesFromStates(states, "script"), errors),
    loadEditableResources(app, "scene", runtimeResourcesFromStates(states, "scene"), errors),
  ]);
  errors.sort(
    (left, right) =>
      left.source.localeCompare(right.source) || (left.id ?? "").localeCompare(right.id ?? ""),
  );
  return {
    states,
    entityRegistry,
    deviceRegistry,
    areaRegistry,
    integrations,
    automations,
    scripts,
    scenes,
    configFiles: configFiles.files,
    source_errors: errors,
  };
}

function snapshotPage<T>(
  items: readonly T[],
  snapshot: DiagnosticsSnapshot,
  input: { limit: number; offset: number },
) {
  return {
    ...paginate([...items], input),
    snapshot_complete: snapshot.source_errors.length === 0,
    source_errors: snapshot.source_errors,
  };
}

function findOrphanedDevices(snapshot: DiagnosticsSnapshot) {
  const entityDeviceIds = new Set(
    snapshot.entityRegistry.flatMap((entity) =>
      entity.device_id === null || entity.device_id === undefined ? [] : [entity.device_id],
    ),
  );
  const configEntryIds = new Set(snapshot.integrations.map((entry) => entry.entry_id));
  return snapshot.deviceRegistry
    .flatMap((device): OrphanedDevice[] => {
      const linkedEntries = new Set(device.config_entries ?? []);
      if (device.config_entry_id !== undefined) linkedEntries.add(device.config_entry_id);
      const missingEntries = [...linkedEntries]
        .filter((entry) => !configEntryIds.has(entry))
        .sort();
      const name = device.name_by_user ?? device.name ?? undefined;
      if (missingEntries.length > 0) {
        return [
          {
            device_id: device.id,
            ...(name === undefined ? {} : { name }),
            reason: "missing_config_entry" as const,
            missing_config_entry_ids: missingEntries,
          },
        ];
      }
      if (linkedEntries.size === 0 && !entityDeviceIds.has(device.id)) {
        return [
          {
            device_id: device.id,
            ...(name === undefined ? {} : { name }),
            reason: "no_registry_relationships" as const,
            missing_config_entry_ids: [],
          },
        ];
      }
      return [];
    })
    .sort((left, right) => left.device_id.localeCompare(right.device_id));
}

function brokenAutomations(snapshot: DiagnosticsSnapshot) {
  return [
    ...findBrokenAutomationReferences(snapshot).map((finding) => ({
      kind: "missing_entity_reference" as const,
      ...finding,
    })),
    ...findAutomationErrors(snapshot).map((finding) => ({
      kind: "automation_error" as const,
      ...finding,
    })),
  ].sort((left, right) => left.automation_id.localeCompare(right.automation_id));
}

const logLimitFields = {
  mode: z.enum(["full", "condensed"]).default("condensed"),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_BYTES)
    .default(512 * 1_024),
  max_lines: z.number().int().min(1).max(MAX_LOG_LINES).default(2_000),
  max_entries: z.number().int().min(1).max(MAX_LOG_ENTRIES).default(500),
};
const logFilterFields = {
  ...logLimitFields,
  start_time: z.iso.datetime({ offset: true }).optional(),
  end_time: z.iso.datetime({ offset: true }).optional(),
  component: identifier.optional(),
  entity_id: entityId.optional(),
  device_id: resourceIdentifier.optional(),
};
const recentLogFields = {
  ...logFilterFields,
  max_entries: z.number().int().min(1).max(MAX_LOG_ENTRIES).default(50),
};

interface ParsedLogOptions {
  mode: "full" | "condensed";
  max_bytes: number;
  max_lines: number;
  max_entries: number;
  start_time?: string | undefined;
  end_time?: string | undefined;
  component?: string | undefined;
  entity_id?: string | undefined;
  device_id?: string | undefined;
  query?: string | undefined;
  integration?: string | undefined;
  severity?: LogSeverity | readonly LogSeverity[] | undefined;
  minimum_severity?: Exclude<LogSeverity, "UNKNOWN"> | undefined;
}

function logOptions(input: ParsedLogOptions): LogQueryOptions {
  return {
    mode: input.mode,
    maxBytes: input.max_bytes,
    maxLines: input.max_lines,
    maxEntries: input.max_entries,
    ...(input.start_time === undefined ? {} : { startTime: input.start_time }),
    ...(input.end_time === undefined ? {} : { endTime: input.end_time }),
    ...(input.component === undefined ? {} : { component: input.component }),
    ...(input.entity_id === undefined ? {} : { entityId: input.entity_id }),
    ...(input.device_id === undefined ? {} : { deviceId: input.device_id }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.integration === undefined ? {} : { integration: input.integration }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    ...(input.minimum_severity === undefined ? {} : { minimumSeverity: input.minimum_severity }),
  };
}

export function registerDiagnosticsTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "get_home_assistant_logs",
    title: "Get Home Assistant Logs",
    description: "Get bounded current-session Home Assistant logs with structured entries.",
    risk: "READ",
    schema: z.object({
      ...logFilterFields,
      severity: z
        .array(z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL", "UNKNOWN"]))
        .min(1)
        .max(6)
        .optional(),
      minimum_severity: z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]).optional(),
    }),
    source: "derived",
    stability: "internal",
    handler: (input) => app.logs.getLogs(logOptions(input)),
  });

  registrar.register({
    name: "search_logs",
    title: "Search Logs",
    description: "Search bounded Home Assistant log entries by text and optional resource filters.",
    risk: "READ",
    schema: z.object({
      ...logFilterFields,
      query: z.string().trim().min(1).max(500),
      integration: identifier.optional(),
    }),
    source: "derived",
    stability: "internal",
    handler: (input) => app.logs.getLogs(logOptions(input)),
  });

  registrar.register({
    name: "get_errors",
    title: "Get Errors",
    description: "Get recent Home Assistant ERROR and CRITICAL log entries.",
    risk: "READ",
    schema: z.object(recentLogFields),
    source: "derived",
    stability: "internal",
    handler: (input) => app.logs.getRecentErrors(logOptions(input)),
  });

  registrar.register({
    name: "get_warnings",
    title: "Get Warnings",
    description: "Get recent Home Assistant WARNING log entries.",
    risk: "READ",
    schema: z.object(recentLogFields),
    source: "derived",
    stability: "internal",
    handler: (input) => app.logs.getRecentWarnings(logOptions(input)),
  });

  registrar.register({
    name: "get_recent_errors",
    title: "Get Recent Errors",
    description: "Get the newest bounded Home Assistant ERROR and CRITICAL entries.",
    risk: "READ",
    schema: z.object(recentLogFields),
    source: "derived",
    stability: "internal",
    handler: (input) => app.logs.getRecentErrors(logOptions(input)),
  });

  registrar.register({
    name: "get_integration_errors",
    title: "Get Integration Errors",
    description: "Get bounded ERROR and CRITICAL logs for one Home Assistant integration domain.",
    risk: "READ",
    schema: z.object({ integration: identifier, ...recentLogFields }),
    source: "derived",
    stability: "internal",
    handler: ({ integration, ...input }) =>
      app.logs.getIntegrationErrors(integration, logOptions(input)),
  });

  registrar.register({
    name: "find_unavailable_entities",
    title: "Find Unavailable Entities",
    description: "Find entities currently unavailable, optionally including unknown state.",
    risk: "READ",
    schema: z.object({
      include_unknown: z.boolean().default(false),
      ...pageFields,
    }),
    source: "derived",
    stability: "internal",
    handler: async ({ include_unknown, limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(
        findUnavailableEntities(snapshot, { includeUnknown: include_unknown }),
        snapshot,
        { limit, offset },
      );
    },
  });

  registrar.register({
    name: "find_disabled_entities",
    title: "Find Disabled Entities",
    description: "Find entries disabled in the Home Assistant entity registry.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findDisabledEntities(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_orphaned_entities",
    title: "Find Orphaned Entities",
    description: "Find state and entity-registry records with missing related records.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findOrphanedEntities(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_orphaned_devices",
    title: "Find Orphaned Devices",
    description:
      "Find device-registry records with missing config entries or no registry relationships.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findOrphanedDevices(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_unused_helpers",
    title: "Find Unused Helpers",
    description:
      "Find helper entities not referenced by editable automation, script, or scene configs.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findUnusedHelpers(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_stale_sensors",
    title: "Find Stale Sensors",
    description: "Find sensor states that have not updated within a configurable age.",
    risk: "READ",
    schema: z.object({
      stale_after_hours: z
        .number()
        .finite()
        .min(0)
        .max(24 * 365)
        .default(24),
      domains: z.array(identifier).min(1).max(20).default(["sensor", "binary_sensor"]),
      include_unavailable: z.boolean().default(false),
      ...pageFields,
    }),
    source: "derived",
    stability: "internal",
    handler: async ({ stale_after_hours, domains, include_unavailable, limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(
        findStaleSensors(snapshot, {
          asOf: new Date(),
          staleAfterMs: stale_after_hours * 60 * 60 * 1_000,
          domains,
          includeUnavailable: include_unavailable,
        }),
        snapshot,
        { limit, offset },
      );
    },
  });

  registrar.register({
    name: "find_broken_automations",
    title: "Find Broken Automations",
    description: "Find editable automations with error evidence or references to missing entities.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(brokenAutomations(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_automation_errors",
    title: "Find Automation Errors",
    description: "Find automation state and editable-config error evidence.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findAutomationErrors(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_duplicate_entities",
    title: "Find Duplicate Entities",
    description: "Find duplicate entity IDs and platform-scoped unique IDs.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findDuplicateEntities(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "find_entities_without_area",
    title: "Find Entities Without Area",
    description: "Find entity-registry entries without a valid direct or inherited area.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(
        findEntitiesWithoutArea(
          snapshot.entityRegistry,
          snapshot.deviceRegistry,
          snapshot.areaRegistry,
        ),
        snapshot,
        { limit, offset },
      );
    },
  });

  registrar.register({
    name: "find_devices_without_area",
    title: "Find Devices Without Area",
    description: "Find device-registry entries without a valid area assignment.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(
        findDevicesWithoutArea(snapshot.deviceRegistry, snapshot.areaRegistry),
        snapshot,
        { limit, offset },
      );
    },
  });

  registrar.register({
    name: "find_automations_referencing_missing_entities",
    title: "Find Automations Referencing Missing Entities",
    description: "Find exact missing entity references and evidence paths in editable automations.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "derived",
    stability: "internal",
    handler: async ({ limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      return snapshotPage(findBrokenAutomationReferences(snapshot), snapshot, { limit, offset });
    },
  });

  registrar.register({
    name: "get_entity_dependencies",
    title: "Get Entity Dependencies",
    description: "Get configuration dependencies and dependents for one entity ID.",
    risk: "READ",
    schema: z.object({
      entity_id: entityId,
      transitive: z.boolean().default(false),
      max_depth: z.number().int().min(0).max(50).default(20),
    }),
    source: "derived",
    stability: "internal",
    handler: async ({ entity_id, transitive, max_depth }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      const graph = buildDependencyGraph(snapshot);
      return {
        entity_id,
        dependencies: graph.getEntityDependencies(entity_id, {
          transitive,
          maxDepth: max_depth,
        }),
        dependents: graph.getEntityDependents(entity_id),
        snapshot_complete: snapshot.source_errors.length === 0,
        source_errors: snapshot.source_errors,
      };
    },
  });

  registrar.register({
    name: "get_automation_dependencies",
    title: "Get Automation Dependencies",
    description: "Get direct or transitive entity dependencies for one editable automation.",
    risk: "READ",
    schema: z.object({
      automation_id: resourceIdentifier,
      transitive: z.boolean().default(false),
      max_depth: z.number().int().min(0).max(50).default(20),
    }),
    source: "derived",
    stability: "internal",
    handler: async ({ automation_id, transitive, max_depth }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      const graph = buildDependencyGraph(snapshot);
      return {
        automation_id,
        dependencies: graph.getAutomationDependencies(automation_id, {
          transitive,
          maxDepth: max_depth,
        }),
        snapshot_complete: snapshot.source_errors.length === 0,
        source_errors: snapshot.source_errors,
      };
    },
  });

  registrar.register({
    name: "search_home_assistant",
    title: "Search Home Assistant",
    description:
      "Search states, registries, integrations, and editable automation, script, and scene configs.",
    risk: "READ",
    schema: z.object({
      query: z.string().trim().min(1).max(255),
      kinds: z.array(z.enum(searchKinds)).min(1).max(searchKinds.length).optional(),
      minimum_score: z.number().finite().min(0).max(1).default(0.55),
      ...pageFields,
    }),
    source: "derived",
    stability: "internal",
    handler: async ({ query, kinds, minimum_score, limit, offset }) => {
      const snapshot = await buildDiagnosticsSnapshot(app);
      const results = unifiedSearch(snapshot, {
        query,
        minimumScore: minimum_score,
        limit,
        offset,
        ...(kinds === undefined ? {} : { kinds }),
      });
      return {
        ...results,
        snapshot_complete: snapshot.source_errors.length === 0,
        source_errors: snapshot.source_errors,
      };
    },
  });
}
