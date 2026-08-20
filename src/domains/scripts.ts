import type { HomeAssistantClient } from "../homeassistant/client.js";
import {
  assertResourceId,
  callResourceService,
  cloneConfig,
  getLastTrace,
  getTrace,
  listRuntimeResources,
  listTraces,
  localValidation,
  mutateResource,
  readResource,
  validateConfigFragments,
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

export interface ScriptConfig extends ResourceConfig {
  alias?: string;
  description?: string;
  sequence?: unknown;
  icon?: string;
  mode?: string;
  fields?: Record<string, unknown>;
  use_blueprint?: Record<string, unknown>;
}

export function listScripts(client: HomeAssistantClient): Promise<RuntimeResource[]> {
  return listRuntimeResources(client, "script");
}

export function getScript(
  client: HomeAssistantClient,
  id: string,
): Promise<ResourceReadResult<ScriptConfig>> {
  return readResource<ScriptConfig>(client, "script", id);
}

export function validateScriptActions(
  client: HomeAssistantClient,
  actions: unknown,
): Promise<ValidationReport> {
  return validateConfigFragments(client, { actions });
}

export function validateScript(
  client: HomeAssistantClient,
  config: ScriptConfig,
): Promise<ValidationReport> {
  if (config.sequence === undefined) {
    if (config.use_blueprint !== undefined) return Promise.resolve(localValidation(true));
    return Promise.resolve(localValidation(false, "Script config must contain a sequence"));
  }
  return validateScriptActions(client, config.sequence);
}

export function createScript(
  client: HomeAssistantClient,
  id: string,
  config: ScriptConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "script", "create", id, config, options, (candidate) =>
    validateScript(client, candidate),
  );
}

export function updateScript(
  client: HomeAssistantClient,
  id: string,
  config: ScriptConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "script", "update", id, config, options, (candidate) =>
    validateScript(client, candidate),
  );
}

export function deleteScript(
  client: HomeAssistantClient,
  id: string,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "script", "delete", id, undefined, options);
}

export function runScript(
  client: HomeAssistantClient,
  scriptId: string,
  variables: ResourceConfig = {},
): Promise<ControlResult> {
  const id = assertResourceId("script", scriptId);
  return callResourceService(client, "script", id, cloneConfig(variables, "script variables"));
}

export function reloadScripts(client: HomeAssistantClient): Promise<ControlResult> {
  return callResourceService(client, "script", "reload");
}

export function listScriptTraces(
  client: HomeAssistantClient,
  scriptId: string,
): Promise<TraceSummary[]> {
  return listTraces(client, "script", scriptId);
}

export function getScriptTrace(
  client: HomeAssistantClient,
  scriptId: string,
  runId: string,
): Promise<TraceReadResult> {
  return getTrace(client, "script", scriptId, runId);
}

export function getLastScriptTrace(
  client: HomeAssistantClient,
  scriptId: string,
): Promise<TraceReadResult | null> {
  return getLastTrace(client, "script", scriptId);
}

export class ScriptAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  list(): Promise<RuntimeResource[]> {
    return listScripts(this.client);
  }

  get(id: string): Promise<ResourceReadResult<ScriptConfig>> {
    return getScript(this.client, id);
  }

  validate(config: ScriptConfig): Promise<ValidationReport> {
    return validateScript(this.client, config);
  }

  create(id: string, config: ScriptConfig, options: MutationOptions = {}): Promise<MutationResult> {
    return createScript(this.client, id, config, options);
  }

  update(id: string, config: ScriptConfig, options: MutationOptions = {}): Promise<MutationResult> {
    return updateScript(this.client, id, config, options);
  }

  delete(id: string, options: MutationOptions = {}): Promise<MutationResult> {
    return deleteScript(this.client, id, options);
  }

  run(id: string, variables: ResourceConfig = {}): Promise<ControlResult> {
    return runScript(this.client, id, variables);
  }

  reload(): Promise<ControlResult> {
    return reloadScripts(this.client);
  }

  listTraces(id: string): Promise<TraceSummary[]> {
    return listScriptTraces(this.client, id);
  }

  getTrace(id: string, runId: string): Promise<TraceReadResult> {
    return getScriptTrace(this.client, id, runId);
  }

  getLastTrace(id: string): Promise<TraceReadResult | null> {
    return getLastScriptTrace(this.client, id);
  }
}

export function createScriptAdministration(client: HomeAssistantClient): ScriptAdministration {
  return new ScriptAdministration(client);
}
