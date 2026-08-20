import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { Settings } from "../src/config/settings.js";
import { registerTools } from "../src/mcp/tools/index.js";
import { staticBearerAuth } from "../src/mcp/server.js";
import { PermissionPolicy } from "../src/security/risk.js";
import { redactSecrets, secretKeyNames } from "../src/security/secrets.js";
import { AppError } from "../src/shared/errors.js";
import { asJson, type Mode, type Risk } from "../src/shared/types.js";

function settings(mode: Mode = "admin"): Settings {
  return {
    homeAssistant: {
      url: "http://home-assistant.local:8123",
      token: "home-assistant-token",
      requestTimeoutMs: 30_000,
      websocketTimeoutMs: 30_000,
      verifyTls: true,
    },
    mcp: {
      mode,
      transport: "http",
      host: "127.0.0.1",
      port: 3000,
      authToken: "0123456789abcdef",
      allowedHosts: ["localhost"],
      allowedOrigins: [],
      maxRequestBytes: 1_048_576,
    },
    filesystem: {
      root: "/ha-config",
      enabled: true,
      allowSecretsMetadata: true,
      allowSecretValues: false,
      allowCustomComponents: false,
      allowedDirectories: ["packages", "themes"],
      maxReadBytes: 2_097_152,
      backupDirectory: ".ha-mcp/backups",
    },
    git: {
      enabled: false,
      authorName: "Home Assistant Admin MCP",
      authorEmail: "home-assistant-admin-mcp@localhost",
    },
    permissions: {
      requireConfirmationFor: [],
      sensitiveDomains: {},
      sensitiveCovers: ["garage", "gate"],
    },
    cache: {
      registryTtlMs: 30_000,
      servicesTtlMs: 30_000,
    },
  };
}

function expectAppError(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("permission policy", () => {
  const allowedRisks: Record<Mode, readonly Risk[]> = {
    read_only: ["READ"],
    control: ["READ", "CONTROL"],
    admin: ["READ", "CONTROL", "CONFIG", "HIGH_IMPACT"],
  };

  it.each(["read_only", "control", "admin"] as const)("enforces the %s risk boundary", (mode) => {
    const policy = new PermissionPolicy(settings(mode));
    for (const risk of ["READ", "CONTROL", "CONFIG", "HIGH_IMPACT"] as const) {
      const authorize = () => policy.authorize({ risk, operation: `test_${risk}` });
      if (allowedRisks[mode].includes(risk)) expect(authorize).not.toThrow();
      else expectAppError(authorize, "OPERATION_NOT_PERMITTED");
    }
  });

  it("applies global and sensitive-domain confirmation rules", () => {
    const configured = settings("admin");
    configured.permissions.requireConfirmationFor = ["CONFIG"];
    configured.permissions.sensitiveDomains = { lock: "confirm", siren: "deny" };
    const policy = new PermissionPolicy(configured);

    expectAppError(
      () => policy.authorize({ risk: "CONFIG", operation: "update_area" }),
      "CONFIRMATION_REQUIRED",
    );
    expect(() =>
      policy.authorize({ risk: "CONFIG", operation: "update_area", confirm: true }),
    ).not.toThrow();
    expectAppError(
      () =>
        policy.authorize({
          risk: "CONTROL",
          operation: "unlock",
          entityId: "lock.front_door",
        }),
      "CONFIRMATION_REQUIRED",
    );
    expect(() =>
      policy.authorize({
        risk: "CONTROL",
        operation: "unlock",
        entityId: "lock.front_door",
        confirm: true,
      }),
    ).not.toThrow();
    expectAppError(
      () =>
        policy.authorize({
          risk: "CONTROL",
          operation: "sound_siren",
          entityId: "siren.entry",
          confirm: true,
        }),
      "SENSITIVE_OPERATION_DENIED",
    );
  });

  it("requires confirmation for sensitive cover names but not ordinary covers", () => {
    const policy = new PermissionPolicy(settings("control"));

    expectAppError(
      () =>
        policy.authorize({
          risk: "CONTROL",
          operation: "open_cover",
          entityId: "cover.garage_door",
        }),
      "CONFIRMATION_REQUIRED",
    );
    expect(() =>
      policy.authorize({
        risk: "CONTROL",
        operation: "open_cover",
        entityId: "cover.garage_door",
        confirm: true,
      }),
    ).not.toThrow();
    expect(() =>
      policy.authorize({
        risk: "CONTROL",
        operation: "open_cover",
        entityId: "cover.bedroom_blind",
      }),
    ).not.toThrow();
  });

  it("checks every entity in a multi-target operation", () => {
    const policy = new PermissionPolicy(settings("control"));

    expectAppError(
      () =>
        policy.authorize({
          risk: "CONTROL",
          operation: "turn_on",
          domain: "homeassistant",
          entityIds: ["light.entry", "lock.front_door", "cover.garage_door"],
        }),
      "CONFIRMATION_REQUIRED",
    );
  });
});

describe("secret redaction", () => {
  it("redacts nested secret-bearing keys, including values inside arrays", () => {
    const input = {
      username: "home-assistant",
      password: "correct horse battery staple",
      nested: [
        { api_key: "abc", harmless: "visible" },
        { Authorization: "Bearer hidden", child: { access_token: "token" } },
      ],
      "private-key": "private material",
      cookie_jar: "session material",
    };

    expect(redactSecrets(input)).toEqual({
      username: "home-assistant",
      password: "[REDACTED]",
      nested: [
        { api_key: "[REDACTED]", harmless: "visible" },
        { Authorization: "[REDACTED]", child: { access_token: "[REDACTED]" } },
      ],
      "private-key": "[REDACTED]",
      cookie_jar: "[REDACTED]",
    });
    expect(input.password).toBe("correct horse battery staple");
  });

  it("returns original values only when explicitly allowed and exposes sorted metadata names", () => {
    const input = { z_secret: "last", a_token: "first" };

    expect(redactSecrets(input, true)).toBe(input);
    expect(secretKeyNames(input)).toEqual(["a_token", "z_secret"]);
    expect(secretKeyNames([input])).toEqual([]);
  });
});

describe("structured results", () => {
  it("normalizes void upstream responses to JSON null", () => {
    expect(asJson(undefined)).toBeNull();
  });
});

interface AuthHarness {
  request: Request;
  response: Response;
  next: NextFunction;
  header: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function authHarness(authorization?: string): AuthHarness {
  const header = vi.fn((name: string) => (name === "authorization" ? authorization : undefined));
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const setHeader = vi.fn();
  return {
    request: { header } as unknown as Request,
    response: { setHeader, status } as unknown as Response,
    next: vi.fn() as NextFunction,
    header,
    setHeader,
    status,
    json,
  };
}

describe("static bearer authentication", () => {
  it.each(["Bearer expected-token", "bearer expected-token"])(
    "accepts a valid HTTP Bearer credential: %s",
    (authorization) => {
      const harness = authHarness(authorization);

      staticBearerAuth("expected-token")(harness.request, harness.response, harness.next);

      expect(harness.header).toHaveBeenCalledWith("authorization");
      expect(harness.next).toHaveBeenCalledOnce();
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.json).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "Basic expected-token", "Bearer wrong-token"])(
    "rejects a missing or invalid credential: %s",
    (authorization) => {
      const harness = authHarness(authorization);

      staticBearerAuth("expected-token")(harness.request, harness.response, harness.next);

      expect(harness.next).not.toHaveBeenCalled();
      expect(harness.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        'Bearer realm="home-assistant-admin-mcp"',
      );
      expect(harness.status).toHaveBeenCalledWith(401);
      expect(harness.json).toHaveBeenCalledWith({ error: "unauthorized" });
    },
  );
});

interface SchemaField {
  description?: string;
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

interface InputSchema {
  shape: Record<string, SchemaField>;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface ToolConfiguration {
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  _meta: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  configuration: ToolConfiguration;
  handler: unknown;
}

function registeredTools(
  app: Parameters<typeof registerTools>[1] = {} as Parameters<typeof registerTools>[1],
): RegisteredTool[] {
  const registrations: RegisteredTool[] = [];
  const server = {
    registerTool(name: string, configuration: ToolConfiguration, handler: unknown): void {
      registrations.push({ name, configuration, handler });
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], app);
  return registrations;
}

const RISK_KEY = "com.home-assistant-admin-mcp/risk";
const MODE_KEY = "com.home-assistant-admin-mcp/mode-required";
const SOURCE_KEY = "com.home-assistant-admin-mcp/source";

describe("MCP tool registration", () => {
  it("registers unique names and the required semantic diagnostic tools", () => {
    const names = registeredTools().map(({ name }) => name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        "find_unavailable_entities",
        "find_orphaned_entities",
        "find_orphaned_devices",
        "find_unused_helpers",
        "find_stale_sensors",
        "find_broken_automations",
        "find_duplicate_entities",
        "find_entities_without_area",
        "find_devices_without_area",
        "find_automations_referencing_missing_entities",
        "get_entity_dependencies",
        "get_automation_dependencies",
        "list_custom_component_files",
        "read_custom_component_source",
        "search_home_assistant",
      ]),
    );
  });

  it("advertises dry_run on every mutation tool that implements a preview", () => {
    const expected = [
      "assign_device_to_area",
      "assign_entity_to_area",
      "create_area",
      "create_automation",
      "create_helper",
      "create_scene",
      "create_script",
      "delete_area",
      "delete_automation",
      "delete_helper",
      "delete_scene",
      "delete_script",
      "disable_device",
      "disable_entity",
      "disable_integration",
      "call_service",
      "enable_device",
      "enable_entity",
      "enable_integration",
      "move_device_to_area",
      "move_entity_to_area",
      "patch_yaml_file",
      "reload_config_entry",
      "reload_configuration",
      "reload_yaml_configuration",
      "reload_automations",
      "reload_scenes",
      "reload_scripts",
      "restart_home_assistant",
      "rollback_change",
      "rollback_to_commit",
      "rename_device",
      "rename_entity",
      "update_area",
      "update_automation",
      "update_device",
      "update_entity_registry",
      "update_helper",
      "update_integration",
      "update_scene",
      "update_script",
    ].sort();
    const tools = registeredTools();
    const advertised = tools
      .filter(({ configuration }) => "dry_run" in configuration.inputSchema.shape)
      .map(({ name }) => name)
      .sort();

    expect(advertised).toEqual(expected);
    for (const name of expected) {
      const field = tools.find((tool) => tool.name === name)!.configuration.inputSchema.shape
        .dry_run!;
      expect(field.safeParse(undefined)).toMatchObject({ success: true, data: false });
      expect(field.description).toMatch(/without changing Home Assistant/i);
    }
  });

  it("rejects oversized structural patch requests at schema validation", () => {
    const patch = registeredTools().find(({ name }) => name === "patch_yaml_file")!;
    const operations = Array.from({ length: 101 }, () => ({
      op: "set",
      path: ["value"],
      value: true,
    }));

    expect(patch.configuration.inputSchema.shape.operations!.safeParse(operations)).toMatchObject({
      success: false,
    });
  });

  it("publishes risk, mode, source, and MCP annotations consistently", () => {
    const requiredMode: Record<Risk, Mode> = {
      READ: "read_only",
      CONTROL: "control",
      CONFIG: "admin",
      HIGH_IMPACT: "admin",
    };

    for (const { name, configuration } of registeredTools()) {
      const risk = configuration._meta[RISK_KEY] as Risk;
      const source = configuration._meta[SOURCE_KEY];
      expect(["READ", "CONTROL", "CONFIG", "HIGH_IMPACT"]).toContain(risk);
      expect(configuration.description, name).toContain(`Risk: ${risk}`);
      expect(configuration._meta[MODE_KEY], name).toBe(requiredMode[risk]);
      expect(["rest", "websocket", "config_api", "filesystem", "derived"]).toContain(source);
      expect(configuration.annotations.readOnlyHint, name).toBe(risk === "READ");
      expect(configuration.annotations.destructiveHint, name).toBe(
        risk === "HIGH_IMPACT" || name === "call_service",
      );
      expect(configuration.annotations.openWorldHint, name).toBe(
        source !== "filesystem" && source !== "derived",
      );
    }

    const byName = new Map(registeredTools().map((tool) => [tool.name, tool]));
    expect(byName.get("call_service")!.configuration._meta).toMatchObject({
      "com.home-assistant-admin-mcp/dynamic-risk": true,
    });
    expect(byName.get("get_state")!.configuration.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("update_automation")!.configuration.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("restart_home_assistant")!.configuration.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get("find_unused_helpers")!.configuration.annotations.openWorldHint).toBe(false);
  });

  it("escalates administrative generic service calls before invoking Home Assistant", async () => {
    const control = { callService: vi.fn() };
    const app = {
      policy: new PermissionPolicy(settings("control")),
      control,
    } as unknown as Parameters<typeof registerTools>[1];
    const callService = registeredTools(app).find(({ name }) => name === "call_service")!;
    const handler = callService.handler as (
      input: Record<string, unknown>,
    ) => Promise<{ structuredContent: { success: boolean; meta: { risk: Risk } } }>;

    const result = await handler({
      domain: "homeassistant",
      service: "restart",
      service_data: {},
      return_response: false,
      confirm: true,
    });

    expect(result.structuredContent).toMatchObject({
      success: false,
      meta: { risk: "HIGH_IMPACT" },
    });
    expect(control.callService).not.toHaveBeenCalled();
  });
});
