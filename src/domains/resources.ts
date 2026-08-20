import type { HomeAssistantClient, ServiceCallResponse } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import type { EntityState, JsonValue } from "../shared/types.js";

export type ResourceDomain = "automation" | "script" | "scene";
export type TraceDomain = Extract<ResourceDomain, "automation" | "script">;
export type ResourceConfig = Record<string, unknown>;
export type MutationOperation = "create" | "update" | "delete";

export interface RuntimeResource {
  domain: ResourceDomain;
  entity_id: string;
  object_id: string;
  config_id: string | null;
  editable: boolean;
  state: string;
  name: string | null;
  last_triggered: string | null;
  last_changed: string;
  last_updated: string;
  attributes: Record<string, unknown>;
}

export interface ResourceRelationships {
  config_id: string;
  entity_id: string | null;
  entities: string[];
  devices: string[];
  areas: string[];
  floors: string[];
  labels: string[];
  related_config_ids: string[];
}

export interface ResourceReadResult<T extends ResourceConfig = ResourceConfig> {
  domain: ResourceDomain;
  id: string;
  source: "rest" | "websocket";
  config: T;
  runtime: RuntimeResource | null;
  relationships: ResourceRelationships;
}

export interface ValidationFieldResult {
  valid: boolean;
  error: string | null;
}

export interface ValidationReport {
  valid: boolean;
  source: "websocket" | "local";
  fields: Partial<Record<"triggers" | "conditions" | "actions" | "config", ValidationFieldResult>>;
}

export interface ConfigFragments {
  triggers?: unknown;
  conditions?: unknown;
  actions?: unknown;
}

export interface JsonDiffEntry {
  op: "add" | "remove" | "replace";
  path: string;
  before?: JsonValue;
  after?: JsonValue;
}

export interface MutationCheckpoint {
  domain: ResourceDomain;
  id: string;
  operation: MutationOperation;
  created_at: string;
  before: ResourceConfig | null;
  after: ResourceConfig | null;
  diff: JsonDiffEntry[];
}

export interface CheckpointHook {
  (checkpoint: MutationCheckpoint): void | Promise<void>;
}

export interface PostApplyHook {
  (checkpoint: MutationCheckpoint): void | Promise<void>;
}

export interface MutationOptions {
  dryRun?: boolean;
  checkpoint?: CheckpointHook;
  postApply?: PostApplyHook;
  entityId?: string;
  verifyAttempts?: number;
  verifyDelayMs?: number;
}

export interface VerificationResult {
  ok: boolean;
  attempts: number;
  config: {
    expected: "present" | "absent";
    observed: "present" | "absent" | "unknown";
    matches: boolean;
    error: ErrorSummary | null;
  };
  entity: {
    expected: "present" | "absent" | "not_required";
    observed: "present" | "absent" | "unknown";
    entity_id: string | null;
    matches: boolean;
    error: ErrorSummary | null;
  };
}

export interface RollbackResult {
  attempted: boolean;
  action: "restore" | "delete_created" | null;
  succeeded: boolean;
  error: ErrorSummary | null;
}

export interface MutationResult {
  domain: ResourceDomain;
  id: string;
  entity_id: string | null;
  operation: MutationOperation;
  dry_run: boolean;
  changed: boolean;
  applied: boolean;
  checkpointed: boolean;
  diff: JsonDiffEntry[];
  validation: ValidationReport | null;
  reload: {
    triggered_by: "editor" | "none";
    explicit_reload: false;
  };
  verification: VerificationResult | null;
  rollback: RollbackResult;
}

export interface ControlResult<T = unknown> {
  domain: ResourceDomain;
  service: string;
  entity_id: string | null;
  response: ServiceCallResponse<T>;
}

export interface TraceSummary extends Record<string, unknown> {
  domain: TraceDomain;
  item_id: string;
  run_id: string;
  state?: string;
  last_step?: string | null;
  script_execution?: string;
  timestamp?: {
    start?: string;
    finish?: string | null;
    [key: string]: unknown;
  };
}

export interface TraceDetails extends TraceSummary {
  trace?: Record<string, TraceStep[]>;
  error?: string;
}

export interface TraceStep extends Record<string, unknown> {
  path?: string;
  error?: string;
  template_errors?: string[];
  result?: unknown;
}

export interface TraceDiagnostic {
  path: string;
  kind: "error" | "template_error";
  message: string;
}

export interface TraceFailureExplanation {
  outcome: "succeeded" | "failed" | "running" | "not_triggered" | "unknown";
  code: string;
  summary: string;
  last_step: string | null;
  diagnostics: TraceDiagnostic[];
}

export interface TraceReadResult {
  trace: TraceDetails;
  explanation: TraceFailureExplanation;
}

export interface ErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
}

type ConfigValidator = (config: ResourceConfig) => Promise<ValidationReport>;

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SLUG_PATTERN = /^[a-z0-9_]+$/;
const MAX_IDENTIFIER_LENGTH = 255;
const DEFAULT_VERIFY_ATTEMPTS = 8;
const DEFAULT_VERIFY_DELAY_MS = 250;

/** Isolates Home Assistant's internal editor REST endpoints from public REST use. */
export class HomeAssistantEditorRestAdapter {
  constructor(private readonly client: HomeAssistantClient) {}

  async get(domain: ResourceDomain, id: string): Promise<ResourceConfig> {
    const config = await this.client.restRequest<unknown>(editorPath(domain, id), {
      responseType: "json",
    });
    return cloneConfig(config, `${domain} editor response`);
  }

  async post(domain: ResourceDomain, id: string, config: ResourceConfig): Promise<void> {
    await this.client.restRequest<unknown>(editorPath(domain, id), {
      method: "POST",
      body: cloneConfig(config, `${domain} config`),
      responseType: "json",
    });
  }

  async delete(domain: ResourceDomain, id: string): Promise<void> {
    await this.client.restRequest<unknown>(editorPath(domain, id), {
      method: "DELETE",
      responseType: "json",
    });
  }
}

export function assertResourceId(domain: ResourceDomain, id: string): string {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_IDENTIFIER_LENGTH ||
    !(domain === "script" ? SLUG_PATTERN : RESOURCE_ID_PATTERN).test(id)
  ) {
    throw new AppError(
      "HA_INVALID_RESOURCE_ID",
      `Invalid ${domain} ID; expected ${domain === "script" ? "a lowercase Home Assistant slug" : "letters, numbers, underscores, or hyphens"}`,
      { details: { domain, id: typeof id === "string" ? id : String(id) } },
    );
  }
  return id;
}

export function assertEntityId(domain: ResourceDomain, entityId: string): string {
  const prefix = `${domain}.`;
  const objectId = entityId.startsWith(prefix) ? entityId.slice(prefix.length) : "";
  if (
    entityId.length > MAX_IDENTIFIER_LENGTH ||
    !entityId.startsWith(prefix) ||
    !SLUG_PATTERN.test(objectId)
  ) {
    throw new AppError(
      "HA_INVALID_ENTITY_ID",
      `Invalid ${domain} entity ID; expected ${domain}.<lowercase_slug>`,
      { details: { domain, entity_id: entityId } },
    );
  }
  return entityId;
}

export function assertRunId(runId: string): string {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.length > MAX_IDENTIFIER_LENGTH ||
    !RESOURCE_ID_PATTERN.test(runId)
  ) {
    throw new AppError("HA_INVALID_TRACE_ID", "Invalid trace run ID", {
      details: { run_id: typeof runId === "string" ? runId : String(runId) },
    });
  }
  return runId;
}

export function editorPath(domain: ResourceDomain, id: string): string {
  return `/api/config/${domain}/config/${encodeURIComponent(assertResourceId(domain, id))}`;
}

export function cloneConfig(value: unknown, label = "config"): ResourceConfig {
  assertJsonValue(value, label, new Set<object>());
  if (!isRecord(value)) {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", `${label} must be a JSON object`);
  }
  return JSON.parse(JSON.stringify(value)) as ResourceConfig;
}

export async function listRuntimeResources(
  client: HomeAssistantClient,
  domain: ResourceDomain,
): Promise<RuntimeResource[]> {
  return runtimeResourcesFromStates(await client.getStates(), domain);
}

export function runtimeResourcesFromStates(
  states: EntityState[],
  domain: ResourceDomain,
): RuntimeResource[] {
  const prefix = `${domain}.`;
  return states
    .filter((state) => state.entity_id.startsWith(prefix))
    .map((state) => runtimeResourceFromState(state, domain))
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
}

export async function readResource<T extends ResourceConfig = ResourceConfig>(
  client: HomeAssistantClient,
  domain: ResourceDomain,
  id: string,
): Promise<ResourceReadResult<T>> {
  const validId = assertResourceId(domain, id);
  const states = await client.getStates();
  const resources = runtimeResourcesFromStates(states, domain);
  const runtime = resources.find((resource) => resource.config_id === validId) ?? null;
  const adapter = new HomeAssistantEditorRestAdapter(client);

  let source: "rest" | "websocket" = "rest";
  let config: ResourceConfig;
  try {
    config = await adapter.get(domain, validId);
  } catch (error) {
    if (!isNotFound(error) || domain === "scene") throw error;
    if (runtime === null) throw error;
    const response = await client.wsCommand<unknown>({
      type: `${domain}/config`,
      entity_id: runtime.entity_id,
    });
    if (!isRecord(response) || !Object.hasOwn(response, "config")) {
      throw new AppError(
        "HA_INVALID_RESPONSE",
        `Home Assistant returned an invalid ${domain} WebSocket config response`,
      );
    }
    config = cloneConfig(response.config, `${domain} WebSocket config`);
    source = "websocket";
  }

  return {
    domain,
    id: validId,
    source,
    config: config as T,
    runtime,
    relationships: extractRelationships(config, validId, runtime, states),
  };
}

export async function validateConfigFragments(
  client: HomeAssistantClient,
  fragments: ConfigFragments,
): Promise<ValidationReport> {
  const command: Record<string, unknown> = { type: "validate_config" };
  const requested: Array<"triggers" | "conditions" | "actions"> = [];
  for (const field of ["triggers", "conditions", "actions"] as const) {
    if (fragments[field] !== undefined) {
      assertJsonValue(fragments[field], field, new Set<object>());
      command[field] = fragments[field];
      requested.push(field);
    }
  }
  if (requested.length === 0) {
    throw new AppError(
      "HA_INVALID_VALIDATION_REQUEST",
      "At least one of triggers, conditions, or actions is required",
    );
  }

  const response = await client.wsCommand<unknown>(command as { type: string });
  if (!isRecord(response)) {
    throw new AppError("HA_INVALID_RESPONSE", "Home Assistant returned invalid validation data");
  }

  const fields: ValidationReport["fields"] = {};
  for (const field of requested) {
    const result = response[field];
    if (!isRecord(result) || typeof result.valid !== "boolean") {
      throw new AppError(
        "HA_INVALID_RESPONSE",
        `Home Assistant omitted the ${field} validation result`,
      );
    }
    fields[field] = {
      valid: result.valid,
      error: typeof result.error === "string" ? result.error : null,
    };
  }
  return {
    valid: requested.every((field) => fields[field]?.valid === true),
    source: "websocket",
    fields,
  };
}

export function localValidation(valid: boolean, error: string | null = null): ValidationReport {
  return {
    valid,
    source: "local",
    fields: { config: { valid, error } },
  };
}

export function jsonDiff(
  before: ResourceConfig | null,
  after: ResourceConfig | null,
): JsonDiffEntry[] {
  if (before === null && after !== null)
    return [{ op: "add", path: "", after: toJsonValue(after) }];
  if (before !== null && after === null) {
    return [{ op: "remove", path: "", before: toJsonValue(before) }];
  }
  const entries: JsonDiffEntry[] = [];
  diffValue(before, after, "", entries);
  return entries;
}

export async function mutateResource(
  client: HomeAssistantClient,
  domain: ResourceDomain,
  operation: MutationOperation,
  id: string,
  config: ResourceConfig | undefined,
  options: MutationOptions = {},
  validate?: ConfigValidator,
): Promise<MutationResult> {
  const validId = assertResourceId(domain, id);
  const dryRun = options.dryRun === true;
  const verifyAttempts = boundedInteger(
    options.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS,
    1,
    20,
    "verification attempts",
  );
  const verifyDelayMs = boundedInteger(
    options.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS,
    0,
    5_000,
    "verification delay",
  );
  const requestedEntityId =
    options.entityId === undefined ? undefined : assertEntityId(domain, options.entityId);
  const adapter = new HomeAssistantEditorRestAdapter(client);
  const statesBefore = await client.getStates();
  const runtimeBefore = findRuntimeResource(statesBefore, domain, validId);
  if (
    requestedEntityId !== undefined &&
    runtimeBefore !== null &&
    runtimeBefore.entity_id !== requestedEntityId
  ) {
    throw new AppError(
      "HA_RESOURCE_ID_MISMATCH",
      `${validId} belongs to ${runtimeBefore.entity_id}, not ${requestedEntityId}`,
      {
        details: {
          domain,
          id: validId,
          entity_id: requestedEntityId,
          actual_entity_id: runtimeBefore.entity_id,
        },
      },
    );
  }
  const before = await readEditorConfigOrNull(adapter, domain, validId);

  if (operation === "create" && (before !== null || runtimeBefore !== null)) {
    throw new AppError("HA_RESOURCE_CONFLICT", `${domain} ${validId} already exists`, {
      details: {
        domain,
        id: validId,
        editor_config_present: before !== null,
        entity_id: runtimeBefore?.entity_id ?? null,
      },
    });
  }
  if (operation !== "create" && before === null) {
    throw new AppError(
      runtimeBefore === null ? "HA_NOT_FOUND" : "HA_RESOURCE_NOT_EDITABLE",
      runtimeBefore === null
        ? `${domain} ${validId} was not found`
        : `${domain} ${validId} is running but is not managed by the editor endpoint`,
      { details: { domain, id: validId, entity_id: runtimeBefore?.entity_id ?? null } },
    );
  }
  if (
    operation === "create" &&
    requestedEntityId !== undefined &&
    runtimeResourcesFromStates(statesBefore, domain).some(
      (resource) => resource.entity_id === requestedEntityId,
    )
  ) {
    throw new AppError(
      "HA_RESOURCE_CONFLICT",
      `${requestedEntityId} already belongs to another ${domain}`,
      { details: { domain, id: validId, entity_id: requestedEntityId } },
    );
  }

  let after: ResourceConfig | null = null;
  if (operation !== "delete") {
    if (config === undefined) {
      throw new AppError("HA_INVALID_RESOURCE_CONFIG", `${operation} requires a config object`);
    }
    after = expectedStoredConfig(domain, validId, cloneConfig(config, `${domain} config`));
  } else if (config !== undefined) {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", "delete does not accept a config object");
  }

  const diff = jsonDiff(before, after);
  const changed = diff.length > 0;
  let validation: ValidationReport | null = null;
  if (after !== null && validate !== undefined) {
    validation = await validate(after);
    if (!validation.valid) {
      throw new AppError("HA_CONFIG_VALIDATION_FAILED", `${domain} config validation failed`, {
        details: toJsonValue(validation),
      });
    }
  }

  const entityId =
    runtimeBefore?.entity_id ?? requestedEntityId ?? inferredEntityId(domain, validId);
  const emptyRollback = rollbackResult(false, null, false, null);
  if (dryRun || !changed) {
    return {
      domain,
      id: validId,
      entity_id: entityId ?? null,
      operation,
      dry_run: dryRun,
      changed,
      applied: false,
      checkpointed: false,
      diff,
      validation,
      reload: { triggered_by: "none", explicit_reload: false },
      verification: null,
      rollback: emptyRollback,
    };
  }

  let checkpointed = false;
  const checkpoint: MutationCheckpoint = {
    domain,
    id: validId,
    operation,
    created_at: new Date().toISOString(),
    before: before === null ? null : cloneConfig(before),
    after: after === null ? null : cloneConfig(after),
    diff: cloneDiff(diff),
  };
  if (options.checkpoint !== undefined) {
    try {
      await options.checkpoint(checkpoint);
      checkpointed = true;
    } catch (error) {
      throw new AppError("HA_CHECKPOINT_FAILED", `Checkpoint failed; ${domain} was not changed`, {
        details: toJsonValue({
          domain,
          id: validId,
          operation,
          error: errorSummary(error),
        }),
        cause: error,
      });
    }
  }

  let verification: VerificationResult | null = null;
  let mutationRequested = false;
  try {
    const currentBeforeApply = await readEditorConfigOrNull(adapter, domain, validId);
    if (!deepEqual(currentBeforeApply, before)) {
      throw new AppError(
        "HA_RESOURCE_CONFLICT",
        `${domain} ${validId} changed after it was read; mutation was not applied`,
        { details: { domain, id: validId, operation } },
      );
    }
    mutationRequested = true;
    if (operation === "delete") await adapter.delete(domain, validId);
    else await adapter.post(domain, validId, after!);

    verification = await verifyMutation(
      client,
      adapter,
      domain,
      validId,
      operation,
      after,
      entityId,
      operation === "create" || runtimeBefore !== null,
      verifyAttempts,
      verifyDelayMs,
    );
    if (!verification.ok) {
      throw new AppError("HA_RESOURCE_VERIFICATION_FAILED", `${domain} verification failed`, {
        details: toJsonValue(verification),
      });
    }
    if (options.postApply !== undefined) await options.postApply(checkpoint);
  } catch (error) {
    const rollback = mutationRequested
      ? await rollbackMutation(adapter, domain, validId, operation, before, after)
      : rollbackResult(false, null, true, null);
    throw new AppError("HA_RESOURCE_MUTATION_FAILED", `${operation} ${domain} ${validId} failed`, {
      details: toJsonValue({
        domain,
        id: validId,
        operation,
        diff: toJsonValue(diff),
        failure: errorSummary(error),
        verification: verification === null ? null : toJsonValue(verification),
        rollback: toJsonValue(rollback),
      }),
      retryable: error instanceof AppError && error.retryable && rollback.succeeded,
      cause: error,
    });
  }

  return {
    domain,
    id: validId,
    entity_id: verification.entity.entity_id ?? entityId ?? null,
    operation,
    dry_run: false,
    changed: true,
    applied: true,
    checkpointed,
    diff,
    validation,
    reload: { triggered_by: "editor", explicit_reload: false },
    verification,
    rollback: emptyRollback,
  };
}

export async function callResourceService<T = unknown>(
  client: HomeAssistantClient,
  domain: ResourceDomain,
  service: string,
  data: ResourceConfig = {},
  entityId?: string,
): Promise<ControlResult<T>> {
  const validEntityId = entityId === undefined ? undefined : assertEntityId(domain, entityId);
  const body = cloneConfig(data, `${domain}.${service} service data`);
  if (validEntityId !== undefined) body.entity_id = validEntityId;
  const response = await client.callService<T>(domain, service, body);
  return {
    domain,
    service,
    entity_id: validEntityId ?? null,
    response,
  };
}

export async function listTraces(
  client: HomeAssistantClient,
  domain: TraceDomain,
  itemId: string,
): Promise<TraceSummary[]> {
  const id = assertResourceId(domain, itemId);
  const response = await client.wsCommand<unknown>({
    type: "trace/list",
    domain,
    item_id: id,
  });
  if (!Array.isArray(response)) {
    throw new AppError("HA_INVALID_RESPONSE", "Home Assistant returned an invalid trace list");
  }
  return response.map((trace, index) => normalizeTraceSummary(trace, domain, id, index));
}

export async function getTrace(
  client: HomeAssistantClient,
  domain: TraceDomain,
  itemId: string,
  runId: string,
): Promise<TraceReadResult> {
  const id = assertResourceId(domain, itemId);
  const run = assertRunId(runId);
  const response = await client.wsCommand<unknown>({
    type: "trace/get",
    domain,
    item_id: id,
    run_id: run,
  });
  if (!isRecord(response)) {
    throw new AppError("HA_INVALID_RESPONSE", "Home Assistant returned invalid trace details");
  }
  const trace = response as TraceDetails;
  return { trace, explanation: explainTraceFailure(trace) };
}

export async function getLastTrace(
  client: HomeAssistantClient,
  domain: TraceDomain,
  itemId: string,
): Promise<TraceReadResult | null> {
  const traces = await listTraces(client, domain, itemId);
  if (traces.length === 0) return null;
  const last = [...traces].sort(compareTraces)[0]!;
  return getTrace(client, domain, itemId, last.run_id);
}

export function explainTraceFailure(trace: TraceDetails): TraceFailureExplanation {
  const execution = typeof trace.script_execution === "string" ? trace.script_execution : "";
  const lastStep = typeof trace.last_step === "string" ? trace.last_step : null;
  const diagnostics = collectTraceDiagnostics(trace);
  const firstDiagnostic = diagnostics[0]?.message;
  const notTriggeredReason = findNotTriggeredReason(trace);

  const outcomes: Record<
    string,
    { outcome: TraceFailureExplanation["outcome"]; code: string; summary: string }
  > = {
    finished: { outcome: "succeeded", code: "finished", summary: "Execution finished" },
    failed_conditions: {
      outcome: "failed",
      code: "condition_failed",
      summary: "A condition prevented execution",
    },
    failed_single: {
      outcome: "failed",
      code: "single_mode_busy",
      summary: "Execution was rejected because single mode was already running",
    },
    failed_max_runs: {
      outcome: "failed",
      code: "max_runs_exceeded",
      summary: "Execution was rejected because the maximum run count was reached",
    },
    aborted: { outcome: "failed", code: "aborted", summary: "Execution was aborted" },
    error: { outcome: "failed", code: "execution_error", summary: "Execution failed" },
    cancelled: { outcome: "failed", code: "cancelled", summary: "Execution was cancelled" },
    not_triggered: {
      outcome: "not_triggered",
      code: notTriggeredReason ?? "not_triggered",
      summary: notTriggeredReason
        ? `Trigger did not run: ${notTriggeredReason}`
        : "Trigger evaluated but did not run",
    },
  };
  let selected = outcomes[execution];
  if (selected === undefined && trace.state === "running") {
    selected = { outcome: "running", code: "running", summary: "Execution is still running" };
  }
  selected ??= {
    outcome: diagnostics.length > 0 ? "failed" : "unknown",
    code: diagnostics.length > 0 ? "trace_error" : "unknown",
    summary: diagnostics.length > 0 ? "Execution recorded an error" : "Trace outcome is unknown",
  };

  const appendDiagnostic = selected.outcome === "failed" && firstDiagnostic !== undefined;
  return {
    outcome: selected.outcome,
    code: selected.code,
    summary: appendDiagnostic ? `${selected.summary}: ${firstDiagnostic}` : selected.summary,
    last_step: lastStep,
    diagnostics,
  };
}

function runtimeResourceFromState(state: EntityState, domain: ResourceDomain): RuntimeResource {
  const objectId = state.entity_id.slice(domain.length + 1);
  const attributeId = state.attributes.id;
  const candidateId =
    domain === "script" ? objectId : typeof attributeId === "string" ? attributeId : null;
  const configId =
    candidateId !== null && isValidResourceId(domain, candidateId) ? candidateId : null;
  return {
    domain,
    entity_id: state.entity_id,
    object_id: objectId,
    config_id: configId,
    editable: configId !== null,
    state: state.state,
    name:
      typeof state.attributes.friendly_name === "string" ? state.attributes.friendly_name : null,
    last_triggered:
      typeof state.attributes.last_triggered === "string" ? state.attributes.last_triggered : null,
    last_changed: state.last_changed,
    last_updated: state.last_updated,
    attributes: state.attributes,
  };
}

function extractRelationships(
  config: ResourceConfig,
  configId: string,
  runtime: RuntimeResource | null,
  states: EntityState[],
): ResourceRelationships {
  const relationships = {
    entities: new Set<string>(),
    devices: new Set<string>(),
    areas: new Set<string>(),
    floors: new Set<string>(),
    labels: new Set<string>(),
  };
  collectRelationships(config, undefined, relationships);
  const stateResources = states
    .map((state) => {
      const separator = state.entity_id.indexOf(".");
      const domain = state.entity_id.slice(0, separator);
      if (domain !== "automation" && domain !== "script" && domain !== "scene") return null;
      return runtimeResourceFromState(state, domain);
    })
    .filter((resource): resource is RuntimeResource => resource !== null);
  const relatedConfigIds = [...relationships.entities]
    .map(
      (entityId) =>
        stateResources.find((resource) => resource.entity_id === entityId)?.config_id ?? null,
    )
    .filter((id): id is string => id !== null);

  return {
    config_id: configId,
    entity_id: runtime?.entity_id ?? null,
    entities: sorted(relationships.entities),
    devices: sorted(relationships.devices),
    areas: sorted(relationships.areas),
    floors: sorted(relationships.floors),
    labels: sorted(relationships.labels),
    related_config_ids: [...new Set(relatedConfigIds)].sort(),
  };
}

function collectRelationships(
  value: unknown,
  key: string | undefined,
  output: {
    entities: Set<string>;
    devices: Set<string>;
    areas: Set<string>;
    floors: Set<string>;
    labels: Set<string>;
  },
): void {
  const target =
    key === "entity_id" || key === "entity_ids"
      ? output.entities
      : key === "device_id" || key === "device_ids"
        ? output.devices
        : key === "area_id" || key === "area_ids"
          ? output.areas
          : key === "floor_id" || key === "floor_ids"
            ? output.floors
            : key === "label_id" || key === "label_ids"
              ? output.labels
              : undefined;
  if (target !== undefined) {
    for (const item of typeof value === "string" ? [value] : Array.isArray(value) ? value : []) {
      if (typeof item === "string" && item.length > 0) target.add(item);
    }
  }
  if (key === "entities" && isRecord(value)) {
    for (const entityId of Object.keys(value)) {
      if (isGenericEntityId(entityId)) output.entities.add(entityId);
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRelationships(item, key, output);
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      collectRelationships(child, childKey, output);
    }
  }
}

function expectedStoredConfig(
  domain: ResourceDomain,
  id: string,
  config: ResourceConfig,
): ResourceConfig {
  if (domain === "script") return config;
  if (config.id !== undefined && config.id !== id) {
    throw new AppError("HA_RESOURCE_ID_MISMATCH", `Config ID does not match ${domain} path ID`, {
      details: { domain, path_id: id, config_id: toJsonValue(config.id) },
    });
  }
  return { ...config, id };
}

async function readEditorConfigOrNull(
  adapter: HomeAssistantEditorRestAdapter,
  domain: ResourceDomain,
  id: string,
): Promise<ResourceConfig | null> {
  try {
    return await adapter.get(domain, id);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function verifyMutation(
  client: HomeAssistantClient,
  adapter: HomeAssistantEditorRestAdapter,
  domain: ResourceDomain,
  id: string,
  operation: MutationOperation,
  expectedConfig: ResourceConfig | null,
  entityId: string | undefined,
  requireEntityPresence: boolean,
  maxAttempts: number,
  delayMs: number,
): Promise<VerificationResult> {
  let result: VerificationResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let observedConfig: ResourceConfig | null | undefined;
    let configError: ErrorSummary | null = null;
    try {
      observedConfig = await readEditorConfigOrNull(adapter, domain, id);
    } catch (error) {
      configError = errorSummary(error);
      observedConfig = undefined;
    }

    let runtime: RuntimeResource | null | undefined;
    let entityError: ErrorSummary | null = null;
    try {
      runtime = findRuntimeResource(await client.getStates(), domain, id, entityId);
    } catch (error) {
      entityError = errorSummary(error);
      runtime = undefined;
    }

    const expectedAbsent = operation === "delete";
    const configMatches = expectedAbsent
      ? observedConfig === null
      : observedConfig !== undefined &&
        observedConfig !== null &&
        expectedConfig !== null &&
        deepEqual(observedConfig, expectedConfig);
    const entityExpected = expectedAbsent
      ? "absent"
      : requireEntityPresence
        ? "present"
        : "not_required";
    const entityMatches =
      entityExpected === "not_required" ||
      (entityExpected === "present" ? runtime !== undefined && runtime !== null : runtime === null);
    result = {
      ok: configMatches && entityMatches,
      attempts: attempt,
      config: {
        expected: expectedAbsent ? "absent" : "present",
        observed:
          observedConfig === undefined ? "unknown" : observedConfig === null ? "absent" : "present",
        matches: configMatches,
        error: configError,
      },
      entity: {
        expected: entityExpected,
        observed: runtime === undefined ? "unknown" : runtime === null ? "absent" : "present",
        entity_id: runtime?.entity_id ?? entityId ?? null,
        matches: entityMatches,
        error: entityError,
      },
    };
    if (result.ok || attempt === maxAttempts) return result;
    await wait(delayMs);
  }
  return result!;
}

async function rollbackMutation(
  adapter: HomeAssistantEditorRestAdapter,
  domain: ResourceDomain,
  id: string,
  operation: MutationOperation,
  before: ResourceConfig | null,
  after: ResourceConfig | null,
): Promise<RollbackResult> {
  const action = before === null ? "delete_created" : "restore";
  try {
    const current = await readEditorConfigOrNull(adapter, domain, id);
    if (deepEqual(current, before)) return rollbackResult(false, null, true, null);
    if (!deepEqual(current, after)) {
      return rollbackResult(false, null, false, {
        code: "HA_ROLLBACK_CONFLICT",
        message: `${domain} changed concurrently; rollback did not overwrite it`,
        retryable: false,
      });
    }
    if (before === null) {
      await adapter.delete(domain, id);
    } else {
      await adapter.post(domain, id, before);
    }
    const restored = await readEditorConfigOrNull(adapter, domain, id);
    const succeeded = before === null ? restored === null : deepEqual(restored, before);
    return rollbackResult(
      true,
      operation === "create" ? "delete_created" : action,
      succeeded,
      succeeded
        ? null
        : {
            code: "HA_ROLLBACK_VERIFY_FAILED",
            message: "Rollback read-back differed",
            retryable: false,
          },
    );
  } catch (error) {
    return rollbackResult(true, action, false, errorSummary(error));
  }
}

function rollbackResult(
  attempted: boolean,
  action: RollbackResult["action"],
  succeeded: boolean,
  error: ErrorSummary | null,
): RollbackResult {
  return { attempted, action, succeeded, error };
}

function findRuntimeResource(
  states: EntityState[],
  domain: ResourceDomain,
  id: string,
  entityId?: string,
): RuntimeResource | null {
  const resources = runtimeResourcesFromStates(states, domain);
  return (
    resources.find((resource) =>
      entityId === undefined
        ? resource.config_id === id
        : resource.entity_id === entityId && resource.config_id === id,
    ) ?? null
  );
}

function inferredEntityId(domain: ResourceDomain, id: string): string | undefined {
  return domain === "script" ? `${domain}.${id}` : undefined;
}

function diffValue(before: unknown, after: unknown, path: string, entries: JsonDiffEntry[]): void {
  if (deepEqual(before, after)) return;
  if (before === undefined) {
    entries.push({ op: "add", path, after: toJsonValue(after) });
    return;
  }
  if (after === undefined) {
    entries.push({ op: "remove", path, before: toJsonValue(before) });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      diffValue(before[key], after[key], `${path}/${escapeJsonPointer(key)}`, entries);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffValue(before[index], after[index], `${path}/${index}`, entries);
    }
    return;
  }
  entries.push({ op: "replace", path, before: toJsonValue(before), after: toJsonValue(after) });
}

function cloneDiff(diff: JsonDiffEntry[]): JsonDiffEntry[] {
  return JSON.parse(JSON.stringify(diff)) as JsonDiffEntry[];
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function normalizeTraceSummary(
  value: unknown,
  domain: TraceDomain,
  itemId: string,
  index: number,
): TraceSummary {
  if (
    !isRecord(value) ||
    typeof value.run_id !== "string" ||
    !RESOURCE_ID_PATTERN.test(value.run_id)
  ) {
    throw new AppError("HA_INVALID_RESPONSE", `Invalid trace at list index ${index}`);
  }
  return { ...value, domain, item_id: itemId, run_id: value.run_id };
}

function compareTraces(left: TraceSummary, right: TraceSummary): number {
  const leftStart = typeof left.timestamp?.start === "string" ? left.timestamp.start : "";
  const rightStart = typeof right.timestamp?.start === "string" ? right.timestamp.start : "";
  const byTime = rightStart.localeCompare(leftStart);
  return byTime !== 0 ? byTime : right.run_id.localeCompare(left.run_id);
}

function collectTraceDiagnostics(trace: TraceDetails): TraceDiagnostic[] {
  const diagnostics: TraceDiagnostic[] = [];
  if (typeof trace.error === "string" && trace.error.length > 0) {
    diagnostics.push({ path: "$", kind: "error", message: trace.error });
  }
  if (isRecord(trace.trace)) {
    for (const path of Object.keys(trace.trace).sort()) {
      const steps = trace.trace[path];
      if (!Array.isArray(steps)) continue;
      steps.forEach((step, index) => {
        if (!isRecord(step)) return;
        if (typeof step.error === "string" && step.error.length > 0) {
          diagnostics.push({ path: `${path}[${index}]`, kind: "error", message: step.error });
        }
        if (Array.isArray(step.template_errors)) {
          step.template_errors.forEach((message, errorIndex) => {
            if (typeof message === "string" && message.length > 0) {
              diagnostics.push({
                path: `${path}[${index}].template_errors[${errorIndex}]`,
                kind: "template_error",
                message,
              });
            }
          });
        }
      });
    }
  }
  return diagnostics;
}

function findNotTriggeredReason(trace: TraceDetails): string | null {
  if (!isRecord(trace.trace)) return null;
  for (const path of Object.keys(trace.trace).sort()) {
    const steps = trace.trace[path];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step) || !isRecord(step.result)) continue;
      if (typeof step.result.reason === "string" && step.result.reason.length > 0) {
        return step.result.reason;
      }
    }
  }
  return null;
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", `${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", `${path} contains a circular reference`);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", `${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.code === "HA_NOT_FOUND";
}

function isValidResourceId(domain: ResourceDomain, id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_IDENTIFIER_LENGTH &&
    (domain === "script" ? SLUG_PATTERN : RESOURCE_ID_PATTERN).test(id)
  );
}

function isGenericEntityId(value: string): boolean {
  return /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value);
}

function errorSummary(error: unknown): ErrorSummary {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    if (value instanceof Error) return value.message;
    return "Unserializable value";
  }
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError(
      "HA_INVALID_REQUEST",
      `${label} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
