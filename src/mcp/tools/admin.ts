import { z } from "zod/v4";

import type { Application } from "../../app.js";
import { HELPER_TYPES } from "../../domains/helpers.js";
import type { IntegrationDetails, IntegrationUpdate } from "../../domains/integrations.js";
import type { AreaUpdate, DeviceUpdate, EntityUpdate } from "../../domains/registries.js";
import { AppError } from "../../shared/errors.js";
import {
  confirmationField,
  dryRunField,
  entityId,
  jsonObject,
  opaqueId,
  pageFields,
  resourceId,
} from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";
import { paginate } from "../../shared/types.js";

const identifier = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .describe("Lowercase Home Assistant identifier");
const scriptId = identifier.describe("Home Assistant script config ID");
const automationId = resourceId.describe("Home Assistant automation config ID");
const sceneId = resourceId.describe("Home Assistant scene config ID");
const helperType = z.enum(HELPER_TYPES).describe("Storage-backed Home Assistant helper type");
const registryId = opaqueId.describe("Home Assistant registry ID");
const integrationDomain = identifier.describe("Home Assistant integration domain");
const integrationEntryId = opaqueId.describe("Home Assistant config entry ID");
const traceDomain = z.enum(["automation", "script"]);
const traceItemId = resourceId.describe("Automation or script config ID");
const traceRunId = opaqueId.describe("Home Assistant trace run ID");
const HELPER_DRY_RUN_LIMITATIONS = [
  "home_assistant_internal_helper_mutation_api_not_called",
  "home_assistant_validation_not_performed",
] as const;
const REGISTRY_DRY_RUN_LIMITATIONS = [
  "home_assistant_internal_registry_mutation_api_not_called",
  "home_assistant_validation_not_performed",
] as const;
const CONFIG_ENTRY_DRY_RUN_LIMITATIONS = [
  "home_assistant_internal_config_entry_mutation_api_not_called",
  "home_assistant_validation_not_performed",
] as const;
const SERVER_GENERATED_ID_LIMITATION = "server_generated_id";
const HELPER_IDENTITY_FIELDS = new Set([
  "type",
  "id",
  "entity_id",
  "helper_type",
  "helper_id",
  ...HELPER_TYPES.map((type) => `${type}_id`),
]);
const automationEntityId = entityId.refine((value) => value.startsWith("automation."), {
  message: "Expected an automation entity ID",
});
const sceneEntityId = entityId.refine((value) => value.startsWith("scene."), {
  message: "Expected a scene entity ID",
});

const entityChanges = z
  .object({
    name: z.string().trim().min(1).max(255).nullable().optional(),
    icon: z.string().trim().min(1).max(255).nullable().optional(),
    area_id: registryId.nullable().optional(),
    disabled_by: z.enum(["user"]).nullable().optional(),
    hidden_by: z.enum(["user"]).nullable().optional(),
    labels: z.array(registryId).max(100).optional(),
    categories: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one entity registry field must be updated",
  });

const deviceChanges = z
  .object({
    name_by_user: z.string().trim().min(1).max(255).nullable().optional(),
    area_id: registryId.nullable().optional(),
    disabled_by: z.enum(["user"]).nullable().optional(),
    labels: z.array(registryId).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one device registry field must be updated",
  });

const areaFields = {
  name: z.string().trim().min(1).max(255),
  aliases: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
  floor_id: registryId.nullable().optional(),
  icon: z.string().trim().min(1).max(255).nullable().optional(),
  labels: z.array(registryId).max(100).optional(),
  picture: z.string().trim().min(1).max(2_048).nullable().optional(),
};

const areaChanges = z
  .object({
    name: areaFields.name.optional(),
    aliases: areaFields.aliases,
    floor_id: areaFields.floor_id,
    icon: areaFields.icon,
    labels: areaFields.labels,
    picture: areaFields.picture,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one area registry field must be updated",
  });

const integrationChanges = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    pref_disable_new_entities: z.boolean().optional(),
    pref_disable_polling: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one config-entry field must be updated",
  });

export function registerAdminTools(registrar: ToolRegistrar, app: Application): void {
  registerAutomationTools(registrar, app);
  registerTraceTools(registrar, app);
  registerScriptTools(registrar, app);
  registerSceneTools(registrar, app);
  registerHelperTools(registrar, app);
  registerEntityRegistryTools(registrar, app);
  registerDeviceRegistryTools(registrar, app);
  registerAreaRegistryTools(registrar, app);
  registerConfigEntryTools(registrar, app);
}

function registerAutomationTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "list_automations",
    title: "List Automations",
    description: "List Home Assistant automation entities and their editor config IDs.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "rest",
    stability: "public",
    handler: async ({ limit, offset }) => paginate(await app.automations.list(), { limit, offset }),
  });

  registrar.register({
    name: "get_automation",
    title: "Get Automation",
    description: "Get one automation config with runtime state and resource relationships.",
    risk: "READ",
    schema: z.object({ id: automationId }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: ({ id }) => app.automations.get(id),
  });

  registrar.register({
    name: "create_automation",
    title: "Create Automation",
    description: "Create an editor-managed automation after validating its configuration.",
    risk: "CONFIG",
    schema: z.object({
      id: automationId,
      config: jsonObject.describe("Complete automation configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("automation", id, dry_run);
      const operation = await app.automations.create(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "update_automation",
    title: "Update Automation",
    description: "Replace an editor-managed automation after validating the proposed config.",
    risk: "CONFIG",
    schema: z.object({
      id: automationId,
      config: jsonObject.describe("Complete replacement automation configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    idempotent: true,
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("automation", id, dry_run);
      const operation = await app.automations.update(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "delete_automation",
    title: "Delete Automation",
    description: "Delete an editor-managed automation with checkpoint and rollback protection.",
    risk: "HIGH_IMPACT",
    destructive: true,
    schema: z.object({
      id: automationId,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: async ({ id, dry_run }) => {
      const change = app.prepareResourceChange("automation", id, dry_run);
      const operation = await app.automations.delete(id, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "enable_automation",
    title: "Enable Automation",
    description: "Enable one automation entity through Home Assistant's automation service.",
    risk: "CONTROL",
    schema: z.object({ entity_id: automationEntityId, ...confirmationField }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "automation", entityId: entity_id }),
    idempotent: true,
    handler: ({ entity_id }) => app.automations.enable(entity_id),
  });

  registrar.register({
    name: "disable_automation",
    title: "Disable Automation",
    description: "Disable one automation entity through Home Assistant's automation service.",
    risk: "CONTROL",
    schema: z.object({ entity_id: automationEntityId, ...confirmationField }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "automation", entityId: entity_id }),
    idempotent: true,
    handler: ({ entity_id }) => app.automations.disable(entity_id),
  });

  registrar.register({
    name: "trigger_automation",
    title: "Trigger Automation",
    description: "Trigger one automation, optionally bypassing its conditions.",
    risk: "CONTROL",
    schema: z.object({
      entity_id: automationEntityId,
      skip_conditions: z.boolean().default(false),
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "automation", entityId: entity_id }),
    handler: ({ entity_id, skip_conditions }) =>
      app.automations.trigger(entity_id, { skipConditions: skip_conditions }),
  });

  registrar.register({
    name: "reload_automations",
    title: "Reload Automations",
    description: "Reload all Home Assistant automation configuration.",
    risk: "CONFIG",
    schema: z.object({ ...dryRunField, ...confirmationField }),
    source: "rest",
    stability: "public",
    authorize: () => ({ domain: "automation" }),
    handler: ({ dry_run }) =>
      dry_run
        ? { dry_run: true, changed: true, proposed: { domain: "automation", service: "reload" } }
        : app.automations.reload(),
  });

  registrar.register({
    name: "validate_automation",
    title: "Validate Automation",
    description: "Validate an automation configuration without storing or running it.",
    risk: "READ",
    schema: z.object({ config: jsonObject.describe("Automation configuration to validate") }),
    source: "websocket",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: ({ config }) => app.automations.validate(config),
  });
}

function registerTraceTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "get_automation_traces",
    title: "Get Automation Traces",
    description: "List retained execution and not-triggered traces for one automation config ID.",
    risk: "READ",
    schema: z.object({ automation_id: automationId }),
    source: "websocket",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: ({ automation_id }) => app.automations.listTraces(automation_id),
  });

  registrar.register({
    name: "get_automation_trace",
    title: "Get Automation Trace",
    description: "Get a retained automation trace with execution path, variables, and diagnostics.",
    risk: "READ",
    schema: z.object({ automation_id: automationId, run_id: traceRunId }),
    source: "websocket",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: ({ automation_id, run_id }) => app.automations.getTrace(automation_id, run_id),
  });

  registrar.register({
    name: "explain_automation_failure",
    title: "Explain Automation Failure",
    description:
      "Return deterministic structured diagnostics for an automation trace without using an embedded LLM.",
    risk: "READ",
    schema: z.object({ automation_id: automationId, run_id: traceRunId }),
    source: "derived",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: async ({ automation_id, run_id }) =>
      (await app.automations.getTrace(automation_id, run_id)).explanation,
  });

  registrar.register({
    name: "get_last_automation_run",
    title: "Get Last Automation Run",
    description: "Get the newest retained trace and deterministic outcome for one automation.",
    risk: "READ",
    schema: z.object({ automation_id: automationId }),
    source: "websocket",
    stability: "internal",
    authorize: () => ({ domain: "automation" }),
    handler: ({ automation_id }) => app.automations.getLastTrace(automation_id),
  });

  registrar.register({
    name: "get_trace",
    title: "Get Trace",
    description: "Get one automation or script trace and its derived failure explanation.",
    risk: "READ",
    schema: z.object({ domain: traceDomain, item_id: traceItemId, run_id: traceRunId }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    handler: ({ domain, item_id, run_id }) =>
      domain === "automation"
        ? app.automations.getTrace(item_id, run_id)
        : app.scripts.getTrace(item_id, run_id),
  });

  registrar.register({
    name: "list_traces",
    title: "List Traces",
    description: "List available execution traces for one automation or script.",
    risk: "READ",
    schema: z.object({ domain: traceDomain, item_id: traceItemId }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    handler: ({ domain, item_id }) =>
      domain === "automation"
        ? app.automations.listTraces(item_id)
        : app.scripts.listTraces(item_id),
  });

  registrar.register({
    name: "explain_trace",
    title: "Explain Trace",
    description: "Explain the outcome and diagnostics of one automation or script trace.",
    risk: "READ",
    schema: z.object({ domain: traceDomain, item_id: traceItemId, run_id: traceRunId }),
    source: "derived",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    handler: async ({ domain, item_id, run_id }) => {
      const result =
        domain === "automation"
          ? await app.automations.getTrace(item_id, run_id)
          : await app.scripts.getTrace(item_id, run_id);
      return result.explanation;
    },
  });

  registrar.register({
    name: "get_last_trace",
    title: "Get Last Trace",
    description: "Get the newest available execution trace for one automation or script.",
    risk: "READ",
    schema: z.object({ domain: traceDomain, item_id: traceItemId }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    handler: ({ domain, item_id }) =>
      domain === "automation"
        ? app.automations.getLastTrace(item_id)
        : app.scripts.getLastTrace(item_id),
  });
}

function registerScriptTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "list_scripts",
    title: "List Scripts",
    description: "List Home Assistant script entities and their editor config IDs.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "rest",
    stability: "public",
    handler: async ({ limit, offset }) => paginate(await app.scripts.list(), { limit, offset }),
  });

  registrar.register({
    name: "get_script",
    title: "Get Script",
    description: "Get one script config with runtime state and resource relationships.",
    risk: "READ",
    schema: z.object({ id: scriptId }),
    source: "config_api",
    stability: "internal",
    authorize: ({ id }) => ({ domain: "script", entityId: `script.${id}` }),
    handler: ({ id }) => app.scripts.get(id),
  });

  registrar.register({
    name: "create_script",
    title: "Create Script",
    description: "Create an editor-managed script after validating its configuration.",
    risk: "CONFIG",
    schema: z.object({
      id: scriptId,
      config: jsonObject.describe("Complete script configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: ({ id }) => ({ domain: "script", entityId: `script.${id}` }),
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("script", id, dry_run);
      const operation = await app.scripts.create(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "update_script",
    title: "Update Script",
    description: "Replace an editor-managed script after validating the proposed config.",
    risk: "CONFIG",
    schema: z.object({
      id: scriptId,
      config: jsonObject.describe("Complete replacement script configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: ({ id }) => ({ domain: "script", entityId: `script.${id}` }),
    idempotent: true,
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("script", id, dry_run);
      const operation = await app.scripts.update(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "delete_script",
    title: "Delete Script",
    description: "Delete an editor-managed script with checkpoint and rollback protection.",
    risk: "HIGH_IMPACT",
    destructive: true,
    schema: z.object({ id: scriptId, ...dryRunField, ...confirmationField }),
    source: "config_api",
    stability: "internal",
    authorize: ({ id }) => ({ domain: "script", entityId: `script.${id}` }),
    handler: async ({ id, dry_run }) => {
      const change = app.prepareResourceChange("script", id, dry_run);
      const operation = await app.scripts.delete(id, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "run_script_by_id",
    title: "Run Script By Config ID",
    description: "Run one script by config ID with an optional object of variables.",
    risk: "CONTROL",
    schema: z.object({
      id: scriptId,
      variables: jsonObject.default({}).describe("Variables made available to the script"),
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ id }) => ({ domain: "script", entityId: `script.${id}` }),
    handler: ({ id, variables }) => app.scripts.run(id, variables),
  });

  registrar.register({
    name: "reload_scripts",
    title: "Reload Scripts",
    description: "Reload all Home Assistant script configuration.",
    risk: "CONFIG",
    schema: z.object({ ...dryRunField, ...confirmationField }),
    source: "rest",
    stability: "public",
    authorize: () => ({ domain: "script" }),
    handler: ({ dry_run }) =>
      dry_run
        ? { dry_run: true, changed: true, proposed: { domain: "script", service: "reload" } }
        : app.scripts.reload(),
  });

  registrar.register({
    name: "validate_script",
    title: "Validate Script",
    description: "Validate a script configuration without storing or running it.",
    risk: "READ",
    schema: z.object({ config: jsonObject.describe("Script configuration to validate") }),
    source: "websocket",
    stability: "internal",
    authorize: () => ({ domain: "script" }),
    handler: ({ config }) => app.scripts.validate(config),
  });
}

function registerSceneTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "list_scenes",
    title: "List Scenes",
    description: "List Home Assistant scene entities and their editor config IDs.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "rest",
    stability: "public",
    handler: async ({ limit, offset }) => paginate(await app.scenes.list(), { limit, offset }),
  });

  registrar.register({
    name: "get_scene",
    title: "Get Scene",
    description: "Get one scene config with runtime state and resource relationships.",
    risk: "READ",
    schema: z.object({ id: sceneId }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "scene" }),
    handler: ({ id }) => app.scenes.get(id),
  });

  registrar.register({
    name: "create_scene",
    title: "Create Scene",
    description: "Create an editor-managed scene after validating its configuration.",
    risk: "CONFIG",
    schema: z.object({
      id: sceneId,
      config: jsonObject.describe("Complete scene configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "scene" }),
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("scene", id, dry_run);
      const operation = await app.scenes.create(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "update_scene",
    title: "Update Scene",
    description: "Replace an editor-managed scene after validating the proposed config.",
    risk: "CONFIG",
    schema: z.object({
      id: sceneId,
      config: jsonObject.describe("Complete replacement scene configuration"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "scene" }),
    idempotent: true,
    handler: async ({ id, config, dry_run }) => {
      const change = app.prepareResourceChange("scene", id, dry_run);
      const operation = await app.scenes.update(id, config, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "delete_scene",
    title: "Delete Scene",
    description: "Delete an editor-managed scene with checkpoint and rollback protection.",
    risk: "HIGH_IMPACT",
    destructive: true,
    schema: z.object({ id: sceneId, ...dryRunField, ...confirmationField }),
    source: "config_api",
    stability: "internal",
    authorize: () => ({ domain: "scene" }),
    handler: async ({ id, dry_run }) => {
      const change = app.prepareResourceChange("scene", id, dry_run);
      const operation = await app.scenes.delete(id, change.options);
      const safety = await change.finish(operation);
      return { operation, safety };
    },
  });

  registrar.register({
    name: "activate_scene_resource",
    title: "Activate Scene Resource",
    description: "Activate one scene entity with an optional transition duration.",
    risk: "CONTROL",
    schema: z.object({
      entity_id: sceneEntityId,
      transition: z.number().finite().min(0).optional(),
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "scene", entityId: entity_id }),
    handler: ({ entity_id, transition }) =>
      app.scenes.activate(entity_id, transition === undefined ? {} : { transition }),
  });

  registrar.register({
    name: "reload_scenes",
    title: "Reload Scenes",
    description: "Reload all Home Assistant scene configuration.",
    risk: "CONFIG",
    schema: z.object({ ...dryRunField, ...confirmationField }),
    source: "rest",
    stability: "public",
    authorize: () => ({ domain: "scene" }),
    handler: ({ dry_run }) =>
      dry_run
        ? { dry_run: true, changed: true, proposed: { domain: "scene", service: "reload" } }
        : app.scenes.reload(),
  });
}

function registerHelperTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "list_helpers",
    title: "List Helpers",
    description: "List storage-backed helpers of one supported helper type.",
    risk: "READ",
    schema: z.object({ helper_type: helperType, ...pageFields }),
    source: "websocket",
    stability: "internal",
    authorize: ({ helper_type }) => ({ domain: helper_type }),
    handler: async ({ helper_type, limit, offset }) =>
      paginate(await app.helpers.list(helper_type), { limit, offset }),
  });

  registrar.register({
    name: "get_helper",
    title: "Get Helper",
    description: "Get one storage-backed helper with registry and runtime state details.",
    risk: "READ",
    schema: z.object({ helper_type: helperType, id: identifier }),
    source: "websocket",
    stability: "internal",
    authorize: ({ helper_type, id }) => ({
      domain: helper_type,
      entityId: `${helper_type}.${id}`,
    }),
    handler: ({ helper_type, id }) => app.helpers.get(helper_type, id),
  });

  registrar.register({
    name: "create_helper",
    title: "Create Helper",
    description: "Create a storage-backed Home Assistant helper, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      helper_type: helperType,
      configuration: jsonObject.describe("Helper configuration accepted by Home Assistant"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ helper_type }) => ({ domain: helper_type }),
    handler: ({ helper_type, configuration, dry_run }) => {
      if (!dry_run) return app.helpers.create(helper_type, configuration);
      assertHelperConfigurationForDryRun(configuration, "create");
      return createDryRunPreview(configuration, [
        ...HELPER_DRY_RUN_LIMITATIONS,
        SERVER_GENERATED_ID_LIMITATION,
      ]);
    },
  });

  registrar.register({
    name: "update_helper",
    title: "Update Helper",
    description: "Update a storage-backed Home Assistant helper, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      helper_type: helperType,
      id: identifier,
      changes: jsonObject.describe("Helper fields to update"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ helper_type, id }) => ({
      domain: helper_type,
      entityId: `${helper_type}.${id}`,
    }),
    idempotent: true,
    handler: async ({ helper_type, id, changes, dry_run }) => {
      if (!dry_run) return app.helpers.update(helper_type, id, changes);
      assertHelperConfigurationForDryRun(changes, "update");
      const before = await app.helpers.get(helper_type, id);
      return updateDryRunPreview(before, changes, HELPER_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "delete_helper",
    title: "Delete Helper",
    description: "Delete a storage-backed Home Assistant helper, with optional dry-run preview.",
    risk: "HIGH_IMPACT",
    destructive: true,
    schema: z.object({
      helper_type: helperType,
      id: identifier,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ helper_type, id }) => ({
      domain: helper_type,
      entityId: `${helper_type}.${id}`,
    }),
    handler: async ({ helper_type, id, dry_run }) => {
      if (!dry_run) return app.helpers.delete(helper_type, id);
      const before = await app.helpers.get(helper_type, id);
      return deleteDryRunPreview(before, HELPER_DRY_RUN_LIMITATIONS);
    },
  });
}

function registerEntityRegistryTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "update_entity_registry",
    title: "Update Entity Registry Entry",
    description: "Update supported fields on one entity-registry entry, with dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entity_id: entityId,
      changes: entityChanges,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: async ({ entity_id, changes, dry_run }) => {
      const update = stripUndefined<EntityUpdate>(changes);
      if (!dry_run) return app.registries.updateEntity(entity_id, update);
      const before = await readEntityAndTargetArea(app, entity_id, update.area_id);
      return updateDryRunPreview(before, update, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "disable_entity",
    title: "Disable Entity Registry Entry",
    description: "Disable one entity-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({ entity_id: entityId, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: async ({ entity_id, dry_run }) => {
      if (!dry_run) return app.registries.disableEntity(entity_id);
      const before = await app.registries.getEntity(entity_id);
      return updateDryRunPreview(before, { disabled_by: "user" }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "enable_entity",
    title: "Enable Entity Registry Entry",
    description: "Enable one entity-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({ entity_id: entityId, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: async ({ entity_id, dry_run }) => {
      if (!dry_run) return app.registries.enableEntity(entity_id);
      const before = await app.registries.getEntity(entity_id);
      return updateDryRunPreview(before, { disabled_by: null }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "rename_entity",
    title: "Rename Entity Registry ID",
    description: "Rename an entity within its existing domain, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entity_id: entityId,
      new_entity_id: entityId,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    handler: async ({ entity_id, new_entity_id, dry_run }) => {
      if (!dry_run) return app.registries.renameEntity(entity_id, new_entity_id);
      return previewEntityRename(app, entity_id, new_entity_id);
    },
  });

  registrar.register({
    name: "move_entity_to_area",
    title: "Move Entity To Area",
    description: "Assign or unassign an entity's direct area, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entity_id: entityId,
      area_id: registryId.nullable().describe("Target area ID, or null to unassign"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: async ({ entity_id, area_id, dry_run }) => {
      if (!dry_run) return app.registries.moveEntity(entity_id, area_id);
      const before = await readEntityAndTargetArea(app, entity_id, area_id);
      return updateDryRunPreview(before, { area_id }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });
}

function registerDeviceRegistryTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "update_device",
    title: "Update Device Registry Entry",
    description: "Update supported fields on one device-registry entry, with dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      device_id: registryId,
      changes: deviceChanges,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, changes, dry_run }) => {
      const update = stripUndefined<DeviceUpdate>(changes);
      if (!dry_run) return app.registries.updateDevice(device_id, update);
      const before = await readDeviceAndTargetArea(app, device_id, update.area_id);
      return updateDryRunPreview(before, update, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "rename_device",
    title: "Rename Device",
    description: "Set or clear a device's user-defined name, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      device_id: registryId,
      name: z.string().trim().min(1).max(255).nullable(),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, name, dry_run }) => {
      if (!dry_run) return app.registries.renameDevice(device_id, name);
      const before = await app.registries.getDevice(device_id);
      return updateDryRunPreview(before, { name_by_user: name }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "move_device_to_area",
    title: "Move Device To Area",
    description: "Assign or unassign a device's area, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      device_id: registryId,
      area_id: registryId.nullable().describe("Target area ID, or null to unassign"),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, area_id, dry_run }) => {
      if (!dry_run) return app.registries.moveDevice(device_id, area_id);
      const before = await readDeviceAndTargetArea(app, device_id, area_id);
      return updateDryRunPreview(before, { area_id }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "disable_device",
    title: "Disable Device Registry Entry",
    description: "Disable one device-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({ device_id: registryId, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, dry_run }) => {
      if (!dry_run) return app.registries.disableDevice(device_id);
      const before = await app.registries.getDevice(device_id);
      return updateDryRunPreview(before, { disabled_by: "user" }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "enable_device",
    title: "Enable Device Registry Entry",
    description: "Enable one device-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({ device_id: registryId, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, dry_run }) => {
      if (!dry_run) return app.registries.enableDevice(device_id);
      const before = await app.registries.getDevice(device_id);
      return updateDryRunPreview(before, { disabled_by: null }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });
}

function registerAreaRegistryTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "create_area",
    title: "Create Area",
    description: "Create a Home Assistant area-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({ ...areaFields, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    handler: ({ name, aliases, floor_id, icon, labels, picture, dry_run }) => {
      const proposed = {
        name,
        ...(aliases === undefined ? {} : { aliases }),
        ...(floor_id === undefined ? {} : { floor_id }),
        ...(icon === undefined ? {} : { icon }),
        ...(labels === undefined ? {} : { labels }),
        ...(picture === undefined ? {} : { picture }),
      };
      if (!dry_run) return app.registries.createArea(proposed);
      return createDryRunPreview(proposed, [
        ...REGISTRY_DRY_RUN_LIMITATIONS,
        SERVER_GENERATED_ID_LIMITATION,
      ]);
    },
  });

  registrar.register({
    name: "update_area",
    title: "Update Area",
    description: "Update a Home Assistant area-registry entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      area_id: registryId,
      changes: areaChanges,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ area_id, changes, dry_run }) => {
      const update = stripUndefined<AreaUpdate>(changes);
      if (!dry_run) return app.registries.updateArea(area_id, update);
      const before = await app.registries.getArea(area_id);
      return updateDryRunPreview(before, update, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "delete_area",
    title: "Delete Area",
    description: "Delete a Home Assistant area-registry entry, with optional dry-run preview.",
    risk: "HIGH_IMPACT",
    destructive: true,
    schema: z.object({ area_id: registryId, ...dryRunField, ...confirmationField }),
    source: "websocket",
    stability: "internal",
    handler: async ({ area_id, dry_run }) => {
      if (!dry_run) return app.registries.deleteArea(area_id);
      const before = await app.registries.getArea(area_id);
      return deleteDryRunPreview(before, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "assign_device_to_area",
    title: "Assign Device To Area",
    description: "Assign one device-registry entry to an existing area, with dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      device_id: registryId,
      area_id: registryId,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    idempotent: true,
    handler: async ({ device_id, area_id, dry_run }) => {
      if (!dry_run) return app.registries.assignDeviceToArea(device_id, area_id);
      const before = await readDeviceAndTargetArea(app, device_id, area_id);
      return updateDryRunPreview(before, { area_id }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "assign_entity_to_area",
    title: "Assign Entity To Area",
    description: "Assign one entity-registry entry directly to an area, with dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entity_id: entityId,
      area_id: registryId,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: async ({ entity_id, area_id, dry_run }) => {
      if (!dry_run) return app.registries.assignEntityToArea(entity_id, area_id);
      const before = await readEntityAndTargetArea(app, entity_id, area_id);
      return updateDryRunPreview(before, { area_id }, REGISTRY_DRY_RUN_LIMITATIONS);
    },
  });
}

function registerConfigEntryTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "get_config_entries",
    title: "List Config Entries",
    description: "List Home Assistant config entries with their devices and entities.",
    risk: "READ",
    schema: z.object({ domain: integrationDomain.optional(), ...pageFields }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => (domain === undefined ? {} : { domain }),
    handler: async ({ domain, limit, offset }) =>
      paginate(await app.integrations.list(domain), { limit, offset }),
  });

  registrar.register({
    name: "get_config_entry",
    title: "Get Config Entry",
    description: "Get one Home Assistant config entry with its devices and entities.",
    risk: "READ",
    schema: z.object({ entry_id: integrationEntryId }),
    source: "websocket",
    stability: "internal",
    handler: ({ entry_id }) => app.integrations.get(entry_id),
  });

  registrar.register({
    name: "reload_config_entry",
    title: "Reload Config Entry",
    description: "Reload one Home Assistant config entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entry_id: integrationEntryId,
      domain: integrationDomain,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "rest",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    handler: async ({ entry_id, confirm, dry_run }) => {
      const before = await authorizeConfigEntry(app, "reload_config_entry", entry_id, confirm);
      if (dry_run) {
        return {
          dry_run: true,
          changed: false,
          before,
          proposed: { action: "reload", entry_id },
          limitations: ["reload_not_executed", "runtime_effects_not_predicted"],
        };
      }
      return app.integrations.reload(entry_id);
    },
  });

  registrar.register({
    name: "update_integration",
    title: "Update Integration",
    description: "Update supported config-entry preferences, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entry_id: integrationEntryId,
      domain: integrationDomain,
      changes: integrationChanges,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    idempotent: true,
    handler: async ({ entry_id, changes, confirm, dry_run }) => {
      const before = await authorizeConfigEntry(app, "update_integration", entry_id, confirm);
      const update = stripUndefined<IntegrationUpdate>(changes);
      if (!dry_run) return app.integrations.update(entry_id, update);
      return updateDryRunPreview(before, update, CONFIG_ENTRY_DRY_RUN_LIMITATIONS);
    },
  });

  registrar.register({
    name: "enable_integration",
    title: "Enable Integration",
    description: "Enable one Home Assistant config entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entry_id: integrationEntryId,
      domain: integrationDomain,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    idempotent: true,
    handler: async ({ entry_id, confirm, dry_run }) => {
      const before = await authorizeConfigEntry(app, "enable_integration", entry_id, confirm);
      if (dry_run) {
        return updateDryRunPreview(before, { disabled_by: null }, CONFIG_ENTRY_DRY_RUN_LIMITATIONS);
      }
      return app.integrations.enable(entry_id);
    },
  });

  registrar.register({
    name: "disable_integration",
    title: "Disable Integration",
    description: "Disable one Home Assistant config entry, with optional dry-run preview.",
    risk: "CONFIG",
    schema: z.object({
      entry_id: integrationEntryId,
      domain: integrationDomain,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "websocket",
    stability: "internal",
    authorize: ({ domain }) => ({ domain }),
    idempotent: true,
    handler: async ({ entry_id, confirm, dry_run }) => {
      const before = await authorizeConfigEntry(app, "disable_integration", entry_id, confirm);
      if (dry_run) {
        return updateDryRunPreview(
          before,
          { disabled_by: "user" },
          CONFIG_ENTRY_DRY_RUN_LIMITATIONS,
        );
      }
      return app.integrations.disable(entry_id);
    },
  });
}

async function authorizeConfigEntry(
  app: Application,
  operation: string,
  entryId: string,
  confirm: boolean,
): Promise<IntegrationDetails> {
  const entry = await app.integrations.get(entryId);
  app.policy.authorize({
    risk: "CONFIG",
    operation,
    confirm,
    domain: entry.domain,
  });
  return entry;
}

function createDryRunPreview(proposed: object, limitations: readonly string[]) {
  return {
    dry_run: true as const,
    changed: true,
    before: null,
    proposed,
    limitations: [...limitations],
  };
}

function updateDryRunPreview(before: object, changes: object, limitations: readonly string[]) {
  const after = { ...before, ...changes };
  return {
    dry_run: true as const,
    changed: !deepEqual(before, after),
    before,
    after,
    limitations: [...limitations],
  };
}

function deleteDryRunPreview(before: object, limitations: readonly string[]) {
  return {
    dry_run: true as const,
    changed: true,
    before,
    after: null,
    limitations: [...limitations],
  };
}

function assertHelperConfigurationForDryRun(
  configuration: Record<string, unknown>,
  operation: "create" | "update",
): void {
  const reserved = Object.keys(configuration)
    .filter((key) => HELPER_IDENTITY_FIELDS.has(key))
    .sort();
  if (reserved.length > 0) {
    throw new AppError("HA_INVALID_REQUEST", "Helper identity fields cannot be changed", {
      details: { reserved_fields: reserved },
    });
  }
  if (operation === "update" && Object.keys(configuration).length === 0) {
    throw new AppError("HA_INVALID_REQUEST", "At least one helper field must be updated");
  }
}

async function readEntityAndTargetArea(
  app: Application,
  entityId: string,
  areaId: string | null | undefined,
) {
  const [entity] = await Promise.all([
    app.registries.getEntity(entityId),
    areaId === undefined || areaId === null
      ? Promise.resolve(null)
      : app.registries.getArea(areaId),
  ]);
  return entity;
}

async function readDeviceAndTargetArea(
  app: Application,
  deviceId: string,
  areaId: string | null | undefined,
) {
  const [device] = await Promise.all([
    app.registries.getDevice(deviceId),
    areaId === undefined || areaId === null
      ? Promise.resolve(null)
      : app.registries.getArea(areaId),
  ]);
  return device;
}

async function previewEntityRename(app: Application, entityId: string, newEntityId: string) {
  if (entityId.split(".", 1)[0] !== newEntityId.split(".", 1)[0]) {
    throw new AppError(
      "ENTITY_DOMAIN_CHANGE_UNSUPPORTED",
      "An entity can be renamed only within its existing domain",
      { details: { entity_id: entityId, new_entity_id: newEntityId } },
    );
  }

  const [entities, states] = await Promise.all([
    app.registries.listEntities(),
    app.client.getStates(),
  ]);
  const before = entities.find((entry) => sameText(entry.entity_id, entityId));
  if (before === undefined) {
    throw new AppError("HA_NOT_FOUND", `Home Assistant entity ${entityId} was not found`, {
      details: { resource: "entity", id: entityId },
    });
  }
  if (
    !sameText(entityId, newEntityId) &&
    (entities.some((entry) => sameText(entry.entity_id, newEntityId)) ||
      states.some((state) => sameText(state.entity_id, newEntityId)))
  ) {
    throw new AppError("ENTITY_ID_CONFLICT", `Entity ${newEntityId} already exists`, {
      details: { entity_id: entityId, new_entity_id: newEntityId },
    });
  }
  return updateDryRunPreview(before, { entity_id: newEntityId }, REGISTRY_DRY_RUN_LIMITATIONS);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function stripUndefined<T extends object>(value: object): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}
