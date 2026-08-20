import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import {
  assertEntityId,
  callResourceService,
  getLastTrace,
  getTrace,
  listRuntimeResources,
  listTraces,
  localValidation,
  mutateResource,
  readResource,
  validateConfigFragments,
  type ConfigFragments,
  type ControlResult,
  type MutationOptions,
  type MutationResult,
  type ResourceConfig,
  type ResourceReadResult,
  type RuntimeResource,
  type TraceReadResult,
  type TraceSummary,
  type ValidationReport,
} from "./resources.js";

export interface AutomationConfig extends ResourceConfig {
  id?: string;
  alias?: string;
  description?: string;
  triggers?: unknown;
  conditions?: unknown;
  actions?: unknown;
  trigger?: unknown;
  condition?: unknown;
  action?: unknown;
  mode?: string;
  enabled?: boolean;
  use_blueprint?: Record<string, unknown>;
}

export interface TriggerAutomationOptions {
  skipConditions?: boolean;
}

export function listAutomations(client: HomeAssistantClient): Promise<RuntimeResource[]> {
  return listRuntimeResources(client, "automation");
}

export function getAutomation(
  client: HomeAssistantClient,
  id: string,
): Promise<ResourceReadResult<AutomationConfig>> {
  return readResource<AutomationConfig>(client, "automation", id);
}

export function validateAutomationFragments(
  client: HomeAssistantClient,
  fragments: ConfigFragments,
): Promise<ValidationReport> {
  return validateConfigFragments(client, fragments);
}

export function validateAutomation(
  client: HomeAssistantClient,
  config: AutomationConfig,
): Promise<ValidationReport> {
  const fragments = automationFragments(config);
  if (Object.keys(fragments).length === 0) {
    if (config.use_blueprint !== undefined) return Promise.resolve(localValidation(true));
    return Promise.resolve(
      localValidation(false, "Automation config must contain triggers and actions"),
    );
  }
  if (fragments.triggers === undefined || fragments.actions === undefined) {
    return Promise.resolve(
      localValidation(false, "Automation config must contain both triggers and actions"),
    );
  }
  return validateConfigFragments(client, fragments);
}

export function createAutomation(
  client: HomeAssistantClient,
  id: string,
  config: AutomationConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "automation", "create", id, config, options, (candidate) =>
    validateAutomation(client, candidate),
  );
}

export function updateAutomation(
  client: HomeAssistantClient,
  id: string,
  config: AutomationConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "automation", "update", id, config, options, (candidate) =>
    validateAutomation(client, candidate),
  );
}

export function deleteAutomation(
  client: HomeAssistantClient,
  id: string,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "automation", "delete", id, undefined, options);
}

export function enableAutomation(
  client: HomeAssistantClient,
  entityId: string,
): Promise<ControlResult> {
  return callResourceService(
    client,
    "automation",
    "turn_on",
    {},
    assertEntityId("automation", entityId),
  );
}

export function disableAutomation(
  client: HomeAssistantClient,
  entityId: string,
): Promise<ControlResult> {
  return callResourceService(
    client,
    "automation",
    "turn_off",
    {},
    assertEntityId("automation", entityId),
  );
}

export function triggerAutomation(
  client: HomeAssistantClient,
  entityId: string,
  options: TriggerAutomationOptions = {},
): Promise<ControlResult> {
  const data: ResourceConfig = {};
  if (options.skipConditions !== undefined) data.skip_condition = options.skipConditions;
  return callResourceService(
    client,
    "automation",
    "trigger",
    data,
    assertEntityId("automation", entityId),
  );
}

export function reloadAutomations(client: HomeAssistantClient): Promise<ControlResult> {
  return callResourceService(client, "automation", "reload");
}

export function listAutomationTraces(
  client: HomeAssistantClient,
  automationId: string,
): Promise<TraceSummary[]> {
  return listTraces(client, "automation", automationId);
}

export function getAutomationTrace(
  client: HomeAssistantClient,
  automationId: string,
  runId: string,
): Promise<TraceReadResult> {
  return getTrace(client, "automation", automationId, runId);
}

export function getLastAutomationTrace(
  client: HomeAssistantClient,
  automationId: string,
): Promise<TraceReadResult | null> {
  return getLastTrace(client, "automation", automationId);
}

export class AutomationAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  list(): Promise<RuntimeResource[]> {
    return listAutomations(this.client);
  }

  get(id: string): Promise<ResourceReadResult<AutomationConfig>> {
    return getAutomation(this.client, id);
  }

  validate(config: AutomationConfig): Promise<ValidationReport> {
    return validateAutomation(this.client, config);
  }

  create(
    id: string,
    config: AutomationConfig,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    return createAutomation(this.client, id, config, options);
  }

  update(
    id: string,
    config: AutomationConfig,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    return updateAutomation(this.client, id, config, options);
  }

  delete(id: string, options: MutationOptions = {}): Promise<MutationResult> {
    return deleteAutomation(this.client, id, options);
  }

  enable(entityId: string): Promise<ControlResult> {
    return enableAutomation(this.client, entityId);
  }

  disable(entityId: string): Promise<ControlResult> {
    return disableAutomation(this.client, entityId);
  }

  trigger(entityId: string, options: TriggerAutomationOptions = {}): Promise<ControlResult> {
    return triggerAutomation(this.client, entityId, options);
  }

  reload(): Promise<ControlResult> {
    return reloadAutomations(this.client);
  }

  listTraces(id: string): Promise<TraceSummary[]> {
    return listAutomationTraces(this.client, id);
  }

  getTrace(id: string, runId: string): Promise<TraceReadResult> {
    return getAutomationTrace(this.client, id, runId);
  }

  getLastTrace(id: string): Promise<TraceReadResult | null> {
    return getLastAutomationTrace(this.client, id);
  }
}

export function createAutomationAdministration(
  client: HomeAssistantClient,
): AutomationAdministration {
  return new AutomationAdministration(client);
}

function automationFragments(config: AutomationConfig): ConfigFragments {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new AppError("HA_INVALID_RESOURCE_CONFIG", "Automation config must be an object");
  }
  const fragments: ConfigFragments = {};
  const triggers = config.triggers ?? config.trigger;
  const conditions = config.conditions ?? config.condition;
  const actions = config.actions ?? config.action;
  if (triggers !== undefined) fragments.triggers = triggers;
  if (conditions !== undefined) fragments.conditions = conditions;
  if (actions !== undefined) fragments.actions = actions;
  return fragments;
}
