import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
  PageInput,
  Pagination,
} from "../shared/types.js";
import { paginate } from "../shared/types.js";
import {
  collectDependencySources,
  type ConfigurationFileRecord,
  type DependencyGraphInput,
  type EntityReference,
  type ResourceConfig,
} from "./dependency-graph.js";

export interface DiagnosticsInput extends DependencyGraphInput {
  states?: readonly EntityState[];
  entityRegistry?: readonly EntityRegistryEntry[];
  entities?: readonly EntityRegistryEntry[];
  deviceRegistry?: readonly DeviceRegistryEntry[];
  devices?: readonly DeviceRegistryEntry[];
  areaRegistry?: readonly AreaRegistryEntry[];
  areas?: readonly AreaRegistryEntry[];
  integrations?: readonly ConfigEntry[];
  configEntries?: readonly ConfigEntry[];
}

export interface UnavailableEntity {
  entity_id: string;
  state: string;
  last_updated: string;
  name?: string;
}

export interface DisabledItem {
  kind: "entity" | "device" | "integration";
  id: string;
  disabled_by: string;
  name?: string;
}

export type OrphanReason =
  "state_without_registry" | "registry_without_state" | "missing_device" | "missing_config_entry";

export interface OrphanedEntity {
  entity_id: string;
  reason: OrphanReason;
  missing_id?: string;
}

export interface StaleSensor {
  entity_id: string;
  state: string;
  last_updated: string;
  age_ms: number;
  name?: string;
}

export interface StaleSensorOptions {
  asOf: string | number | Date;
  staleAfterMs?: number;
  domains?: readonly string[];
  includeUnavailable?: boolean;
}

export interface BrokenAutomationReference {
  automation_id: string;
  automation_entity_id?: string;
  name?: string;
  entity_id: string;
  evidence: EntityReference[];
}

export interface DuplicateEntity {
  duplicate_key: "entity_id" | "unique_id";
  source: "states" | "entity_registry";
  value: string;
  entity_ids: string[];
  occurrences: number;
}

export interface EntityWithoutArea {
  entity_id: string;
  device_id?: string;
  reason: "unassigned" | "missing_device" | "unknown_area";
  area_id?: string;
}

export interface DeviceWithoutArea {
  device_id: string;
  name?: string;
  reason: "unassigned" | "unknown_area";
  area_id?: string;
}

export interface UnusedHelper {
  entity_id: string;
  name?: string;
  source: "resource" | "entity_registry" | "state";
}

export interface AutomationErrorEvidence {
  path: string;
  message: string;
}

export interface AutomationError {
  automation_id: string;
  automation_entity_id?: string;
  name?: string;
  errors: AutomationErrorEvidence[];
}

export type AuditKind =
  | "unavailable"
  | "disabled"
  | "orphaned"
  | "stale_sensor"
  | "broken_automation_reference"
  | "duplicate_entity"
  | "entity_without_area"
  | "device_without_area"
  | "unused_helper"
  | "automation_error";

export interface AuditFinding {
  audit: AuditKind;
  severity: "info" | "warning" | "error";
  id: string;
  message: string;
  entity_id?: string;
  evidence_paths?: string[];
}

export interface AuditReport {
  unavailable: UnavailableEntity[];
  disabled: DisabledItem[];
  orphaned: OrphanedEntity[];
  stale_sensors: StaleSensor[];
  broken_automation_references: BrokenAutomationReference[];
  duplicate_entities: DuplicateEntity[];
  entities_without_area: EntityWithoutArea[];
  devices_without_area: DeviceWithoutArea[];
  unused_helpers: UnusedHelper[];
  automation_errors: AutomationError[];
}

export interface RunAuditsOptions {
  asOf: string | number | Date;
  staleAfterMs?: number;
  staleSensorDomains?: readonly string[];
  includeUnknownAsUnavailable?: boolean;
}

export interface AuditPage {
  items: AuditFinding[];
  pagination: Pagination;
}

export type ListAuditFindingsOptions = RunAuditsOptions &
  PageInput & { audits?: readonly AuditKind[] };

export const HELPER_DOMAINS = new Set([
  "counter",
  "input_boolean",
  "input_button",
  "input_datetime",
  "input_number",
  "input_select",
  "input_text",
  "schedule",
  "timer",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function friendlyName(state: EntityState): string | undefined {
  const name = state.attributes.friendly_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function isEntityStateList(
  input: DiagnosticsInput | readonly EntityState[],
): input is readonly EntityState[] {
  return Array.isArray(input);
}

function isEntityRegistryList(
  input: DiagnosticsInput | readonly EntityRegistryEntry[],
): input is readonly EntityRegistryEntry[] {
  return Array.isArray(input);
}

function isDeviceRegistryList(
  input: DiagnosticsInput | readonly DeviceRegistryEntry[],
): input is readonly DeviceRegistryEntry[] {
  return Array.isArray(input);
}

function isConfigEntryList(
  input: DiagnosticsInput | readonly ConfigEntry[],
): input is readonly ConfigEntry[] {
  return Array.isArray(input);
}

function statesFrom(input: DiagnosticsInput | readonly EntityState[]): readonly EntityState[] {
  return isEntityStateList(input) ? input : (input.states ?? []);
}

function integrationsFrom(input: DiagnosticsInput): readonly ConfigEntry[] {
  return input.integrations ?? input.configEntries ?? [];
}

function entitiesFrom(input: DiagnosticsInput): readonly EntityRegistryEntry[] {
  return input.entityRegistry ?? input.entities ?? [];
}

function devicesFrom(input: DiagnosticsInput): readonly DeviceRegistryEntry[] {
  return input.deviceRegistry ?? input.devices ?? [];
}

function areasFrom(input: DiagnosticsInput): readonly AreaRegistryEntry[] | undefined {
  return input.areaRegistry ?? input.areas;
}

function normalizedEntityId(value: string): string {
  return value.toLowerCase();
}

export function findUnavailableEntities(
  input: DiagnosticsInput | readonly EntityState[],
  options: { includeUnknown?: boolean } = {},
): UnavailableEntity[] {
  const unavailableStates =
    options.includeUnknown === true
      ? new Set(["unavailable", "unknown"])
      : new Set(["unavailable"]);
  return statesFrom(input)
    .filter((state) => unavailableStates.has(state.state.toLowerCase()))
    .map((state) => {
      const name = friendlyName(state);
      return {
        entity_id: normalizedEntityId(state.entity_id),
        state: state.state,
        last_updated: state.last_updated,
        ...(name === undefined ? {} : { name }),
      };
    })
    .sort((left, right) => compareText(left.entity_id, right.entity_id));
}

export function findDisabledEntities(
  input: DiagnosticsInput | readonly EntityRegistryEntry[],
): DisabledItem[] {
  const entities = isEntityRegistryList(input) ? input : entitiesFrom(input);
  return entities
    .filter((entity) => typeof entity.disabled_by === "string" && entity.disabled_by.length > 0)
    .map((entity) => {
      const name = entity.name ?? entity.original_name ?? undefined;
      return {
        kind: "entity" as const,
        id: normalizedEntityId(entity.entity_id),
        disabled_by: entity.disabled_by as string,
        ...(name === undefined ? {} : { name }),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
}

export function findDisabledDevices(
  input: DiagnosticsInput | readonly DeviceRegistryEntry[],
): DisabledItem[] {
  const devices = isDeviceRegistryList(input) ? input : devicesFrom(input);
  return devices
    .filter((device) => typeof device.disabled_by === "string" && device.disabled_by.length > 0)
    .map((device) => {
      const name = device.name_by_user ?? device.name ?? undefined;
      return {
        kind: "device" as const,
        id: device.id,
        disabled_by: device.disabled_by as string,
        ...(name === undefined ? {} : { name }),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
}

export function findDisabledIntegrations(
  input: DiagnosticsInput | readonly ConfigEntry[],
): DisabledItem[] {
  const integrations = isConfigEntryList(input) ? input : integrationsFrom(input);
  return integrations
    .filter(
      (integration) =>
        typeof integration.disabled_by === "string" && integration.disabled_by.length > 0,
    )
    .map((integration) => ({
      kind: "integration" as const,
      id: integration.entry_id,
      disabled_by: integration.disabled_by as string,
      name: integration.title,
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

export function findDisabledItems(input: DiagnosticsInput): DisabledItem[] {
  return [
    ...findDisabledEntities(input),
    ...findDisabledDevices(input),
    ...findDisabledIntegrations(input),
  ].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id));
}

export function findOrphanedEntities(input: DiagnosticsInput): OrphanedEntity[];
export function findOrphanedEntities(
  states: readonly EntityState[],
  entityRegistry: readonly EntityRegistryEntry[],
  deviceRegistry?: readonly DeviceRegistryEntry[],
  integrations?: readonly ConfigEntry[],
): OrphanedEntity[];
export function findOrphanedEntities(
  input: DiagnosticsInput | readonly EntityState[],
  entityRegistry: readonly EntityRegistryEntry[] = [],
  deviceRegistry: readonly DeviceRegistryEntry[] = [],
  integrations: readonly ConfigEntry[] = [],
): OrphanedEntity[] {
  const snapshot: DiagnosticsInput = isEntityStateList(input)
    ? { states: input, entityRegistry, deviceRegistry, integrations }
    : input;
  const states = snapshot.states ?? [];
  const entities = entitiesFrom(snapshot);
  const devices = devicesFrom(snapshot);
  const configEntries = integrationsFrom(snapshot);
  const stateIds = new Set(states.map((state) => normalizedEntityId(state.entity_id)));
  const registryIds = new Set(entities.map((entity) => normalizedEntityId(entity.entity_id)));
  const deviceIds = new Set(devices.map((device) => device.id));
  const configEntryIds = new Set(configEntries.map((entry) => entry.entry_id));
  const findings: OrphanedEntity[] = [];

  for (const stateId of stateIds) {
    if (!registryIds.has(stateId)) {
      findings.push({ entity_id: stateId, reason: "state_without_registry" });
    }
  }

  for (const entity of entities) {
    const entityId = normalizedEntityId(entity.entity_id);
    if (!stateIds.has(entityId) && !entity.disabled_by) {
      findings.push({ entity_id: entityId, reason: "registry_without_state" });
    }
    if (entity.device_id && !deviceIds.has(entity.device_id)) {
      findings.push({
        entity_id: entityId,
        reason: "missing_device",
        missing_id: entity.device_id,
      });
    }
    if (
      configEntries.length > 0 &&
      entity.config_entry_id &&
      !configEntryIds.has(entity.config_entry_id)
    ) {
      findings.push({
        entity_id: entityId,
        reason: "missing_config_entry",
        missing_id: entity.config_entry_id,
      });
    }
  }

  return findings.sort(
    (left, right) =>
      compareText(left.entity_id, right.entity_id) ||
      compareText(left.reason, right.reason) ||
      compareText(left.missing_id ?? "", right.missing_id ?? ""),
  );
}

function timestamp(value: string | number | Date): number {
  const result =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result))
    throw new RangeError(`Invalid diagnostic timestamp: ${String(value)}`);
  return result;
}

export function findStaleSensors(
  input: DiagnosticsInput | readonly EntityState[],
  options: StaleSensorOptions,
): StaleSensor[] {
  const asOf = timestamp(options.asOf);
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? 24 * 60 * 60 * 1_000);
  const domains = new Set(options.domains ?? ["sensor", "binary_sensor"]);
  const unavailable = new Set(["unavailable", "unknown"]);

  return statesFrom(input)
    .flatMap((state): StaleSensor[] => {
      const entityId = normalizedEntityId(state.entity_id);
      const domain = entityId.split(".", 1)[0] ?? "";
      if (!domains.has(domain)) return [];
      if (options.includeUnavailable !== true && unavailable.has(state.state.toLowerCase()))
        return [];
      const lastUpdated = timestamp(state.last_updated);
      const age = Math.max(0, asOf - lastUpdated);
      if (age < staleAfterMs) return [];
      const name = friendlyName(state);
      return [
        {
          entity_id: entityId,
          state: state.state,
          last_updated: state.last_updated,
          age_ms: age,
          ...(name === undefined ? {} : { name }),
        },
      ];
    })
    .sort(
      (left, right) => right.age_ms - left.age_ms || compareText(left.entity_id, right.entity_id),
    );
}

function allKnownEntityIds(input: DiagnosticsInput): Set<string> {
  const known = new Set<string>();
  for (const state of input.states ?? []) known.add(normalizedEntityId(state.entity_id));
  for (const entity of entitiesFrom(input)) known.add(normalizedEntityId(entity.entity_id));
  for (const source of collectDependencySources(input)) {
    if (source.entity_id) known.add(source.entity_id);
  }
  return known;
}

export function findBrokenAutomationReferences(
  input: DiagnosticsInput,
): BrokenAutomationReference[] {
  const known = allKnownEntityIds(input);
  const findings: BrokenAutomationReference[] = [];
  const automations = collectDependencySources(input).filter(
    (source) => source.kind === "automation",
  );

  for (const automation of automations) {
    const grouped = new Map<string, EntityReference[]>();
    for (const reference of automation.references) {
      if (known.has(reference.entity_id)) continue;
      const evidence = grouped.get(reference.entity_id) ?? [];
      evidence.push(reference);
      grouped.set(reference.entity_id, evidence);
    }
    for (const [entityId, evidence] of grouped) {
      findings.push({
        automation_id: automation.id,
        ...(automation.entity_id === undefined
          ? {}
          : { automation_entity_id: automation.entity_id }),
        ...(automation.name === undefined ? {} : { name: automation.name }),
        entity_id: entityId,
        evidence: evidence.sort(
          (left, right) =>
            compareText(left.path, right.path) || compareText(left.value, right.value),
        ),
      });
    }
  }

  return findings.sort(
    (left, right) =>
      compareText(left.automation_id, right.automation_id) ||
      compareText(left.entity_id, right.entity_id),
  );
}

function duplicateGroups<T>(
  items: readonly T[],
  keyFor: (item: T) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return new Map([...groups].filter(([, group]) => group.length > 1));
}

export function findDuplicateEntities(input: DiagnosticsInput): DuplicateEntity[];
export function findDuplicateEntities(
  states: readonly EntityState[],
  entityRegistry?: readonly EntityRegistryEntry[],
): DuplicateEntity[];
export function findDuplicateEntities(
  input: DiagnosticsInput | readonly EntityState[],
  entityRegistry: readonly EntityRegistryEntry[] = [],
): DuplicateEntity[] {
  const states = isEntityStateList(input) ? input : (input.states ?? []);
  const entities = isEntityStateList(input) ? entityRegistry : entitiesFrom(input);
  const findings: DuplicateEntity[] = [];

  for (const [entityId, duplicates] of duplicateGroups(states, (state) =>
    normalizedEntityId(state.entity_id),
  )) {
    findings.push({
      duplicate_key: "entity_id",
      source: "states",
      value: entityId,
      entity_ids: [entityId],
      occurrences: duplicates.length,
    });
  }

  for (const [entityId, duplicates] of duplicateGroups(entities, (entity) =>
    normalizedEntityId(entity.entity_id),
  )) {
    findings.push({
      duplicate_key: "entity_id",
      source: "entity_registry",
      value: entityId,
      entity_ids: [entityId],
      occurrences: duplicates.length,
    });
  }

  const uniqueIdGroups = duplicateGroups(entities, (entity) => {
    if (!entity.unique_id) return undefined;
    const domain = normalizedEntityId(entity.entity_id).split(".", 1)[0] ?? "";
    return [domain, entity.platform ?? "", entity.unique_id].join("\0");
  });
  for (const [key, duplicates] of uniqueIdGroups) {
    const uniqueId = key.split("\0").at(-1) ?? key;
    findings.push({
      duplicate_key: "unique_id",
      source: "entity_registry",
      value: uniqueId,
      entity_ids: [
        ...new Set(duplicates.map((entity) => normalizedEntityId(entity.entity_id))),
      ].sort(compareText),
      occurrences: duplicates.length,
    });
  }

  return findings.sort(
    (left, right) =>
      compareText(left.duplicate_key, right.duplicate_key) ||
      compareText(left.value, right.value) ||
      compareText(left.source, right.source) ||
      compareText(left.entity_ids.join("\0"), right.entity_ids.join("\0")),
  );
}

export function findEntitiesWithoutArea(
  entityRegistry: readonly EntityRegistryEntry[],
  deviceRegistry: readonly DeviceRegistryEntry[] = [],
  areaRegistry?: readonly AreaRegistryEntry[],
): EntityWithoutArea[] {
  const devices = new Map(deviceRegistry.map((device) => [device.id, device]));
  const areaIds = areaRegistry ? new Set(areaRegistry.map((area) => area.area_id)) : undefined;
  const findings: EntityWithoutArea[] = [];

  for (const entity of entityRegistry) {
    const device = entity.device_id ? devices.get(entity.device_id) : undefined;
    const areaId = entity.area_id ?? device?.area_id ?? undefined;
    let reason: EntityWithoutArea["reason"] | undefined;
    if (entity.device_id && !device && !entity.area_id) reason = "missing_device";
    else if (!areaId) reason = "unassigned";
    else if (areaIds && !areaIds.has(areaId)) reason = "unknown_area";
    if (!reason) continue;
    findings.push({
      entity_id: normalizedEntityId(entity.entity_id),
      ...(entity.device_id === null || entity.device_id === undefined
        ? {}
        : { device_id: entity.device_id }),
      reason,
      ...(areaId === undefined ? {} : { area_id: areaId }),
    });
  }

  return findings.sort((left, right) => compareText(left.entity_id, right.entity_id));
}

export function findDevicesWithoutArea(
  deviceRegistry: readonly DeviceRegistryEntry[],
  areaRegistry?: readonly AreaRegistryEntry[],
): DeviceWithoutArea[] {
  const areaIds = areaRegistry ? new Set(areaRegistry.map((area) => area.area_id)) : undefined;
  return deviceRegistry
    .flatMap((device): DeviceWithoutArea[] => {
      const reason = !device.area_id
        ? "unassigned"
        : areaIds && !areaIds.has(device.area_id)
          ? "unknown_area"
          : undefined;
      if (!reason) return [];
      const name = device.name_by_user ?? device.name ?? undefined;
      return [
        {
          device_id: device.id,
          ...(name === undefined ? {} : { name }),
          reason,
          ...(device.area_id === null || device.area_id === undefined
            ? {}
            : { area_id: device.area_id }),
        },
      ];
    })
    .sort((left, right) => compareText(left.device_id, right.device_id));
}

function isHelperEntityId(entityId: string): boolean {
  const [domain] = normalizedEntityId(entityId).split(".", 1);
  return domain !== undefined && HELPER_DOMAINS.has(domain);
}

function helperResourceEntityId(resource: ResourceConfig): string | undefined {
  const candidate =
    typeof resource.entity_id === "string"
      ? resource.entity_id
      : typeof resource.id === "string" && resource.id.includes(".")
        ? resource.id
        : undefined;
  return candidate && isHelperEntityId(candidate) ? normalizedEntityId(candidate) : undefined;
}

export function findUnusedHelpers(input: DiagnosticsInput): UnusedHelper[] {
  const helpers = new Map<string, UnusedHelper>();
  const helperResources = [
    ...(input.helpers ?? []),
    ...(input.resources ?? input.resourceConfigs ?? []).filter(
      (resource) => (resource.kind ?? resource.resource_type) === "helper",
    ),
  ];
  for (const resource of helperResources) {
    const entityId = helperResourceEntityId(resource);
    if (!entityId) continue;
    const name = resource.name ?? resource.alias ?? resource.title;
    helpers.set(entityId, {
      entity_id: entityId,
      ...(typeof name !== "string" || name.length === 0 ? {} : { name }),
      source: "resource",
    });
  }
  for (const entity of entitiesFrom(input)) {
    const entityId = normalizedEntityId(entity.entity_id);
    if (!isHelperEntityId(entityId) || helpers.has(entityId)) continue;
    const name = entity.name ?? entity.original_name ?? undefined;
    helpers.set(entityId, {
      entity_id: entityId,
      ...(name === undefined ? {} : { name }),
      source: "entity_registry",
    });
  }
  for (const state of input.states ?? []) {
    const entityId = normalizedEntityId(state.entity_id);
    if (!isHelperEntityId(entityId) || helpers.has(entityId)) continue;
    const name = friendlyName(state);
    helpers.set(entityId, {
      entity_id: entityId,
      ...(name === undefined ? {} : { name }),
      source: "state",
    });
  }

  const referenced = new Set<string>();
  const sources = collectDependencySources(input);
  for (const source of sources) {
    for (const reference of source.references) {
      if (reference.entity_id !== source.entity_id) referenced.add(reference.entity_id);
    }
  }

  return [...helpers.values()]
    .filter((helper) => !referenced.has(helper.entity_id))
    .sort((left, right) => compareText(left.entity_id, right.entity_id));
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && !["false", "none", "null", "ok"].includes(trimmed.toLowerCase())) return trimmed;
  }
  if (value instanceof Error) return value.message;
  if (Array.isArray(value) && value.length > 0) return JSON.stringify(value);
  if (value && typeof value === "object" && Object.keys(value).length > 0) {
    return JSON.stringify(value);
  }
  return undefined;
}

function collectErrors(
  value: unknown,
  rootPath = "$",
  ancestors = new Set<object>(),
): AutomationErrorEvidence[] {
  if (!value || typeof value !== "object" || ancestors.has(value)) return [];
  ancestors.add(value);
  const errors: AutomationErrorEvidence[] = [];
  for (const key of Object.keys(value).sort(compareText)) {
    const child = (value as Record<string, unknown>)[key];
    const path = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? `${rootPath}.${key}`
      : `${rootPath}[${JSON.stringify(key)}]`;
    if (/(^|_)errors?($|_)/i.test(key) && !/^continue_on_error$/i.test(key)) {
      const message = errorMessage(child);
      if (message) errors.push({ path, message });
    }
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        child.forEach((item, index) =>
          errors.push(...collectErrors(item, `${path}[${index}]`, ancestors)),
        );
      } else {
        errors.push(...collectErrors(child, path, ancestors));
      }
    }
  }
  ancestors.delete(value);
  return errors;
}

function resourceIdentifier(resource: ResourceConfig, index: number): string {
  return resource.id ?? resource.entity_id ?? `automation:${index}`;
}

export function findAutomationErrors(input: DiagnosticsInput): AutomationError[] {
  const errors = new Map<string, AutomationError>();
  const add = (
    automationId: string,
    evidence: readonly AutomationErrorEvidence[],
    entityId?: string,
    name?: string,
  ): void => {
    if (evidence.length === 0) return;
    const existing = errors.get(automationId);
    const combined = [...(existing?.errors ?? []), ...evidence];
    errors.set(automationId, {
      automation_id: automationId,
      ...(entityId === undefined ? {} : { automation_entity_id: entityId }),
      ...(name === undefined ? {} : { name }),
      errors: combined,
    });
  };

  for (const state of input.states ?? []) {
    const entityId = normalizedEntityId(state.entity_id);
    if (!entityId.startsWith("automation.")) continue;
    const evidence = collectErrors(state.attributes, "$.attributes");
    if (["unavailable", "unknown"].includes(state.state.toLowerCase())) {
      evidence.push({ path: "$.state", message: `Automation state is ${state.state}` });
    }
    add(entityId, evidence, entityId, friendlyName(state));
  }

  const automationResources = [
    ...(input.automations ?? []),
    ...(input.resources ?? input.resourceConfigs ?? []).filter(
      (resource) => (resource.kind ?? resource.resource_type) === "automation",
    ),
  ];
  automationResources.forEach((automation, index) => {
    const automationId = resourceIdentifier(automation, index);
    const entityId =
      typeof automation.entity_id === "string" && automation.entity_id.startsWith("automation.")
        ? normalizedEntityId(automation.entity_id)
        : undefined;
    const name = automation.name ?? automation.alias ?? automation.title;
    add(
      automationId,
      collectErrors(automation),
      entityId,
      typeof name === "string" ? name : undefined,
    );
  });

  for (const file of input.configFiles ?? input.configurationFiles ?? []) {
    if (!/(^|[/_.-])automations?([/_.-]|$)/i.test(file.path)) continue;
    const evidence = collectErrors(file);
    if (file.error) evidence.push({ path: "$.error", message: file.error });
    add(file.path, evidence, undefined, file.path);
  }

  return [...errors.values()]
    .map((automation) => ({
      ...automation,
      errors: [
        ...new Map(
          automation.errors.map((item) => [`${item.path}\0${item.message}`, item] as const),
        ).values(),
      ].sort(
        (left, right) =>
          compareText(left.path, right.path) || compareText(left.message, right.message),
      ),
    }))
    .sort((left, right) => compareText(left.automation_id, right.automation_id));
}

export function runAudits(input: DiagnosticsInput, options: RunAuditsOptions): AuditReport {
  return {
    unavailable: findUnavailableEntities(input, {
      ...(options.includeUnknownAsUnavailable === undefined
        ? {}
        : { includeUnknown: options.includeUnknownAsUnavailable }),
    }),
    disabled: findDisabledItems(input),
    orphaned: findOrphanedEntities(input),
    stale_sensors: findStaleSensors(input, {
      asOf: options.asOf,
      ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      ...(options.staleSensorDomains === undefined ? {} : { domains: options.staleSensorDomains }),
    }),
    broken_automation_references: findBrokenAutomationReferences(input),
    duplicate_entities: findDuplicateEntities(input),
    entities_without_area: findEntitiesWithoutArea(
      entitiesFrom(input),
      devicesFrom(input),
      areasFrom(input),
    ),
    devices_without_area: findDevicesWithoutArea(devicesFrom(input), areasFrom(input)),
    unused_helpers: findUnusedHelpers(input),
    automation_errors: findAutomationErrors(input),
  };
}

function auditFindings(report: AuditReport): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const item of report.unavailable) {
    findings.push({
      audit: "unavailable",
      severity: "warning",
      id: item.entity_id,
      entity_id: item.entity_id,
      message: `${item.entity_id} is ${item.state}`,
    });
  }
  for (const item of report.disabled) {
    findings.push({
      audit: "disabled",
      severity: "info",
      id: `${item.kind}:${item.id}`,
      ...(item.kind === "entity" ? { entity_id: item.id } : {}),
      message: `${item.kind} ${item.id} is disabled by ${item.disabled_by}`,
    });
  }
  for (const item of report.orphaned) {
    findings.push({
      audit: "orphaned",
      severity: "warning",
      id: `${item.entity_id}:${item.reason}`,
      entity_id: item.entity_id,
      message: `${item.entity_id} is orphaned: ${item.reason}`,
    });
  }
  for (const item of report.stale_sensors) {
    findings.push({
      audit: "stale_sensor",
      severity: "warning",
      id: item.entity_id,
      entity_id: item.entity_id,
      message: `${item.entity_id} has not updated for ${item.age_ms} ms`,
    });
  }
  for (const item of report.broken_automation_references) {
    findings.push({
      audit: "broken_automation_reference",
      severity: "error",
      id: `${item.automation_id}:${item.entity_id}`,
      entity_id: item.entity_id,
      message: `${item.automation_id} references missing entity ${item.entity_id}`,
      evidence_paths: item.evidence.map(({ path }) => path),
    });
  }
  for (const item of report.duplicate_entities) {
    findings.push({
      audit: "duplicate_entity",
      severity: "error",
      id: `${item.source}:${item.duplicate_key}:${item.value}`,
      message: `${item.value} occurs ${item.occurrences} times in ${item.source}`,
    });
  }
  for (const item of report.entities_without_area) {
    findings.push({
      audit: "entity_without_area",
      severity: "info",
      id: item.entity_id,
      entity_id: item.entity_id,
      message: `${item.entity_id} has no valid area: ${item.reason}`,
    });
  }
  for (const item of report.devices_without_area) {
    findings.push({
      audit: "device_without_area",
      severity: "info",
      id: item.device_id,
      message: `${item.device_id} has no valid area: ${item.reason}`,
    });
  }
  for (const item of report.unused_helpers) {
    findings.push({
      audit: "unused_helper",
      severity: "info",
      id: item.entity_id,
      entity_id: item.entity_id,
      message: `${item.entity_id} is not referenced by the supplied configuration`,
    });
  }
  for (const item of report.automation_errors) {
    findings.push({
      audit: "automation_error",
      severity: "error",
      id: item.automation_id,
      ...(item.automation_entity_id === undefined ? {} : { entity_id: item.automation_entity_id }),
      message: `${item.automation_id} has ${item.errors.length} error${item.errors.length === 1 ? "" : "s"}`,
      evidence_paths: item.errors.map(({ path }) => path),
    });
  }
  return findings.sort(
    (left, right) => compareText(left.audit, right.audit) || compareText(left.id, right.id),
  );
}

export function listAuditFindings(
  input: DiagnosticsInput,
  options: ListAuditFindingsOptions,
): AuditPage {
  const selected = options.audits ? new Set(options.audits) : undefined;
  const findings = auditFindings(runAudits(input, options)).filter(
    (finding) => !selected || selected.has(finding.audit),
  );
  return paginate(findings, options);
}

export type { ConfigurationFileRecord };
