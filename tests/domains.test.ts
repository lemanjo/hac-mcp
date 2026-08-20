/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import {
  createAutomation,
  updateAutomation,
  validateAutomation,
} from "../src/domains/automations.js";
import { ControlService } from "../src/domains/control.js";
import { DiscoveryService } from "../src/domains/discovery.js";
import { HelperAdministration } from "../src/domains/helpers.js";
import { HistoryService } from "../src/domains/history.js";
import { IntegrationAdministration } from "../src/domains/integrations.js";
import { LogsService } from "../src/domains/logs.js";
import { RegistryAdministration } from "../src/domains/registries.js";
import { explainTraceFailure, type TraceDetails } from "../src/domains/resources.js";
import { RuntimeService } from "../src/domains/runtime.js";
import type { HomeAssistantClient } from "../src/homeassistant/client.js";
import type { RestRequestOptions } from "../src/homeassistant/rest.js";
import { AppError } from "../src/shared/errors.js";
import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
} from "../src/shared/types.js";

describe("DiscoveryService", () => {
  it("joins inherited and direct relationships, then filters before paginating", async () => {
    const areas: AreaRegistryEntry[] = [
      { area_id: "kitchen", name: "Kitchen" },
      { area_id: "living", name: "Living Room" },
    ];
    const devices: DeviceRegistryEntry[] = [
      {
        id: "device-kitchen",
        name: "Kitchen Bridge",
        area_id: "kitchen",
        config_entries: ["entry-hue"],
      },
    ];
    const entities: EntityRegistryEntry[] = [
      {
        entity_id: "light.ceiling",
        name: "Ceiling",
        device_id: "device-kitchen",
        config_entry_id: "entry-hue",
        platform: "hue",
      },
      {
        entity_id: "sensor.temperature",
        original_name: "Temperature",
        device_id: "device-kitchen",
        area_id: "living",
        config_entry_id: "entry-mqtt",
        platform: "mqtt",
      },
      {
        entity_id: "switch.coffee",
        name: "Coffee",
        area_id: "kitchen",
        config_entry_id: "entry-mqtt",
        platform: "mqtt",
      },
    ];
    const integrations: ConfigEntry[] = [
      { entry_id: "entry-hue", domain: "hue", title: "Hue" },
      { entry_id: "entry-mqtt", domain: "mqtt", title: "MQTT" },
    ];
    const service = new DiscoveryService(
      mockClient({
        getAreaRegistry: vi.fn(async () => areas),
        getDeviceRegistry: vi.fn(async () => devices),
        getEntityRegistry: vi.fn(async () => entities),
        getConfigEntries: vi.fn(async () => integrations),
      }),
    );

    const snapshot = await service.getSnapshot();
    expect(snapshot.entities.find(({ entity_id }) => entity_id === "light.ceiling")).toMatchObject({
      effective_area_id: "kitchen",
      area_source: "device",
      area: { area_id: "kitchen", name: "Kitchen" },
      device: { device_id: "device-kitchen", name: "Kitchen Bridge" },
      integrations: [{ entry_id: "entry-hue", domain: "hue", title: "Hue" }],
    });
    expect(
      snapshot.entities.find(({ entity_id }) => entity_id === "sensor.temperature"),
    ).toMatchObject({
      effective_area_id: "living",
      area_source: "entity",
      integrations: [{ entry_id: "entry-hue" }, { entry_id: "entry-mqtt" }],
    });
    expect(snapshot.areas.find(({ area_id }) => area_id === "kitchen")).toMatchObject({
      devices: [{ device_id: "device-kitchen" }],
      entities: [{ entity_id: "light.ceiling" }, { entity_id: "switch.coffee" }],
      platforms: ["hue", "mqtt"],
    });
    expect(snapshot.platforms.find(({ platform }) => platform === "mqtt")).toMatchObject({
      entities: [{ entity_id: "sensor.temperature" }, { entity_id: "switch.coffee" }],
      areas: [
        { area_id: "kitchen", name: "Kitchen" },
        { area_id: "living", name: "Living Room" },
      ],
    });

    await expect(service.listEntities({ areaId: "kitchen", limit: 1, offset: 1 })).resolves.toEqual(
      {
        items: [expect.objectContaining({ entity_id: "switch.coffee" })],
        pagination: { limit: 1, offset: 1, total: 2, has_more: false },
      },
    );
  });
});

describe("RuntimeService state filtering", () => {
  it("uses entity area overrides, device-inherited areas, and device relationships", async () => {
    const states = [
      state("light.ceiling", "on", { friendly_name: "Ceiling" }),
      state("sensor.temperature", "21", { friendly_name: "Temperature" }),
      state("switch.coffee", "unavailable", { friendly_name: "Coffee" }),
    ];
    const entities: EntityRegistryEntry[] = [
      { entity_id: "light.ceiling", device_id: "device-1" },
      { entity_id: "sensor.temperature", device_id: "device-1", area_id: "living" },
      { entity_id: "switch.coffee", area_id: "kitchen" },
    ];
    const devices: DeviceRegistryEntry[] = [{ id: "device-1", area_id: "kitchen" }];
    const runtime = new RuntimeService(
      mockClient({
        getStates: vi.fn(async () => states),
        getEntityRegistry: vi.fn(async () => entities),
        getDeviceRegistry: vi.fn(async () => devices),
      }),
    );

    const kitchen = await runtime.listStatesByArea("kitchen", { includeUnavailable: false });
    expect(kitchen.items.map(({ entity_id }) => entity_id)).toEqual(["light.ceiling"]);
    expect(kitchen.pagination.total).toBe(1);

    const device = await runtime.listStatesByDevice("device-1");
    expect(device.items.map(({ entity_id }) => entity_id)).toEqual([
      "light.ceiling",
      "sensor.temperature",
    ]);
  });
});

describe("ControlService live validation", () => {
  it("validates against the current service definition before making a normalized call", async () => {
    const callService = vi.fn(async () => []);
    const control = new ControlService(
      mockClient({
        getServices: vi.fn(async () => [
          {
            domain: "light",
            services: {
              turn_on: {
                target: {},
                fields: { brightness: { required: true } },
                response: { optional: true },
              },
            },
          },
        ]),
        callService,
      }),
    );

    await expect(
      control.callService({
        domain: " LIGHT ",
        service: " TURN_ON ",
        target: { entity_id: " LIGHT.KITCHEN " },
        data: { brightness: 100 },
      }),
    ).resolves.toEqual([]);
    expect(callService).toHaveBeenCalledWith(
      "light",
      "turn_on",
      { brightness: 100, entity_id: "light.kitchen" },
      { returnResponse: false },
    );

    await expect(
      control.callService({
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
        data: { transition: 1 },
      }),
    ).rejects.toMatchObject({ code: "HA_UNKNOWN_SERVICE_FIELD" });
    await expect(
      control.callService({ domain: "light", service: "turn_on", data: { brightness: 10 } }),
    ).rejects.toMatchObject({ code: "HA_SERVICE_TARGET_REQUIRED" });
    expect(callService).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryService", () => {
  it("normalizes IDs and times and constructs Home Assistant history query flags", async () => {
    const restRequest = vi
      .fn<(path: string, options?: RestRequestOptions) => Promise<never[]>>()
      .mockResolvedValue([]);
    const history = new HistoryService(mockClient({ restRequest }));

    await history.getHistory({
      entityIds: [" Light.Kitchen ", "sensor.temp", "light.kitchen"],
      startTime: "2026-08-20T10:00:00+02:00",
      endTime: new Date("2026-08-20T09:30:00Z"),
      minimalResponse: true,
      noAttributes: true,
      significantChangesOnly: true,
    });

    expect(restRequest).toHaveBeenCalledTimes(1);
    const [path, options] = restRequest.mock.calls[0]!;
    const url = new URL(path, "http://homeassistant.local");
    expect(decodeURIComponent(url.pathname)).toBe("/api/history/period/2026-08-20T08:00:00.000Z");
    expect(url.searchParams.get("filter_entity_id")).toBe("light.kitchen,sensor.temp");
    expect(url.searchParams.get("end_time")).toBe("2026-08-20T09:30:00.000Z");
    expect(url.searchParams.has("minimal_response")).toBe(true);
    expect(url.searchParams.has("no_attributes")).toBe(true);
    expect(url.searchParams.get("significant_changes_only")).toBe("1");
    expect(options).toEqual({ responseType: "json" });
  });

  it("rejects a reversed range before issuing a request", () => {
    const restRequest = vi.fn(async () => []);
    const history = new HistoryService(mockClient({ restRequest }));

    expect(() =>
      history.getHistory({
        entityIds: ["light.kitchen"],
        startTime: "2026-08-21T00:00:00Z",
        endTime: "2026-08-20T00:00:00Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "HA_INVALID_TIME_RANGE" }));
    expect(restRequest).not.toHaveBeenCalled();
  });
});

describe("automation editor mutations", () => {
  it("returns a validated create diff on dry-run without writing", async () => {
    const restRequest = vi.fn(async (_path: string, options: RestRequestOptions = {}) => {
      if ((options.method ?? "GET") === "GET") {
        throw new AppError("HA_NOT_FOUND", "missing");
      }
      throw new Error("dry-run unexpectedly wrote");
    });
    const wsCommand = vi.fn(async () => ({
      triggers: { valid: true, error: null },
      actions: { valid: true, error: null },
    }));
    const client = mockClient({ getStates: vi.fn(async () => []), restRequest, wsCommand });

    const result = await createAutomation(
      client,
      "wake-up",
      { alias: "Wake up", triggers: [], actions: [] },
      { dryRun: true },
    );

    expect(result).toMatchObject({
      id: "wake-up",
      operation: "create",
      dry_run: true,
      changed: true,
      applied: false,
      checkpointed: false,
      validation: { valid: true, source: "websocket" },
      reload: { triggered_by: "none", explicit_reload: false },
      verification: null,
    });
    expect(result.diff).toEqual([
      expect.objectContaining({
        op: "add",
        path: "",
        after: expect.objectContaining({ id: "wake-up", alias: "Wake up" }),
      }),
    ]);
    expect(restRequest).toHaveBeenCalledTimes(1);
    expect(wsCommand).toHaveBeenCalledWith({ type: "validate_config", triggers: [], actions: [] });
  });

  it("rejects invalid local or live validation before writing", async () => {
    const noFragments = await validateAutomation(mockClient(), { alias: "No actions" });
    expect(noFragments).toMatchObject({ valid: false, source: "local" });

    const restRequest = vi.fn(async (_path: string, options: RestRequestOptions = {}) => {
      if ((options.method ?? "GET") === "GET") {
        throw new AppError("HA_NOT_FOUND", "missing");
      }
      throw new Error("invalid config unexpectedly wrote");
    });
    const client = mockClient({
      getStates: vi.fn(async () => []),
      restRequest,
      wsCommand: vi.fn(async () => ({
        triggers: { valid: true, error: null },
        actions: { valid: false, error: "unknown action" },
      })),
    });

    await expect(
      createAutomation(client, "invalid", { triggers: [], actions: [{ bad: true }] }),
    ).rejects.toMatchObject({ code: "HA_CONFIG_VALIDATION_FAILED" });
    expect(restRequest).toHaveBeenCalledTimes(1);
  });

  it("verifies an editor update and reports its implicit reload", async () => {
    let stored: Record<string, unknown> = {
      id: "wake",
      alias: "Old",
      triggers: [],
      actions: [],
    };
    const restRequest = editorStoreRequest(
      () => stored,
      (value) => {
        stored = value;
      },
    );
    const postApply = vi.fn(async () => undefined);
    const client = mockClient({
      getStates: vi.fn(async () => [state("automation.wake", "on", { id: "wake" })]),
      restRequest,
      wsCommand: validAutomationValidation(),
    });

    const result = await updateAutomation(
      client,
      "wake",
      { alias: "New", triggers: [], actions: [] },
      { verifyAttempts: 1, verifyDelayMs: 0, postApply },
    );

    expect(result).toMatchObject({
      applied: true,
      changed: true,
      reload: { triggered_by: "editor", explicit_reload: false },
      verification: {
        ok: true,
        attempts: 1,
        config: { observed: "present", matches: true },
        entity: { observed: "present", matches: true, entity_id: "automation.wake" },
      },
    });
    expect(stored).toMatchObject({ id: "wake", alias: "New" });
    expect(postApply).toHaveBeenCalledTimes(1);
  });

  it("rolls an update back when post-apply reload validation fails", async () => {
    const original = { id: "wake", alias: "Old", triggers: [], actions: [] };
    let stored: Record<string, unknown> = structuredClone(original);
    const restRequest = editorStoreRequest(
      () => stored,
      (value) => {
        stored = value;
      },
    );
    const client = mockClient({
      getStates: vi.fn(async () => [state("automation.wake", "on", { id: "wake" })]),
      restRequest,
      wsCommand: validAutomationValidation(),
    });

    const error = await updateAutomation(
      client,
      "wake",
      { alias: "New", triggers: [], actions: [] },
      {
        verifyAttempts: 1,
        verifyDelayMs: 0,
        postApply: async () => {
          throw new AppError("HA_CONFIG_VALIDATION_FAILED", "reload validation failed");
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "HA_RESOURCE_MUTATION_FAILED",
      details: {
        failure: { code: "HA_CONFIG_VALIDATION_FAILED" },
        verification: { ok: true },
        rollback: { attempted: true, action: "restore", succeeded: true, error: null },
      },
    });
    expect(stored).toEqual(original);
    expect(restRequest.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      2,
    );
  });
});

describe("administrative domains", () => {
  it("blocks an entity rename when either registry or runtime state owns the target", async () => {
    const wsCommand = vi.fn(async () => [{ entity_id: "light.old" }]);
    const invalidateCache = vi.fn();
    const registry = new RegistryAdministration(
      mockClient({
        wsCommand,
        getStates: vi.fn(async () => [state("light.existing", "off")]),
        invalidateCache,
      }),
    );

    await expect(registry.renameEntity("light.old", "light.existing")).rejects.toMatchObject({
      code: "ENTITY_ID_CONFLICT",
      details: { entity_id: "light.old", new_entity_id: "light.existing" },
    });
    expect(wsCommand).toHaveBeenCalledTimes(1);
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it("sends a full merged helper update while preserving server-managed identity", async () => {
    const updateCommands: Array<Record<string, unknown>> = [];
    const wsCommand = vi.fn(async (command: Record<string, unknown>) => {
      if (command.type === "input_boolean/list") {
        return [
          {
            id: "porch",
            entity_id: "input_boolean.porch",
            name: "Porch",
            icon: "mdi:lightbulb",
            initial: true,
          },
        ];
      }
      updateCommands.push(command);
      return command;
    });
    const invalidateCache = vi.fn();
    const helpers = new HelperAdministration(mockClient({ wsCommand, invalidateCache }));

    await helpers.updateHelper("input_boolean", "input_boolean.porch", { name: "Front Porch" });

    expect(updateCommands).toEqual([
      {
        name: "Front Porch",
        icon: "mdi:lightbulb",
        initial: true,
        type: "input_boolean/update",
        input_boolean_id: "porch",
      },
    ]);
    expect(invalidateCache).toHaveBeenCalledWith("registries");
  });

  it("uses the config-entry reload REST endpoint and clears all related cache data", async () => {
    const restRequest = vi.fn(async () => ({ require_restart: false }));
    const invalidateCache = vi.fn();
    const integrations = new IntegrationAdministration(
      mockClient({ restRequest, invalidateCache }),
    );

    await expect(integrations.reloadIntegration("entry/a b")).resolves.toEqual({
      require_restart: false,
    });
    expect(restRequest).toHaveBeenCalledWith(
      "/api/config/config_entries/entry/entry%2Fa%20b/reload",
      { method: "POST", responseType: "json" },
    );
    expect(invalidateCache).toHaveBeenCalledWith("all");
  });

  it("normalizes current entity and config-entry mutation response wrappers", async () => {
    const entityClient = mockClient({
      wsCommand: vi.fn(async () => ({
        entity_entry: { entity_id: "light.kitchen", name: "Kitchen" },
        reload_delay: 2,
        require_restart: true,
      })),
      invalidateCache: vi.fn(),
    });
    await expect(
      new RegistryAdministration(entityClient).updateEntity("light.kitchen", { name: "Kitchen" }),
    ).resolves.toEqual({
      entity_entry: { entity_id: "light.kitchen", name: "Kitchen" },
      reload_delay: 2,
      require_restart: true,
    });

    const integrationClient = mockClient({
      wsCommand: vi.fn(async () => ({
        config_entry: { entry_id: "entry-1", domain: "mqtt", title: "MQTT" },
        require_restart: true,
      })),
      invalidateCache: vi.fn(),
    });
    await expect(
      new IntegrationAdministration(integrationClient).updateIntegration("entry-1", {
        title: "MQTT",
      }),
    ).resolves.toEqual({
      config_entry: { entry_id: "entry-1", domain: "mqtt", title: "MQTT" },
      require_restart: true,
    });
  });
});

describe("LogsService", () => {
  it("falls back to bounded system_log records when the error-log file is unavailable", async () => {
    const logs = new LogsService(
      mockClient({
        getLogs: vi.fn(async () => {
          throw new AppError("HA_NOT_FOUND", "error log disabled");
        }),
        getSystemLog: vi.fn(async () => [
          {
            name: "homeassistant.components.mqtt",
            message: ["Connection failed for sensor.kitchen"],
            level: "ERROR",
            timestamp: Date.parse("2026-08-20T12:00:00Z") / 1_000,
            exception: "TimeoutError",
            count: 2,
          },
        ]),
      }),
    );

    await expect(logs.getRecentErrors()).resolves.toMatchObject({
      matched_entries: 1,
      entries: [
        {
          severity: "ERROR",
          integration: "mqtt",
          entity_ids: ["sensor.kitchen"],
          message: "Connection failed for sensor.kitchen",
        },
      ],
    });
  });
});

describe("trace failure explanations", () => {
  it("orders diagnostics deterministically and uses the first sorted failure in the summary", () => {
    const trace: TraceDetails = {
      domain: "automation",
      item_id: "wake",
      run_id: "run-1",
      script_execution: "error",
      last_step: "action/1",
      trace: {
        "z/path": [{ error: "z-error" }],
        "a/path": [{ error: "a-error", template_errors: ["template-one", "template-two"] }],
      },
    };

    const first = explainTraceFailure(trace);
    const second = explainTraceFailure(structuredClone(trace));
    expect(second).toEqual(first);
    expect(first).toEqual({
      outcome: "failed",
      code: "execution_error",
      summary: "Execution failed: a-error",
      last_step: "action/1",
      diagnostics: [
        { path: "a/path[0]", kind: "error", message: "a-error" },
        {
          path: "a/path[0].template_errors[0]",
          kind: "template_error",
          message: "template-one",
        },
        {
          path: "a/path[0].template_errors[1]",
          kind: "template_error",
          message: "template-two",
        },
        { path: "z/path[0]", kind: "error", message: "z-error" },
      ],
    });
  });
});

function mockClient(overrides: Record<string, unknown> = {}): HomeAssistantClient {
  return {
    getStates: vi.fn(async () => []),
    getServices: vi.fn(async () => []),
    getAreaRegistry: vi.fn(async () => []),
    getDeviceRegistry: vi.fn(async () => []),
    getEntityRegistry: vi.fn(async () => []),
    getConfigEntries: vi.fn(async () => []),
    restRequest: vi.fn(async () => undefined),
    wsCommand: vi.fn(async () => undefined),
    callService: vi.fn(async () => []),
    invalidateCache: vi.fn(() => 0),
    ...overrides,
  } as unknown as HomeAssistantClient;
}

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): EntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes,
    last_changed: "2026-08-20T00:00:00Z",
    last_updated: "2026-08-20T00:00:00Z",
    context: {},
  };
}

function validAutomationValidation() {
  return vi.fn(async () => ({
    triggers: { valid: true, error: null },
    actions: { valid: true, error: null },
  }));
}

function editorStoreRequest(
  getStored: () => Record<string, unknown>,
  setStored: (value: Record<string, unknown>) => void,
) {
  return vi.fn(async (_path: string, options: RestRequestOptions = {}) => {
    const method = options.method ?? "GET";
    if (method === "GET") return structuredClone(getStored());
    if (method === "POST") {
      setStored(structuredClone(options.body as Record<string, unknown>));
      return undefined;
    }
    throw new Error(`Unexpected editor method: ${method}`);
  });
}
