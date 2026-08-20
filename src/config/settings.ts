import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod/v4";

import { AppError } from "../shared/errors.js";

const SettingsSchema = z.object({
  homeAssistant: z.object({
    url: z.string().url(),
    token: z.string().min(1),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    websocketTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    verifyTls: z.boolean().default(true),
  }),
  mcp: z.object({
    mode: z.enum(["read_only", "control", "admin"]).default("read_only"),
    transport: z.enum(["http", "stdio"]).default("http"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(3000),
    authToken: z.string().min(16).optional(),
    allowedHosts: z.array(z.string()).default(["localhost", "127.0.0.1"]),
    allowedOrigins: z.array(z.string()).default([]),
    maxRequestBytes: z.number().int().min(1_024).max(10_485_760).default(1_048_576),
  }),
  filesystem: z.object({
    root: z.string().default("/ha-config"),
    enabled: z.boolean().default(true),
    allowSecretsMetadata: z.boolean().default(true),
    allowSecretValues: z.boolean().default(false),
    allowCustomComponents: z.boolean().default(false),
    allowedDirectories: z.array(z.string()).default(["packages", "themes"]),
    maxReadBytes: z.number().int().min(1_024).max(20_971_520).default(2_097_152),
    backupDirectory: z.string().default(".ha-mcp/backups"),
  }),
  git: z.object({
    enabled: z.boolean().default(true),
    authorName: z.string().default("Home Assistant Admin MCP"),
    authorEmail: z.string().email().default("home-assistant-admin-mcp@localhost"),
  }),
  permissions: z
    .object({
      requireConfirmationFor: z
        .array(z.enum(["CONTROL", "CONFIG", "HIGH_IMPACT"]))
        .default(["HIGH_IMPACT"]),
      sensitiveDomains: z.record(z.string(), z.enum(["allow", "confirm", "deny"])).default({
        lock: "confirm",
        alarm_control_panel: "confirm",
        siren: "confirm",
      }),
      sensitiveCovers: z.array(z.string()).default(["garage", "gate"]),
    })
    .default({
      requireConfirmationFor: ["HIGH_IMPACT"],
      sensitiveDomains: {
        lock: "confirm",
        alarm_control_panel: "confirm",
        siren: "confirm",
      },
      sensitiveCovers: ["garage", "gate"],
    }),
  cache: z
    .object({
      registryTtlMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
      servicesTtlMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
    })
    .default({ registryTtlMs: 30_000, servicesTtlMs: 30_000 }),
});

export type Settings = z.infer<typeof SettingsSchema>;

type LooseObject = Record<string, unknown>;

async function readSecret(
  value: string | undefined,
  file: string | undefined,
): Promise<string | undefined> {
  if (file) return (await readFile(file, "utf8")).trim();
  return value;
}

function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new AppError("INVALID_CONFIGURATION", `Invalid boolean environment value: ${value}`);
}

function csv(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function deepMerge(base: LooseObject, override: LooseObject): LooseObject {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== undefined &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      value !== null &&
      typeof result[key] === "object" &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key] as LooseObject, value as LooseObject);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
  let fileConfig: LooseObject = {};
  if (env.MCP_CONFIG_FILE) {
    const content = await readFile(path.resolve(env.MCP_CONFIG_FILE), "utf8");
    fileConfig = (parse(content) as LooseObject | null) ?? {};
  }

  const token = await readSecret(env.HOME_ASSISTANT_TOKEN, env.HOME_ASSISTANT_TOKEN_FILE);
  const authToken = await readSecret(env.MCP_AUTH_TOKEN, env.MCP_AUTH_TOKEN_FILE);
  const envConfig: LooseObject = {
    homeAssistant: {
      url: env.HOME_ASSISTANT_URL,
      token,
      requestTimeoutMs: env.HA_REQUEST_TIMEOUT_MS ? Number(env.HA_REQUEST_TIMEOUT_MS) : undefined,
      websocketTimeoutMs: env.HA_WEBSOCKET_TIMEOUT_MS
        ? Number(env.HA_WEBSOCKET_TIMEOUT_MS)
        : undefined,
      verifyTls: booleanEnv(env.HA_VERIFY_TLS),
    },
    mcp: {
      mode: env.MCP_MODE,
      transport: env.MCP_TRANSPORT,
      host: env.MCP_HOST,
      port: env.MCP_PORT ? Number(env.MCP_PORT) : undefined,
      authToken,
      allowedHosts: csv(env.MCP_ALLOWED_HOSTS),
      allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS),
    },
    filesystem: {
      root: env.HA_CONFIG_PATH,
      enabled: booleanEnv(env.HA_FILESYSTEM_ENABLED),
      allowSecretValues: booleanEnv(env.HA_ALLOW_SECRET_VALUES),
      allowCustomComponents: booleanEnv(env.HA_ALLOW_CUSTOM_COMPONENTS),
      allowedDirectories: csv(env.HA_ALLOWED_CONFIG_DIRECTORIES),
    },
    git: { enabled: booleanEnv(env.HA_GIT_ENABLED) },
  };

  const merged = deepMerge(fileConfig, envConfig);
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AppError("INVALID_CONFIGURATION", "MCP configuration is invalid", {
      details: parsed.error.flatten() as never,
    });
  }
  if (parsed.data.mcp.transport === "http" && !parsed.data.mcp.authToken) {
    throw new AppError(
      "MCP_AUTH_REQUIRED",
      "MCP_AUTH_TOKEN or MCP_AUTH_TOKEN_FILE is required for HTTP transport",
    );
  }
  return parsed.data;
}
