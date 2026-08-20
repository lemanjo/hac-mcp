import { z } from "zod/v4";

import type { Application } from "../../app.js";
import { MAX_SERVICE_TARGETS_PER_KIND, type ServiceTarget } from "../../domains/control.js";
import { confirmationField, dryRunField, entityId, jsonObject, opaqueId } from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";
import type { Risk } from "../../shared/types.js";

const identifier = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .describe("Lowercase Home Assistant identifier");
const targetId = opaqueId.describe("Home Assistant registry target ID");

function oneOrMany<T extends z.ZodType<string>>(schema: T, label: string) {
  return z
    .union([schema, z.array(schema).min(1).max(MAX_SERVICE_TARGETS_PER_KIND)])
    .describe(`One ${label} or an array of up to ${MAX_SERVICE_TARGETS_PER_KIND}`);
}

const serviceTargetSchema = z
  .object({
    entity_id: oneOrMany(entityId, "entity ID").optional(),
    device_id: oneOrMany(targetId, "device ID").optional(),
    area_id: oneOrMany(targetId, "area ID").optional(),
    floor_id: oneOrMany(targetId, "floor ID").optional(),
    label_id: oneOrMany(targetId, "label ID").optional(),
  })
  .refine((target) => Object.values(target).some((value) => value !== undefined), {
    message: "At least one service target is required",
  })
  .describe("Home Assistant service target, kept separate from service_data");

type ParsedServiceTarget = z.infer<typeof serviceTargetSchema>;

function serviceTarget(input: ParsedServiceTarget): ServiceTarget {
  return {
    ...(input.entity_id === undefined ? {} : { entity_id: input.entity_id }),
    ...(input.device_id === undefined ? {} : { device_id: input.device_id }),
    ...(input.area_id === undefined ? {} : { area_id: input.area_id }),
    ...(input.floor_id === undefined ? {} : { floor_id: input.floor_id }),
    ...(input.label_id === undefined ? {} : { label_id: input.label_id }),
  };
}

const serviceData = jsonObject
  .default({})
  .describe("Service fields only; target IDs must be supplied through target");
const returnResponse = z
  .boolean()
  .default(false)
  .describe("Request response data from a service that declares response support");

function entityIds(target: ParsedServiceTarget | undefined): string[] {
  const value = target?.entity_id;
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

function targetAuthorization(
  serviceDomain: string,
  target: ParsedServiceTarget | undefined,
): { domain: string; entityIds?: string[] } {
  const targets = entityIds(target);
  return {
    domain: serviceDomain,
    ...(targets.length === 0 ? {} : { entityIds: targets }),
  };
}

function serviceRisk(domain: string, service: string): Risk {
  if (
    (domain === "homeassistant" && ["restart", "stop"].includes(service)) ||
    domain === "backup" ||
    (domain === "recorder" && (service === "purge" || service === "purge_entities"))
  ) {
    return "HIGH_IMPACT";
  }
  if (
    service === "reload" ||
    service.startsWith("reload_") ||
    domain === "logger" ||
    domain === "config"
  ) {
    return "CONFIG";
  }
  return "CONTROL";
}

export function registerControlTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "call_service",
    title: "Call Service",
    description:
      "Call one registered Home Assistant service after validating its live target and field definition.",
    risk: "CONTROL",
    destructive: true,
    schema: z.object({
      domain: identifier.describe("Service domain"),
      service: identifier.describe("Service name"),
      target: serviceTargetSchema.optional().describe("Optional service target"),
      service_data: serviceData,
      return_response: returnResponse,
      ...dryRunField,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    resolveRisk: ({ domain, service }) => serviceRisk(domain, service),
    authorize: ({ domain, target }) => targetAuthorization(domain, target),
    handler: async ({ domain, service, target, service_data, return_response, dry_run }) => {
      const request = {
        domain,
        service,
        data: service_data,
        returnResponse: return_response,
        ...(target === undefined ? {} : { target: serviceTarget(target) }),
      };
      if (!dry_run) return app.control.callService(request);
      return {
        dry_run: true,
        changed: true,
        proposed: await app.control.validateServiceCall(request),
        limitations: ["The service was validated against its live definition but was not called."],
      };
    },
  });

  registrar.register({
    name: "turn_on",
    title: "Turn On",
    description: "Turn on an explicit entity, device, area, floor, or label target.",
    risk: "CONTROL",
    schema: z.object({
      target: serviceTargetSchema,
      service_data: serviceData,
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ target }) => targetAuthorization("homeassistant", target),
    idempotent: true,
    handler: ({ target, service_data, return_response }) =>
      app.control.turnOn(serviceTarget(target), service_data, { returnResponse: return_response }),
  });

  registrar.register({
    name: "turn_off",
    title: "Turn Off",
    description: "Turn off an explicit entity, device, area, floor, or label target.",
    risk: "CONTROL",
    schema: z.object({
      target: serviceTargetSchema,
      service_data: serviceData,
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ target }) => targetAuthorization("homeassistant", target),
    idempotent: true,
    handler: ({ target, service_data, return_response }) =>
      app.control.turnOff(serviceTarget(target), service_data, { returnResponse: return_response }),
  });

  registrar.register({
    name: "toggle",
    title: "Toggle",
    description: "Toggle an explicit entity, device, area, floor, or label target.",
    risk: "CONTROL",
    schema: z.object({
      target: serviceTargetSchema,
      service_data: serviceData,
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ target }) => targetAuthorization("homeassistant", target),
    handler: ({ target, service_data, return_response }) =>
      app.control.toggle(serviceTarget(target), service_data, {
        returnResponse: return_response,
      }),
  });

  registrar.register({
    name: "set_value",
    title: "Set Value",
    description: "Call the target entity domain's set_value service with one JSON value.",
    risk: "CONTROL",
    schema: z.object({
      entity_id: entityId,
      value: z.json().describe("JSON value accepted by the entity domain's set_value service"),
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({
      domain: entity_id.split(".", 1)[0] ?? "",
      entityId: entity_id,
    }),
    idempotent: true,
    handler: ({ entity_id, value, return_response }) =>
      app.control.setValue(entity_id, value, { returnResponse: return_response }),
  });

  registrar.register({
    name: "set_temperature",
    title: "Set Temperature",
    description: "Set climate temperature targets and optional HVAC mode for an explicit target.",
    risk: "CONTROL",
    schema: z.object({
      target: serviceTargetSchema,
      temperature: z.number().finite().describe("Primary target temperature"),
      target_temperature_low: z.number().finite().optional().describe("Low target for a range"),
      target_temperature_high: z.number().finite().optional().describe("High target for a range"),
      hvac_mode: identifier.optional().describe("Optional HVAC mode to set with the temperature"),
      service_data: serviceData,
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ target }) => targetAuthorization("climate", target),
    idempotent: true,
    handler: ({
      target,
      temperature,
      target_temperature_low,
      target_temperature_high,
      hvac_mode,
      service_data,
      return_response,
    }) =>
      app.control.setTemperature(serviceTarget(target), temperature, {
        data: service_data,
        returnResponse: return_response,
        ...(target_temperature_low === undefined
          ? {}
          : { targetTemperatureLow: target_temperature_low }),
        ...(target_temperature_high === undefined
          ? {}
          : { targetTemperatureHigh: target_temperature_high }),
        ...(hvac_mode === undefined ? {} : { hvacMode: hvac_mode }),
      }),
  });

  registrar.register({
    name: "activate_scene",
    title: "Activate Scene",
    description:
      "Activate one scene entity with optional transition or other declared service data.",
    risk: "CONTROL",
    schema: z.object({
      entity_id: entityId.refine((value) => value.startsWith("scene."), {
        message: "Expected a scene entity ID",
      }),
      service_data: serviceData,
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "scene", entityId: entity_id }),
    handler: ({ entity_id, service_data, return_response }) =>
      app.control.activateScene(entity_id, service_data, { returnResponse: return_response }),
  });

  registrar.register({
    name: "run_script",
    title: "Run Script",
    description: "Run one script entity with an optional object of script variables.",
    risk: "CONTROL",
    schema: z.object({
      entity_id: entityId.refine((value) => value.startsWith("script."), {
        message: "Expected a script entity ID",
      }),
      variables: jsonObject.default({}).describe("Variables made available to the script"),
      return_response: returnResponse,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    authorize: ({ entity_id }) => ({ domain: "script", entityId: entity_id }),
    handler: ({ entity_id, variables, return_response }) =>
      app.control.runScript(entity_id, variables, { returnResponse: return_response }),
  });
}
