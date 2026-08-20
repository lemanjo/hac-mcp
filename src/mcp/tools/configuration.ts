import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import type { Application } from "../../app.js";
import { parseHomeAssistantYaml } from "../../config/catalog.js";
import type { ConfigUnifiedDiff } from "../../config/transaction.js";
import type { YamlPatchOperation } from "../../config/yaml-editor.js";
import { validateYaml } from "../../config/yaml-editor.js";
import { redactSecrets } from "../../security/secrets.js";
import { AppError } from "../../shared/errors.js";
import type { JsonValue } from "../../shared/types.js";
import { paginate } from "../../shared/types.js";
import { confirmationField, dryRunField, pageFields } from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";

const emptySchema = z.object({});
const configPath = z
  .string()
  .min(1)
  .max(1_024)
  .describe("YAML path relative to the Home Assistant configuration directory");
const yamlPathSegment = z.union([
  z.string().min(1).max(255),
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
]);
const yamlPath = z
  .array(yamlPathSegment)
  .max(64)
  .describe("Structural YAML path made of mapping keys and sequence indexes");
const yamlPatch = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    path: yamlPath,
    value: z.json().describe("JSON-compatible value to store at the YAML path"),
  }),
  z.object({ op: z.literal("delete"), path: yamlPath }),
]);
const commitHash = z.string().regex(/^[a-f0-9]{7,64}$/i);
const checkpointId = z.string().regex(/^\d{8}T\d{9}Z-[a-f0-9]{16}$/);

const SENSITIVE_KEY =
  /(^|[_-])(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie)($|[_-])/i;
const SENSITIVE_YAML_ASSIGNMENT =
  /(?:^|[\s{,-])["']?(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie)["']?\s*:/i;
const YAML_EXTENSION = /\.ya?ml$/i;
const CUSTOM_COMPONENT_EXTENSION = /\.(?:json|py|pyi|ya?ml)$/i;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_LISTED_FILES = 1_000;

interface SourceError {
  code: string;
  message: string;
}

function errorSummary(error: unknown): SourceError {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      };
}

function parseStructuredYaml(source: string, allowSecretValues: boolean): unknown {
  return parseHomeAssistantYaml(source, allowSecretValues);
}

async function readStructuredYaml(app: Application, requestedPath: string): Promise<unknown> {
  const metadata = await app.filesystem.metadata(requestedPath);
  if (metadata.kind === "secrets_metadata" && !app.settings.filesystem.allowSecretValues) {
    return {
      protected: true,
      values_exposed: false,
      metadata,
    };
  }
  if (!YAML_EXTENSION.test(metadata.path)) {
    throw new AppError("CONFIG_PATH_NOT_ALLOWED", "Only YAML configuration can be read here");
  }
  const file = await app.filesystem.readFile(metadata.path);
  return {
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    modified_at: file.modifiedAt,
    kind: file.kind,
    yaml: parseStructuredYaml(file.content, app.settings.filesystem.allowSecretValues),
    redacted: !app.settings.filesystem.allowSecretValues,
  };
}

function configuredDirectory(value: string): string {
  if (path.isAbsolute(value) || value.includes("\\")) {
    throw new AppError("INVALID_CONFIGURATION", "A filesystem allowlist directory is invalid");
  }
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AppError("INVALID_CONFIGURATION", "A filesystem allowlist directory is invalid");
  }
  return segments.join("/");
}

async function listAllowedYamlPaths(
  app: Application,
  rootEntries: readonly Dirent<string>[],
): Promise<{ paths: string[]; truncated: boolean }> {
  const candidates = new Set<string>();
  let scanned = rootEntries.length;
  let truncated = scanned > MAX_SCAN_ENTRIES;

  for (const entry of rootEntries) {
    if (
      candidates.size >= MAX_LISTED_FILES ||
      scanned > MAX_SCAN_ENTRIES ||
      !entry.isFile() ||
      !YAML_EXTENSION.test(entry.name) ||
      /^secrets\.ya?ml$/i.test(entry.name)
    ) {
      continue;
    }
    try {
      const resolved = await app.filesystem.policy.resolve(entry.name, "metadata");
      if (resolved.kind === "yaml") candidates.add(resolved.relativePath);
    } catch {
      // Disallowed root files are intentionally omitted rather than named.
    }
  }

  const queues: Array<{ absolute: string; relative: string; depth: number }> = [];
  for (const rawDirectory of app.settings.filesystem.allowedDirectories) {
    const relative = configuredDirectory(rawDirectory);
    try {
      queues.push({
        absolute: await app.filesystem.policy.resolveInternal(relative, true),
        relative,
        depth: 0,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFIG_FILE_NOT_FOUND") throw error;
    }
  }

  while (queues.length > 0 && scanned <= MAX_SCAN_ENTRIES && candidates.size < MAX_LISTED_FILES) {
    const current = queues.shift()!;
    if (current.depth > 32) {
      truncated = true;
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOTDIR") continue;
      throw error;
    }
    scanned += entries.length;
    if (scanned > MAX_SCAN_ENTRIES) {
      truncated = true;
      break;
    }
    for (const entry of entries) {
      const relative = `${current.relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if ([".storage", ".git"].includes(entry.name.toLowerCase())) continue;
        queues.push({
          absolute: path.join(current.absolute, entry.name),
          relative,
          depth: current.depth + 1,
        });
      } else if (entry.isFile() && YAML_EXTENSION.test(entry.name)) {
        try {
          const resolved = await app.filesystem.policy.resolve(relative, "metadata");
          if (resolved.kind === "yaml") candidates.add(resolved.relativePath);
        } catch {
          // Only files accepted by the central path policy are returned.
        }
      }
      if (candidates.size >= MAX_LISTED_FILES) {
        truncated = true;
        break;
      }
    }
  }
  if (queues.length > 0) truncated = true;
  return { paths: [...candidates].sort(), truncated };
}

async function listConfigurationFiles(app: Application, limit: number, offset: number) {
  if (!app.settings.filesystem.enabled) {
    throw new AppError("FILESYSTEM_DISABLED", "Home Assistant filesystem access is disabled");
  }
  const root = await app.filesystem.policy.root();
  const rootEntries = await readdir(root, { withFileTypes: true });
  const scan = await listAllowedYamlPaths(app, rootEntries);
  const files = [];
  for (const filePath of scan.paths) files.push(await app.filesystem.metadata(filePath));

  const protectedEntries: unknown[] = [];
  for (const name of ["secrets.yaml", "secrets.yml"]) {
    const entry = rootEntries.find((candidate) => candidate.name.toLowerCase() === name);
    if (!entry?.isFile()) continue;
    if (app.settings.filesystem.allowSecretsMetadata) {
      protectedEntries.push({
        protected: true,
        values_exposed: false,
        ...(await app.filesystem.metadata(entry.name)),
      });
    } else {
      protectedEntries.push({ path: entry.name, kind: "secrets_metadata", exists: true });
    }
  }
  for (const [name, kind] of [
    [".storage", "home_assistant_storage"],
    [".git", "git_repository"],
  ] as const) {
    if (rootEntries.some((entry) => entry.name === name)) {
      protectedEntries.push({ kind, exists: true, protected: true });
    }
  }

  return {
    ...paginate(files, { limit, offset }),
    protected: protectedEntries,
    scan: {
      maximum_entries: MAX_SCAN_ENTRIES,
      maximum_files: MAX_LISTED_FILES,
      truncated: scan.truncated,
    },
  };
}

async function listCustomComponentFiles(
  app: Application,
  integration: string | undefined,
  limit: number,
  offset: number,
) {
  if (!app.settings.filesystem.allowCustomComponents) {
    throw new AppError(
      "CUSTOM_COMPONENT_ACCESS_DISABLED",
      "Custom component access requires filesystem.allowCustomComponents",
    );
  }
  const relativeRoot =
    integration === undefined ? "custom_components" : `custom_components/${integration}`;
  const absoluteRoot = await app.filesystem.policy.resolveInternal(relativeRoot, true);
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: absoluteRoot, relative: relativeRoot, depth: 0 },
  ];
  const files = [];
  let scanned = 0;
  let truncated = false;
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES && files.length < MAX_LISTED_FILES) {
    const current = queue.shift()!;
    if (current.depth > 16) {
      truncated = true;
      continue;
    }
    const entries = await readdir(current.absolute, { withFileTypes: true });
    scanned += entries.length;
    for (const entry of entries) {
      const relative = `${current.relative}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push({
          absolute: path.join(current.absolute, entry.name),
          relative,
          depth: current.depth + 1,
        });
      } else if (entry.isFile() && CUSTOM_COMPONENT_EXTENSION.test(entry.name)) {
        try {
          const metadata = await app.filesystem.metadata(relative);
          if (metadata.kind === "custom_component") files.push(metadata);
        } catch {
          // The central path policy remains authoritative for every listed file.
        }
      }
      if (files.length >= MAX_LISTED_FILES || scanned >= MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
    }
  }
  if (queue.length > 0) truncated = true;
  return { ...paginate(files, { limit, offset }), scan: { scanned, truncated } };
}

async function readCustomComponentSource(app: Application, requestedPath: string) {
  const file = await app.filesystem.readFile(requestedPath);
  if (file.kind !== "custom_component") {
    throw new AppError(
      "CONFIG_PATH_NOT_ALLOWED",
      "The requested path is not an enabled custom component source",
    );
  }
  let source: unknown = file.content;
  if (/\.json$/i.test(file.path)) {
    try {
      source = redactSecrets(
        JSON.parse(file.content) as unknown,
        app.settings.filesystem.allowSecretValues,
      );
    } catch (error) {
      throw new AppError("INVALID_JSON", "The custom component JSON source is invalid", {
        cause: error,
      });
    }
  } else if (YAML_EXTENSION.test(file.path)) {
    source = parseStructuredYaml(file.content, app.settings.filesystem.allowSecretValues);
  }
  return {
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    modified_at: file.modifiedAt,
    source,
    redacted:
      !app.settings.filesystem.allowSecretValues &&
      (/\.json$/i.test(file.path) || YAML_EXTENSION.test(file.path)),
  };
}

function hasSensitiveObjectKey(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveObjectKey);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveObjectKey(child),
    );
  }
  return false;
}

function assertPatchSecretsAllowed(
  operations: readonly YamlPatchOperation[],
  allowSecretValues: boolean,
): void {
  if (allowSecretValues) return;
  for (const operation of operations) {
    if (operation.op !== "set") continue;
    const sensitivePath = operation.path.some(
      (segment) => typeof segment === "string" && SENSITIVE_KEY.test(segment),
    );
    if (sensitivePath || hasSensitiveObjectKey(operation.value)) {
      throw new AppError(
        "SENSITIVE_YAML_PATCH_DENIED",
        "Setting sensitive-looking YAML keys requires allowSecretValues",
      );
    }
  }
}

function redactDiffLines(lines: readonly string[]): string[] {
  let sensitiveBlockIndent: number | null = null;
  return lines.map((line) => {
    if (/^(diff |index |--- |\+\+\+ |@@)/.test(line)) {
      sensitiveBlockIndent = null;
      return line;
    }
    const marker = /^[+\- ]/.test(line) ? line[0]! : "";
    const content = marker === "" ? line : line.slice(1);
    const indent = /^\s*/.exec(content)?.[0].length ?? 0;
    if (sensitiveBlockIndent !== null) {
      if (content.trim().length === 0 || indent > sensitiveBlockIndent) {
        return `${marker}[REDACTED YAML LINE]`;
      }
      sensitiveBlockIndent = null;
    }
    if (SENSITIVE_YAML_ASSIGNMENT.test(content) || /!secret(?:\s|$)/i.test(content)) {
      const value = content.slice(content.indexOf(":") + 1).trim();
      if (value === "" || /^[|>][+-]?$/.test(value)) sensitiveBlockIndent = indent;
      return `${marker}[REDACTED YAML LINE]`;
    }
    return line;
  });
}

function redactUnifiedDiff(unified: string, allowSecretValues: boolean): string {
  if (allowSecretValues) return unified;
  return redactDiffLines(unified.split("\n")).join("\n");
}

function redactConfigDiff(diff: ConfigUnifiedDiff, allowSecretValues: boolean): ConfigUnifiedDiff {
  if (allowSecretValues) return diff;
  return {
    ...diff,
    hunks: diff.hunks.map((hunk) => ({
      ...hunk,
      lines: redactDiffLines(hunk.lines),
    })),
    unified: redactUnifiedDiff(diff.unified, false),
  };
}

async function validateLocalFiles(app: Application, paths: readonly string[]) {
  const results = [];
  for (const requestedPath of paths) {
    try {
      const metadata = await app.filesystem.metadata(requestedPath);
      if (metadata.kind === "secrets_metadata") {
        results.push({ path: metadata.path, valid: null, protected: true, metadata });
        continue;
      }
      if (!YAML_EXTENSION.test(metadata.path)) {
        throw new AppError("CONFIG_PATH_NOT_ALLOWED", "Only YAML configuration can be validated");
      }
      const file = await app.filesystem.readFile(metadata.path);
      validateYaml(file.content);
      results.push({ path: file.path, valid: true, sha256: file.sha256 });
    } catch (error) {
      results.push({ path: requestedPath, valid: false, error: errorSummary(error) });
    }
  }
  return { valid: results.every((result) => result.valid !== false), files: results };
}

async function restoreSafetyCheckpoint(
  app: Application,
  checkpointId: string,
  paths: readonly string[],
): Promise<void> {
  const expected = new Map<string, string | null>();
  for (const filePath of paths) expected.set(filePath, await app.filesystem.hash(filePath));
  await app.transaction.backups.restoreCheckpoint(checkpointId, {
    expectedCurrent: expected,
    paths,
  });
  await app.reloadForPaths(paths);
}

async function rollbackCheckpoint(
  app: Application,
  id: string,
  requestedPaths: readonly string[] | undefined,
) {
  const checkpoint = await app.transaction.backups.loadCheckpoint(id);
  const selected =
    requestedPaths === undefined
      ? checkpoint.entries.map((entry) => entry.path)
      : [...new Set(requestedPaths)];
  if (selected.length === 0) {
    throw new AppError("BACKUP_PATHS_REQUIRED", "No checkpoint paths were selected");
  }
  const expected = new Map<string, string | null>();
  for (const filePath of selected) expected.set(filePath, await app.filesystem.hash(filePath));
  const safety = await app.transaction.backups.createCheckpoint(
    selected,
    `Before rollback ${checkpoint.id}`,
  );

  try {
    const restored = await app.transaction.backups.restoreCheckpoint(checkpoint, {
      expectedCurrent: expected,
      paths: selected,
    });
    const validation = await app.client.checkConfig();
    if (validation.result !== "valid") {
      throw new AppError("HA_CONFIG_VALIDATION_FAILED", "Rolled-back configuration is invalid");
    }
    await app.reloadForPaths(restored);
    return { checkpoint, safety_checkpoint: safety, restored, validation };
  } catch (error) {
    let recoveryError: SourceError | null = null;
    try {
      await restoreSafetyCheckpoint(app, safety.id, selected);
    } catch (recovery) {
      recoveryError = errorSummary(recovery);
    }
    throw new AppError("CONFIG_ROLLBACK_FAILED", "Configuration rollback failed", {
      cause: error,
      details: JSON.parse(
        JSON.stringify({
          failure: errorSummary(error),
          safety_checkpoint_id: safety.id,
          recovery_error: recoveryError,
        }),
      ) as JsonValue,
    });
  }
}

async function rollbackHeadCommit(app: Application, hash: string, message: string | undefined) {
  const rollback = await app.transaction.git.rollbackCommit(hash, message);
  try {
    const validation = await app.client.checkConfig();
    if (validation.result !== "valid") {
      throw new AppError("HA_CONFIG_VALIDATION_FAILED", "Rolled-back configuration is invalid");
    }
    await app.client.callService("homeassistant", "reload_all");
    return {
      rollback_commit: rollback,
      validation,
      limitation: "Only the service-owned current HEAD commit can be rolled back safely.",
    };
  } catch (error) {
    let compensation: unknown = null;
    let compensationError: SourceError | null = null;
    try {
      compensation = await app.transaction.git.rollbackCommit(
        rollback.hash,
        `Restore configuration after failed rollback ${rollback.hash.slice(0, 12)}`,
      );
      await app.client.callService("homeassistant", "reload_all");
    } catch (recovery) {
      compensationError = errorSummary(recovery);
    }
    throw new AppError("GIT_ROLLBACK_VALIDATION_FAILED", "Git rollback did not pass validation", {
      cause: error,
      details: JSON.parse(
        JSON.stringify({
          failure: errorSummary(error),
          rollback_commit: rollback.hash,
          compensation,
          compensation_error: compensationError,
        }),
      ) as JsonValue,
    });
  }
}

export function registerConfigurationTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "read_configuration",
    title: "Read Configuration",
    description: "Read configuration.yaml as structured YAML with secret-bearing keys redacted.",
    risk: "READ",
    schema: emptySchema,
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: () => readStructuredYaml(app, "configuration.yaml"),
  });

  registrar.register({
    name: "list_configuration_files",
    title: "List Configuration Files",
    description:
      "List bounded YAML metadata from allowed locations and existence-only protected metadata.",
    risk: "READ",
    schema: z.object(pageFields),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ limit, offset }) => listConfigurationFiles(app, limit, offset),
  });

  registrar.register({
    name: "read_yaml_file",
    title: "Read YAML File",
    description:
      "Read one allowed YAML file as a redacted structure; secrets.yaml returns key metadata only.",
    risk: "READ",
    schema: z.object({ path: configPath }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ path }) => readStructuredYaml(app, path),
  });

  registrar.register({
    name: "list_custom_component_files",
    title: "List Custom Component Files",
    description:
      "List bounded source metadata under enabled custom_components integration directories.",
    risk: "READ",
    schema: z.object({
      integration: z
        .string()
        .regex(/^[a-z0-9_]+$/)
        .optional(),
      ...pageFields,
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ integration, limit, offset }) =>
      listCustomComponentFiles(app, integration, limit, offset),
  });

  registrar.register({
    name: "read_custom_component_source",
    title: "Read Custom Component Source",
    description:
      "Read one allowlisted custom component Python, JSON, or YAML source after explicit deployment opt-in.",
    risk: "READ",
    schema: z.object({ path: configPath }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ path: requestedPath }) => readCustomComponentSource(app, requestedPath),
  });

  registrar.register({
    name: "patch_yaml_file",
    title: "Patch YAML File",
    description:
      "Apply structural set/delete operations through validation, checkpoint, reload, health, and Git workflow.",
    risk: "CONFIG",
    schema: z.object({
      path: configPath,
      operations: z.array(yamlPatch).min(1).max(100),
      reload: z.boolean().default(true),
      commit_message: z.string().trim().min(1).max(4_096).optional(),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: async ({ path, operations, reload, commit_message, dry_run }) => {
      const patches = operations as YamlPatchOperation[];
      assertPatchSecretsAllowed(patches, app.settings.filesystem.allowSecretValues);
      const result = await app.transaction.execute({
        changes: [{ path, patches }],
        dryRun: dry_run,
        reload,
        ...(commit_message === undefined ? {} : { commitMessage: commit_message }),
        backupLabel: `MCP patch ${path}`,
      });
      return {
        ...result,
        diffs: result.diffs.map((diff) =>
          redactConfigDiff(diff, app.settings.filesystem.allowSecretValues),
        ),
      };
    },
  });

  registrar.register({
    name: "validate_configuration",
    title: "Validate Configuration Files",
    description: "Validate the syntax of explicitly allowed YAML files without changing them.",
    risk: "READ",
    schema: z.object({
      paths: z.array(configPath).min(1).max(50).default(["configuration.yaml"]),
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ paths }) => validateLocalFiles(app, paths),
  });

  registrar.register({
    name: "validate_home_assistant_configuration",
    title: "Validate Home Assistant Configuration",
    description: "Ask Home Assistant to validate its complete active configuration.",
    risk: "READ",
    schema: emptySchema,
    source: "rest",
    stability: "public",
    handler: () => app.client.checkConfig(),
  });

  registrar.register({
    name: "reload_configuration",
    title: "Reload Configuration",
    description: "Request Home Assistant's supported all-configuration reload service.",
    risk: "CONFIG",
    schema: z.object({ ...dryRunField, ...confirmationField }),
    source: "rest",
    stability: "public",
    handler: ({ dry_run }) =>
      dry_run
        ? {
            dry_run: true,
            changed: true,
            proposed: { domain: "homeassistant", service: "reload_all" },
          }
        : app.client.callService("homeassistant", "reload_all"),
  });

  registrar.register({
    name: "reload_yaml_configuration",
    title: "Reload YAML Configuration",
    description: "Reload the selected editable YAML-backed Home Assistant resource domain.",
    risk: "CONFIG",
    schema: z.object({
      domain: z.enum(["automation", "script", "scene"]),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "rest",
    stability: "public",
    handler: ({ domain, dry_run }) =>
      dry_run
        ? { dry_run: true, changed: true, proposed: { domain, service: "reload" } }
        : app.client.callService(domain, "reload"),
  });

  registrar.register({
    name: "restart_home_assistant",
    title: "Restart Home Assistant",
    description: "Restart Home Assistant, causing a temporary control-plane and automation outage.",
    risk: "HIGH_IMPACT",
    schema: z.object({ ...dryRunField, ...confirmationField }),
    source: "rest",
    stability: "public",
    destructive: true,
    metadata: {
      restart_required: true,
      causes_temporary_home_assistant_outage: true,
    },
    handler: ({ dry_run }) =>
      dry_run
        ? {
            dry_run: true,
            changed: true,
            impact: "high",
            causes_temporary_home_assistant_outage: true,
            proposed: { domain: "homeassistant", service: "restart" },
          }
        : app.client.callService("homeassistant", "restart"),
  });

  registrar.register({
    name: "get_config_history",
    title: "Get Configuration History",
    description: "Get bounded Git commit history for all configuration or one allowed file.",
    risk: "READ",
    schema: z.object({
      path: configPath.optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: ({ path, limit }) => app.transaction.git.history(path, limit),
  });

  registrar.register({
    name: "get_config_diff",
    title: "Get Configuration Diff",
    description: "Get a bounded Git working-tree diff for explicit allowed configuration paths.",
    risk: "READ",
    schema: z.object({
      paths: z.array(configPath).min(1).max(50).default(["configuration.yaml"]),
      staged: z.boolean().default(false),
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: async ({ paths, staged }) => {
      const diff = await app.transaction.git.diff(paths, staged);
      return {
        ...diff,
        unified: redactUnifiedDiff(diff.unified, app.settings.filesystem.allowSecretValues),
        redacted: !app.settings.filesystem.allowSecretValues,
      };
    },
  });

  registrar.register({
    name: "get_recent_changes",
    title: "Get Recent Configuration Changes",
    description:
      "Get recent Git commits and filesystem transaction checkpoints with isolated errors.",
    risk: "READ",
    schema: z.object({ limit: z.number().int().min(1).max(500).default(20) }),
    source: "filesystem",
    stability: "filesystem_fallback",
    handler: async ({ limit }) => {
      const [commits, checkpoints] = await Promise.allSettled([
        app.transaction.git.recent(limit),
        app.transaction.backups.listCheckpoints(limit),
      ]);
      return {
        commits: commits.status === "fulfilled" ? commits.value : [],
        checkpoints: checkpoints.status === "fulfilled" ? checkpoints.value : [],
        source_errors: [
          ...(commits.status === "rejected"
            ? [{ source: "git", ...errorSummary(commits.reason) }]
            : []),
          ...(checkpoints.status === "rejected"
            ? [{ source: "backups", ...errorSummary(checkpoints.reason) }]
            : []),
        ],
      };
    },
  });

  registrar.register({
    name: "rollback_change",
    title: "Rollback Configuration Change",
    description:
      "Restore an atomic checkpoint with current-hash checks, a safety checkpoint, validation, and reload.",
    risk: "HIGH_IMPACT",
    schema: z.object({
      checkpoint_id: checkpointId,
      paths: z.array(configPath).min(1).max(50).optional(),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    destructive: true,
    handler: async ({ checkpoint_id, paths, dry_run }) => {
      if (!dry_run) return rollbackCheckpoint(app, checkpoint_id, paths);
      const checkpoint = await app.transaction.backups.loadCheckpoint(checkpoint_id);
      const selected = paths ?? checkpoint.entries.map((entry) => entry.path);
      const checkpointPaths = new Set(checkpoint.entries.map((entry) => entry.path));
      if (selected.some((filePath) => !checkpointPaths.has(filePath))) {
        throw new AppError(
          "BACKUP_PATH_NOT_FOUND",
          "A selected path is not present in the checkpoint",
        );
      }
      return {
        dry_run: true,
        changed: true,
        checkpoint,
        selected_paths: selected,
        current_hashes: Object.fromEntries(
          await Promise.all(
            selected.map(async (filePath) => [filePath, await app.filesystem.hash(filePath)]),
          ),
        ),
        limitations: ["No files were restored and Home Assistant validation was not run."],
      };
    },
  });

  registrar.register({
    name: "rollback_to_commit",
    title: "Rollback To Commit",
    description:
      "Safely revert the service-owned current Git HEAD and compensate automatically if validation fails.",
    risk: "HIGH_IMPACT",
    schema: z.object({
      commit: commitHash,
      message: z.string().trim().min(1).max(4_096).optional(),
      ...dryRunField,
      ...confirmationField,
    }),
    source: "filesystem",
    stability: "filesystem_fallback",
    destructive: true,
    handler: async ({ commit, message, dry_run }) => {
      if (!dry_run) return rollbackHeadCommit(app, commit, message);
      const head = (await app.transaction.git.recent(1))[0] ?? null;
      if (head === null || !head.hash.startsWith(commit)) {
        throw new AppError("GIT_ROLLBACK_NOT_HEAD", "Only current HEAD can be rolled back safely");
      }
      if (head.authorEmail !== app.settings.git.authorEmail) {
        throw new AppError(
          "GIT_ROLLBACK_NOT_OWNED",
          "Only commits created by this service can be rolled back",
        );
      }
      return {
        dry_run: true,
        changed: true,
        proposed_head: head,
        message: message ?? `Rollback ${head.hash.slice(0, 12)}: ${head.subject}`,
        limitations: ["No Git or Home Assistant change was made."],
      };
    },
  });
}
