import path from "node:path";
import { createHash } from "node:crypto";
import { createTwoFilesPatch, structuredPatch } from "diff";

import { AppError } from "../shared/errors.js";
import type { ConfigPathKind } from "../security/paths.js";
import { BackupManager, type BackupCheckpoint } from "./backups.js";
import { ConfigFilesystem, type ConfigFile } from "./filesystem.js";
import { GitClient, type GitCommit } from "./git.js";
import type { Settings } from "./settings.js";
import { applyYamlPatches, type YamlPatchOperation, validateYaml } from "./yaml-editor.js";

export type ConfigChange =
  | { path: string; patches: readonly YamlPatchOperation[]; content?: never }
  | { path: string; content: string; patches?: never };

export interface ConfigTransactionRequest {
  changes: readonly ConfigChange[];
  dryRun?: boolean;
  reload?: boolean;
  commit?: boolean;
  commitMessage?: string;
  backupLabel?: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ConfigUnifiedDiff {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  additions: number;
  deletions: number;
  hunks: UnifiedDiffHunk[];
  unified: string;
}

export interface ConfigTransactionContext {
  paths: readonly string[];
  diffs: readonly ConfigUnifiedDiff[];
  checkpointId: string;
  rollback: boolean;
}

export type ConfigCallbackOutcome = void | boolean | { ok: boolean; message?: string };

export interface HomeAssistantConfigCallbacks {
  validate?: (context: ConfigTransactionContext) => Promise<ConfigCallbackOutcome>;
  reload?: (context: ConfigTransactionContext) => Promise<ConfigCallbackOutcome>;
  health?: (context: ConfigTransactionContext) => Promise<ConfigCallbackOutcome>;
  localValidate?: (
    path: string,
    content: string,
    kind: ConfigPathKind,
  ) => Promise<ConfigCallbackOutcome>;
}

export interface ConfigTransactionDependencies {
  filesystem?: ConfigFilesystem;
  backups?: BackupManager;
  git?: GitClient;
}

export interface ConfigTransactionResult {
  changed: boolean;
  dryRun: boolean;
  paths: string[];
  diffs: ConfigUnifiedDiff[];
  checkpoint?: BackupCheckpoint;
  gitCommit?: GitCommit;
  warnings: string[];
}

interface PreparedChange {
  path: string;
  before: ConfigFile | null;
  content: string;
  afterSha256: string;
  kind: Exclude<ConfigPathKind, "secrets_metadata">;
  diff: ConfigUnifiedDiff;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function callbackFailed(outcome: ConfigCallbackOutcome): string | null {
  if (outcome === false) return "The callback returned false";
  if (outcome && typeof outcome === "object" && !outcome.ok) {
    return outcome.message ?? "The callback returned an unsuccessful result";
  }
  return null;
}

async function invokeCallback(
  name: string,
  callback: ((context: ConfigTransactionContext) => Promise<ConfigCallbackOutcome>) | undefined,
  context: ConfigTransactionContext,
): Promise<boolean> {
  if (callback === undefined) return false;
  let outcome: ConfigCallbackOutcome;
  try {
    outcome = await callback(context);
  } catch (error) {
    throw new AppError("CONFIG_CALLBACK_FAILED", `Home Assistant ${name} callback failed`, {
      cause: error,
    });
  }
  const failure = callbackFailed(outcome);
  if (failure !== null) {
    throw new AppError(
      "CONFIG_CALLBACK_REJECTED",
      `Home Assistant ${name} callback rejected the change`,
      {
        details: { callback: name, reason: failure },
      },
    );
  }
  return true;
}

export function createStructuredUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  beforeSha256: string | null = digest(before),
): ConfigUnifiedDiff {
  const oldName = `a/${filePath}`;
  const newName = `b/${filePath}`;
  const patch = structuredPatch(oldName, newName, before, after, "before", "after", { context: 3 });
  const hunks = patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: [...hunk.lines],
  }));
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return {
    path: filePath,
    beforeSha256,
    afterSha256: digest(after),
    additions,
    deletions,
    hunks,
    unified: createTwoFilesPatch(oldName, newName, before, after, "before", "after", {
      context: 3,
    }),
  };
}

export class ConfigTransaction {
  readonly filesystem: ConfigFilesystem;
  readonly backups: BackupManager;
  readonly git: GitClient;
  private running = false;

  constructor(
    private readonly settings: Settings,
    private readonly callbacks: HomeAssistantConfigCallbacks = {},
    dependencies: ConfigTransactionDependencies = {},
  ) {
    this.filesystem = dependencies.filesystem ?? new ConfigFilesystem(settings);
    this.backups = dependencies.backups ?? new BackupManager(settings, this.filesystem);
    this.git = dependencies.git ?? new GitClient(settings, this.filesystem.policy);
  }

  private async localValidate(
    filePath: string,
    content: string,
    kind: ConfigPathKind,
  ): Promise<void> {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".yaml" || extension === ".yml") {
      validateYaml(content);
    } else if (extension === ".json") {
      try {
        JSON.parse(content);
      } catch (error) {
        throw new AppError("INVALID_JSON", "The custom component JSON source is invalid", {
          cause: error,
        });
      }
    } else if (extension === ".py" || extension === ".pyi") {
      if (content.includes("\u0000")) {
        throw new AppError("INVALID_SOURCE", "Custom component Python source contains a null byte");
      }
      if (this.callbacks.localValidate === undefined) {
        throw new AppError(
          "LOCAL_VALIDATOR_REQUIRED",
          "A local Python syntax validator is required for custom component source changes",
        );
      }
    }

    if (this.callbacks.localValidate !== undefined) {
      let outcome: ConfigCallbackOutcome;
      try {
        outcome = await this.callbacks.localValidate(filePath, content, kind);
      } catch (error) {
        throw new AppError("LOCAL_VALIDATION_FAILED", "Local source validation failed", {
          cause: error,
        });
      }
      const failure = callbackFailed(outcome);
      if (failure !== null) {
        throw new AppError(
          "LOCAL_VALIDATION_FAILED",
          "Local source validation rejected the change",
          {
            details: { path: filePath, reason: failure },
          },
        );
      }
    }
  }

  private async prepare(changes: readonly ConfigChange[]): Promise<PreparedChange[]> {
    if (changes.length === 0) {
      throw new AppError(
        "CONFIG_CHANGES_REQUIRED",
        "At least one configuration change is required",
      );
    }
    const prepared: PreparedChange[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      const resolved = await this.filesystem.policy.resolve(change.path, "write");
      if (resolved.kind === "secrets_metadata") {
        throw new AppError(
          "SECRET_VALUES_DENIED",
          "secrets.yaml cannot be changed through this API",
        );
      }
      if (seen.has(resolved.relativePath)) {
        throw new AppError(
          "DUPLICATE_CONFIG_PATH",
          "A configuration path was changed more than once",
        );
      }
      seen.add(resolved.relativePath);
      const before = await this.filesystem.readFileIfExists(resolved.relativePath);
      let content: string;
      if ("patches" in change && change.patches !== undefined) {
        if (!resolved.relativePath.endsWith(".yaml") && !resolved.relativePath.endsWith(".yml")) {
          throw new AppError(
            "YAML_PATCH_REQUIRED",
            "Structural patches can only be applied to YAML files",
          );
        }
        content = applyYamlPatches(before?.content ?? "", change.patches).content;
      } else if ("content" in change && typeof change.content === "string") {
        content = change.content;
      } else {
        throw new AppError(
          "INVALID_CONFIG_CHANGE",
          "A config change must contain content or YAML patches",
        );
      }

      await this.localValidate(resolved.relativePath, content, resolved.kind);
      const afterSha256 = digest(content);
      if (before?.sha256 === afterSha256) continue;
      const diff = createStructuredUnifiedDiff(
        resolved.relativePath,
        before?.content ?? "",
        content,
        before?.sha256 ?? null,
      );
      prepared.push({
        path: resolved.relativePath,
        before,
        content,
        afterSha256,
        kind: resolved.kind,
        diff,
      });
    }
    return prepared;
  }

  private async rollback(
    checkpoint: BackupCheckpoint,
    applied: readonly PreparedChange[],
    diffs: readonly ConfigUnifiedDiff[],
  ): Promise<{ restored: boolean; error: string | null }> {
    if (applied.length === 0) return { restored: true, error: null };
    const expected = new Map(applied.map((change) => [change.path, change.afterSha256]));
    try {
      await this.backups.restoreCheckpoint(checkpoint, {
        expectedCurrent: expected,
        paths: applied.map((change) => change.path),
      });
      const context: ConfigTransactionContext = {
        paths: applied.map((change) => change.path),
        diffs,
        checkpointId: checkpoint.id,
        rollback: true,
      };
      try {
        await invokeCallback("reload after rollback", this.callbacks.reload, context);
        await invokeCallback("health after rollback", this.callbacks.health, context);
      } catch (error) {
        return {
          restored: true,
          error:
            error instanceof Error
              ? error.message
              : "Home Assistant did not recover after rollback",
        };
      }
      return { restored: true, error: null };
    } catch (error) {
      return {
        restored: false,
        error: error instanceof Error ? error.message : "Rollback failed",
      };
    }
  }

  async execute(request: ConfigTransactionRequest): Promise<ConfigTransactionResult> {
    if (this.running) {
      throw new AppError(
        "CONFIG_TRANSACTION_IN_PROGRESS",
        "Another configuration transaction is in progress",
      );
    }
    this.running = true;
    try {
      const prepared = await this.prepare(request.changes);
      const paths = prepared.map((change) => change.path);
      const diffs = prepared.map((change) => change.diff);
      const warnings: string[] = [];
      if (prepared.length === 0) {
        return { changed: false, dryRun: request.dryRun === true, paths, diffs, warnings };
      }
      if (request.dryRun === true) {
        return { changed: true, dryRun: true, paths, diffs, warnings };
      }

      const shouldCommit = request.commit ?? this.settings.git.enabled;
      let gitRepositoryAvailable = false;
      let preexistingGitChanges: string[] = [];
      if (shouldCommit) {
        try {
          gitRepositoryAvailable = (await this.git.detect()) !== null;
          if (gitRepositoryAvailable) {
            preexistingGitChanges = (await this.git.status(paths)).map((entry) => entry.path);
          } else {
            warnings.push("Git is enabled but no repository was detected");
          }
        } catch (error) {
          warnings.push(
            `Git preflight failed: ${error instanceof AppError ? error.code : "UNKNOWN"}`,
          );
        }
      }

      const checkpoint = await this.backups.createCheckpoint(
        paths,
        request.backupLabel ?? "config transaction",
      );
      for (const entry of checkpoint.entries) {
        const planned = prepared.find((change) => change.path === entry.path);
        if (planned === undefined || entry.sha256 !== (planned.before?.sha256 ?? null)) {
          throw new AppError(
            "CONFIG_CONCURRENT_MODIFICATION",
            "A configuration file changed before apply",
            {
              details: { path: entry.path },
            },
          );
        }
      }

      const applied: PreparedChange[] = [];
      try {
        for (const change of prepared) {
          await this.filesystem.writeFileAtomic(change.path, change.content, {
            expectedSha256: change.before?.sha256 ?? null,
            ...(change.before === null ? {} : { mode: change.before.mode }),
          });
          applied.push(change);
        }
        const context: ConfigTransactionContext = {
          paths,
          diffs,
          checkpointId: checkpoint.id,
          rollback: false,
        };
        const validated = await invokeCallback("validation", this.callbacks.validate, context);
        if (!validated) warnings.push("No Home Assistant validation callback was configured");
        if (request.reload !== false) {
          const reloaded = await invokeCallback("reload", this.callbacks.reload, context);
          if (!reloaded) warnings.push("No Home Assistant reload callback was configured");
        }
        const healthy = await invokeCallback("health", this.callbacks.health, context);
        if (!healthy) warnings.push("No Home Assistant health callback was configured");
      } catch (error) {
        const rollback = await this.rollback(checkpoint, applied, diffs);
        throw new AppError("CONFIG_TRANSACTION_FAILED", "The configuration transaction failed", {
          cause: error,
          details: {
            cause_code: error instanceof AppError ? error.code : "UNKNOWN",
            checkpoint_id: checkpoint.id,
            rollback_restored_files: rollback.restored,
            rollback_error: rollback.error,
          },
        });
      }

      let gitCommit: GitCommit | undefined;
      if (shouldCommit && gitRepositoryAvailable) {
        if (preexistingGitChanges.length > 0) {
          warnings.push(
            `Git commit skipped because target files had pre-existing changes: ${preexistingGitChanges.join(", ")}`,
          );
        } else {
          const message =
            request.commitMessage ??
            `Update Home Assistant config: ${paths.length === 1 ? paths[0] : `${paths.length} files`}`;
          try {
            gitCommit = await this.git.commitFiles(paths, { message });
          } catch (error) {
            warnings.push(
              `Git commit failed: ${error instanceof AppError ? error.code : "UNKNOWN"}`,
            );
          }
        }
      }

      return {
        changed: true,
        dryRun: false,
        paths,
        diffs,
        checkpoint,
        ...(gitCommit === undefined ? {} : { gitCommit }),
        warnings,
      };
    } finally {
      this.running = false;
    }
  }
}
