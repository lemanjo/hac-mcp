import type {
  HomeAssistantClient,
  HomeAssistantServiceDefinition,
  ServiceCallResponse,
} from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";

export const MAX_SERVICE_TARGETS_PER_KIND = 100;
export const MAX_SERVICE_DATA_FIELDS = 100;

export type TargetValue = string | readonly string[];

export interface ServiceTarget {
  entity_id?: TargetValue;
  device_id?: TargetValue;
  area_id?: TargetValue;
  floor_id?: TargetValue;
  label_id?: TargetValue;
}

export type ServiceTargetInput = ServiceTarget | string | readonly string[];

export interface SafeServiceCall {
  domain: string;
  service: string;
  target?: ServiceTarget;
  data?: Record<string, unknown>;
  returnResponse?: boolean;
}

export interface ValidatedServiceCall {
  domain: string;
  service: string;
  target: Record<string, string | string[]>;
  data: Record<string, unknown>;
  returnResponse: boolean;
  definition: HomeAssistantServiceDefinition;
}

export interface ControlCallOptions {
  returnResponse?: boolean;
}

export interface TemperatureOptions extends ControlCallOptions {
  hvacMode?: string;
  targetTemperatureLow?: number;
  targetTemperatureHigh?: number;
  data?: Record<string, unknown>;
}

const IDENTIFIER = /^[a-z0-9_]+$/;
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const TARGET_KEYS = new Set(["entity_id", "device_id", "area_id", "floor_id", "label_id"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function identifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) {
    throw new AppError("HA_INVALID_SERVICE_CALL", `Invalid Home Assistant ${label}`, {
      details: { value },
    });
  }
  return normalized;
}

function normalizeTargetValue(value: TargetValue, key: keyof ServiceTarget): string | string[] {
  const values = typeof value === "string" ? [value] : [...value];
  if (values.length === 0 || values.length > MAX_SERVICE_TARGETS_PER_KIND) {
    throw new AppError(
      "HA_INVALID_SERVICE_TARGET",
      `Service target ${key} must contain between 1 and ${MAX_SERVICE_TARGETS_PER_KIND} IDs`,
      { details: { target_key: key, target_count: values.length } },
    );
  }
  const normalized = values.map((item) => {
    const id = item.trim().toLowerCase();
    if (
      id.length === 0 ||
      id.length > 255 ||
      hasControlCharacter(id) ||
      (key === "entity_id" && !ENTITY_ID.test(id))
    ) {
      throw new AppError("HA_INVALID_SERVICE_TARGET", `Invalid ${key} service target`, {
        details: { target_key: key, target_value: item },
      });
    }
    return id;
  });
  const unique = [...new Set(normalized)];
  return typeof value === "string" ? unique[0]! : unique;
}

function normalizeTarget(target: ServiceTarget | undefined): Record<string, string | string[]> {
  if (target === undefined) return {};
  if (!isRecord(target)) {
    throw new AppError("HA_INVALID_SERVICE_TARGET", "Service target must be an object");
  }
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(target)) {
    if (!TARGET_KEYS.has(key) || value === undefined) {
      throw new AppError("HA_INVALID_SERVICE_TARGET", `Unsupported service target key: ${key}`, {
        details: { target_key: key },
      });
    }
    if (
      typeof value !== "string" &&
      !(Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      throw new AppError("HA_INVALID_SERVICE_TARGET", `Service target ${key} must contain IDs`);
    }
    result[key] = normalizeTargetValue(value, key as keyof ServiceTarget);
  }
  return result;
}

function targetFrom(input: ServiceTargetInput): ServiceTarget {
  if (typeof input === "string" || Array.isArray(input)) return { entity_id: input };
  return input as ServiceTarget;
}

function normalizedData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (data === undefined) return {};
  if (!isRecord(data)) {
    throw new AppError("HA_INVALID_SERVICE_DATA", "Service data must be an object");
  }
  const entries = Object.entries(data);
  if (entries.length > MAX_SERVICE_DATA_FIELDS) {
    throw new AppError(
      "HA_INVALID_SERVICE_DATA",
      `Service data cannot contain more than ${MAX_SERVICE_DATA_FIELDS} fields`,
      { details: { field_count: entries.length, maximum_fields: MAX_SERVICE_DATA_FIELDS } },
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (TARGET_KEYS.has(key)) {
      throw new AppError(
        "HA_SERVICE_TARGET_IN_DATA",
        `${key} must be supplied through the service target, not service data`,
        { details: { field: key } },
      );
    }
    if (FORBIDDEN_KEYS.has(key) || key.trim().length === 0) {
      throw new AppError("HA_INVALID_SERVICE_DATA", `Invalid service data field: ${key}`);
    }
    result[key] = value;
  }
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new TypeError("No JSON value");
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) throw new TypeError("Service data did not serialize to an object");
    return parsed;
  } catch (error) {
    throw new AppError("HA_INVALID_SERVICE_DATA", "Service data is not JSON serializable", {
      cause: error,
    });
  }
}

function validateAgainstDefinition(
  definition: HomeAssistantServiceDefinition,
  target: Readonly<Record<string, string | string[]>>,
  data: Readonly<Record<string, unknown>>,
  returnResponse: boolean,
): void {
  const targetKeys = Object.keys(target);
  if (targetKeys.length > 0 && definition.target === undefined) {
    throw new AppError(
      "HA_SERVICE_TARGET_UNSUPPORTED",
      "The live Home Assistant service definition does not accept a target",
      { details: { target_keys: targetKeys } },
    );
  }
  if (targetKeys.length === 0 && definition.target !== undefined) {
    throw new AppError(
      "HA_SERVICE_TARGET_REQUIRED",
      "A target is required for this Home Assistant service to avoid an all-entities call",
    );
  }

  const fields = definition.fields ?? {};
  const unknownFields = Object.keys(data).filter((key) => !Object.hasOwn(fields, key));
  if (unknownFields.length > 0) {
    throw new AppError(
      "HA_UNKNOWN_SERVICE_FIELD",
      "Service data contains fields absent from the live Home Assistant definition",
      { details: { fields: unknownFields } },
    );
  }
  const missingFields = Object.entries(fields).flatMap(([key, raw]): string[] => {
    if (!isRecord(raw) || raw.required !== true || Object.hasOwn(raw, "default")) return [];
    return Object.hasOwn(data, key) ? [] : [key];
  });
  if (missingFields.length > 0) {
    throw new AppError("HA_REQUIRED_SERVICE_FIELD", "Required service data fields are missing", {
      details: { fields: missingFields },
    });
  }

  const responseDefinition = definition.response;
  if (returnResponse && responseDefinition === undefined) {
    throw new AppError(
      "HA_SERVICE_RESPONSE_UNSUPPORTED",
      "The live Home Assistant service definition does not return response data",
    );
  }
  if (!returnResponse && isRecord(responseDefinition) && responseDefinition.optional !== true) {
    throw new AppError(
      "HA_SERVICE_RESPONSE_REQUIRED",
      "This Home Assistant service requires returnResponse",
    );
  }
}

/** Validated Home Assistant controls. Authorization policy belongs to the caller/MCP layer. */
export class ControlService {
  constructor(readonly client: HomeAssistantClient) {}

  callService<T = unknown>(input: SafeServiceCall): Promise<ServiceCallResponse<T>>;
  callService<T = unknown>(
    domain: string,
    service: string,
    target?: ServiceTarget,
    data?: Record<string, unknown>,
    options?: ControlCallOptions,
  ): Promise<ServiceCallResponse<T>>;
  async callService<T = unknown>(
    inputOrDomain: SafeServiceCall | string,
    serviceName?: string,
    target?: ServiceTarget,
    data?: Record<string, unknown>,
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse<T>> {
    const input: SafeServiceCall =
      typeof inputOrDomain === "string"
        ? {
            domain: inputOrDomain,
            service: serviceName ?? "",
            ...(target === undefined ? {} : { target }),
            ...(data === undefined ? {} : { data }),
            ...(options.returnResponse === undefined
              ? {}
              : { returnResponse: options.returnResponse }),
          }
        : inputOrDomain;
    const validated = await this.validateServiceCall(input);
    return this.client.callService<T>(
      validated.domain,
      validated.service,
      { ...validated.data, ...validated.target },
      { returnResponse: validated.returnResponse },
    );
  }

  async validateServiceCall(input: SafeServiceCall): Promise<ValidatedServiceCall> {
    const domain = identifier(input.domain, "service domain");
    const service = identifier(input.service, "service name");
    const targetData = normalizeTarget(input.target);
    const serviceData = normalizedData(input.data);
    const returnResponse = input.returnResponse ?? false;
    const domainDefinition = (await this.client.getServices()).find(
      (candidate) => candidate.domain === domain,
    );
    const definition = domainDefinition?.services[service];
    if (definition === undefined) {
      throw new AppError("HA_SERVICE_NOT_FOUND", "Home Assistant service is not registered", {
        details: { domain, service },
      });
    }
    validateAgainstDefinition(definition, targetData, serviceData, returnResponse);
    return {
      domain,
      service,
      target: targetData,
      data: serviceData,
      returnResponse,
      definition,
    };
  }

  turnOn(
    target: ServiceTargetInput,
    data: Record<string, unknown> = {},
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    return this.callService("homeassistant", "turn_on", targetFrom(target), data, options);
  }

  turnOff(
    target: ServiceTargetInput,
    data: Record<string, unknown> = {},
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    return this.callService("homeassistant", "turn_off", targetFrom(target), data, options);
  }

  toggle(
    target: ServiceTargetInput,
    data: Record<string, unknown> = {},
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    return this.callService("homeassistant", "toggle", targetFrom(target), data, options);
  }

  setValue(
    entityId: string,
    value: unknown,
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    const normalizedEntityId = entityId.trim().toLowerCase();
    if (!ENTITY_ID.test(normalizedEntityId)) {
      throw new AppError("HA_INVALID_SERVICE_TARGET", "Invalid entity ID for setValue", {
        details: { entity_id: entityId },
      });
    }
    const domain = normalizedEntityId.split(".", 1)[0]!;
    return this.callService(
      domain,
      "set_value",
      { entity_id: normalizedEntityId },
      { value },
      options,
    );
  }

  setTemperature(
    target: ServiceTargetInput,
    temperature: number,
    options: TemperatureOptions = {},
  ): Promise<ServiceCallResponse> {
    if (!Number.isFinite(temperature)) {
      throw new AppError("HA_INVALID_SERVICE_DATA", "Temperature must be a finite number");
    }
    for (const [name, value] of [
      ["targetTemperatureLow", options.targetTemperatureLow],
      ["targetTemperatureHigh", options.targetTemperatureHigh],
    ] as const) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new AppError("HA_INVALID_SERVICE_DATA", `${name} must be a finite number`);
      }
    }
    return this.callService(
      "climate",
      "set_temperature",
      targetFrom(target),
      {
        ...(options.data ?? {}),
        temperature,
        ...(options.hvacMode === undefined ? {} : { hvac_mode: options.hvacMode }),
        ...(options.targetTemperatureLow === undefined
          ? {}
          : { target_temp_low: options.targetTemperatureLow }),
        ...(options.targetTemperatureHigh === undefined
          ? {}
          : { target_temp_high: options.targetTemperatureHigh }),
      },
      options,
    );
  }

  runScript(
    entityId: string,
    variables: Record<string, unknown> = {},
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    assertEntityDomain(entityId, "script");
    return this.callService(
      "script",
      "turn_on",
      { entity_id: entityId.toLowerCase() },
      Object.keys(variables).length === 0 ? {} : { variables },
      options,
    );
  }

  stopScript(
    target: ServiceTargetInput,
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    return this.callService("script", "turn_off", targetFrom(target), {}, options);
  }

  toggleScript(
    target: ServiceTargetInput,
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    return this.callService("script", "toggle", targetFrom(target), {}, options);
  }

  activateScene(
    entityId: string,
    data: Record<string, unknown> = {},
    options: ControlCallOptions = {},
  ): Promise<ServiceCallResponse> {
    assertEntityDomain(entityId, "scene");
    return this.callService(
      "scene",
      "turn_on",
      { entity_id: entityId.toLowerCase() },
      data,
      options,
    );
  }
}

export function createControlService(client: HomeAssistantClient): ControlService {
  return new ControlService(client);
}

function assertEntityDomain(entityId: string, expectedDomain: string): void {
  const normalized = entityId.trim().toLowerCase();
  if (!ENTITY_ID.test(normalized) || !normalized.startsWith(`${expectedDomain}.`)) {
    throw new AppError("HA_INVALID_SERVICE_TARGET", `Expected a ${expectedDomain} entity ID`, {
      details: { entity_id: entityId },
    });
  }
}
