import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";
import {
  assertEntityId,
  callResourceService,
  localValidation,
  mutateResource,
  readResource,
  listRuntimeResources,
  type ControlResult,
  type MutationOptions,
  type MutationResult,
  type ResourceConfig,
  type ResourceReadResult,
  type RuntimeResource,
  type ValidationReport,
} from "./resources.js";

export interface SceneConfig extends ResourceConfig {
  id?: string;
  name?: string;
  icon?: string;
  entities?: Record<string, unknown>;
}

export interface ActivateSceneOptions {
  transition?: number;
}

export function listScenes(client: HomeAssistantClient): Promise<RuntimeResource[]> {
  return listRuntimeResources(client, "scene");
}

export function getScene(
  client: HomeAssistantClient,
  id: string,
): Promise<ResourceReadResult<SceneConfig>> {
  return readResource<SceneConfig>(client, "scene", id);
}

export function validateScene(config: SceneConfig): Promise<ValidationReport> {
  if (typeof config.name !== "string" || config.name.trim().length === 0) {
    return Promise.resolve(localValidation(false, "Scene config must contain a non-empty name"));
  }
  if (!isPlainRecord(config.entities)) {
    return Promise.resolve(localValidation(false, "Scene config must contain an entities object"));
  }
  for (const entityId of Object.keys(config.entities)) {
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
      return Promise.resolve(localValidation(false, `Invalid scene entity ID: ${entityId}`));
    }
  }
  return Promise.resolve(localValidation(true));
}

export function createScene(
  client: HomeAssistantClient,
  id: string,
  config: SceneConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "scene", "create", id, config, options, (candidate) =>
    validateScene(candidate),
  );
}

export function updateScene(
  client: HomeAssistantClient,
  id: string,
  config: SceneConfig,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "scene", "update", id, config, options, (candidate) =>
    validateScene(candidate),
  );
}

export function deleteScene(
  client: HomeAssistantClient,
  id: string,
  options: MutationOptions = {},
): Promise<MutationResult> {
  return mutateResource(client, "scene", "delete", id, undefined, options);
}

export function activateScene(
  client: HomeAssistantClient,
  entityId: string,
  options: ActivateSceneOptions = {},
): Promise<ControlResult> {
  const data: ResourceConfig = {};
  if (options.transition !== undefined) {
    if (!Number.isFinite(options.transition) || options.transition < 0) {
      throw new AppError(
        "HA_INVALID_REQUEST",
        "Scene transition must be a non-negative finite number",
      );
    }
    data.transition = options.transition;
  }
  return callResourceService(client, "scene", "turn_on", data, assertEntityId("scene", entityId));
}

export function reloadScenes(client: HomeAssistantClient): Promise<ControlResult> {
  return callResourceService(client, "scene", "reload");
}

export class SceneAdministration {
  constructor(private readonly client: HomeAssistantClient) {}

  list(): Promise<RuntimeResource[]> {
    return listScenes(this.client);
  }

  get(id: string): Promise<ResourceReadResult<SceneConfig>> {
    return getScene(this.client, id);
  }

  validate(config: SceneConfig): Promise<ValidationReport> {
    return validateScene(config);
  }

  create(id: string, config: SceneConfig, options: MutationOptions = {}): Promise<MutationResult> {
    return createScene(this.client, id, config, options);
  }

  update(id: string, config: SceneConfig, options: MutationOptions = {}): Promise<MutationResult> {
    return updateScene(this.client, id, config, options);
  }

  delete(id: string, options: MutationOptions = {}): Promise<MutationResult> {
    return deleteScene(this.client, id, options);
  }

  activate(entityId: string, options: ActivateSceneOptions = {}): Promise<ControlResult> {
    return activateScene(this.client, entityId, options);
  }

  reload(): Promise<ControlResult> {
    return reloadScenes(this.client);
  }
}

export function createSceneAdministration(client: HomeAssistantClient): SceneAdministration {
  return new SceneAdministration(client);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
