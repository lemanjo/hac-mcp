import { constants } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../shared/errors.js";
import type { Settings } from "./settings.js";
import { ConfigFilesystem } from "./filesystem.js";

export interface BackupEntry {
  path: string;
  existed: boolean;
  sha256: string | null;
  mode: number | null;
  storageFile: string | null;
}

export interface BackupCheckpoint {
  id: string;
  createdAt: string;
  label: string | null;
  entries: BackupEntry[];
}

export interface RestoreCheckpointOptions {
  expectedCurrent: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>;
  paths?: readonly string[];
}

const CHECKPOINT_ID = /^\d{8}T\d{9}Z-[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_LIMIT = 1_048_576;

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function checkpointId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${randomBytes(8).toString("hex")}`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isReadonlyMap(
  values: RestoreCheckpointOptions["expectedCurrent"],
): values is ReadonlyMap<string, string | null> {
  return values instanceof Map;
}

function expectedValue(
  values: RestoreCheckpointOptions["expectedCurrent"],
  filePath: string,
): { present: boolean; value: string | null } {
  if (isReadonlyMap(values)) {
    return { present: values.has(filePath), value: values.get(filePath) ?? null };
  }
  return {
    present: Object.prototype.hasOwnProperty.call(values, filePath),
    value: values[filePath] ?? null,
  };
}

async function writeExclusive(filePath: string, content: Buffer | string): Promise<void> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function readBounded(filePath: string, limit: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) {
      throw new AppError("INVALID_BACKUP", "A backup file is invalid or exceeds its size limit");
    }
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > limit)
      throw new AppError("INVALID_BACKUP", "A backup file exceeds its size limit");
    return buffer.subarray(0, offset);
  } finally {
    await handle?.close();
  }
}

function parseManifest(value: unknown): BackupCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_BACKUP", "The backup manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.id !== "string" ||
    !CHECKPOINT_ID.test(manifest.id) ||
    typeof manifest.createdAt !== "string" ||
    (manifest.label !== null && typeof manifest.label !== "string") ||
    !Array.isArray(manifest.entries)
  ) {
    throw new AppError("INVALID_BACKUP", "The backup manifest is invalid");
  }

  const entries = manifest.entries.map((raw): BackupEntry => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError("INVALID_BACKUP", "A backup manifest entry is invalid");
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.existed !== "boolean" ||
      (entry.sha256 !== null && (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256))) ||
      (entry.mode !== null && (typeof entry.mode !== "number" || !Number.isInteger(entry.mode))) ||
      (entry.storageFile !== null &&
        (typeof entry.storageFile !== "string" || !/^\d{4}\.data$/.test(entry.storageFile)))
    ) {
      throw new AppError("INVALID_BACKUP", "A backup manifest entry is invalid");
    }
    if (
      entry.existed !== true &&
      (entry.sha256 !== null || entry.mode !== null || entry.storageFile !== null)
    ) {
      throw new AppError("INVALID_BACKUP", "A backup manifest entry is inconsistent");
    }
    if (
      entry.existed === true &&
      (entry.sha256 === null || entry.mode === null || entry.storageFile === null)
    ) {
      throw new AppError("INVALID_BACKUP", "A backup manifest entry is incomplete");
    }
    return {
      path: entry.path,
      existed: entry.existed,
      sha256: entry.sha256,
      mode: entry.mode,
      storageFile: entry.storageFile,
    };
  });

  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    label: manifest.label,
    entries,
  };
}

export class BackupManager {
  constructor(
    private readonly settings: Settings,
    readonly filesystem = new ConfigFilesystem(settings),
  ) {}

  private async backupRoot(): Promise<string> {
    const candidate = await this.filesystem.policy.resolveInternal(
      this.settings.filesystem.backupDirectory,
    );
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const checked = await this.filesystem.policy.resolveInternal(candidate, true);
    if (checked !== candidate) {
      throw new AppError(
        "BACKUP_PATH_CHANGED",
        "The backup directory changed while it was being created",
      );
    }
    return checked;
  }

  async createCheckpoint(
    paths: readonly string[],
    label: string | null = null,
  ): Promise<BackupCheckpoint> {
    if (paths.length === 0)
      throw new AppError("BACKUP_PATHS_REQUIRED", "At least one configuration path is required");
    if (label !== null && (label.length > 200 || hasControlCharacter(label))) {
      throw new AppError("INVALID_BACKUP_LABEL", "The backup label is invalid");
    }

    const files = [];
    const seen = new Set<string>();
    for (const requestedPath of paths) {
      const file = await this.filesystem.readFileIfExists(requestedPath);
      const resolved = await this.filesystem.policy.resolve(requestedPath, "write");
      if (seen.has(resolved.relativePath)) {
        throw new AppError(
          "DUPLICATE_CONFIG_PATH",
          "A configuration path was specified more than once",
        );
      }
      seen.add(resolved.relativePath);
      files.push({ path: resolved.relativePath, file });
    }

    const root = await this.backupRoot();
    const id = checkpointId();
    const directory = path.join(root, id);
    await mkdir(directory, { mode: 0o700 });
    try {
      const entries: BackupEntry[] = [];
      for (const [index, source] of files.entries()) {
        if (source.file === null) {
          entries.push({
            path: source.path,
            existed: false,
            sha256: null,
            mode: null,
            storageFile: null,
          });
          continue;
        }
        const storageFile = `${String(index).padStart(4, "0")}.data`;
        await writeExclusive(path.join(directory, storageFile), source.file.content);
        entries.push({
          path: source.path,
          existed: true,
          sha256: source.file.sha256,
          mode: source.file.mode,
          storageFile,
        });
      }
      const manifest: BackupCheckpoint = {
        id,
        createdAt: new Date().toISOString(),
        label,
        entries,
      };
      await writeExclusive(
        path.join(directory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      return manifest;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_FAILED", "Unable to create a configuration checkpoint", {
        cause: error,
      });
    }
  }

  async loadCheckpoint(id: string): Promise<BackupCheckpoint> {
    if (!CHECKPOINT_ID.test(id))
      throw new AppError("INVALID_BACKUP_ID", "The backup checkpoint id is invalid");
    const root = await this.backupRoot();
    const manifestPath = await this.filesystem.policy.resolveInternal(
      path.join(root, id, "manifest.json"),
      true,
    );
    try {
      const content = await readBounded(manifestPath, MANIFEST_LIMIT);
      const manifest = parseManifest(JSON.parse(content.toString("utf8")));
      if (manifest.id !== id)
        throw new AppError("INVALID_BACKUP", "The backup manifest id does not match");
      const seen = new Set<string>();
      for (const entry of manifest.entries) {
        const resolved = await this.filesystem.policy.resolve(entry.path, "write");
        if (resolved.relativePath !== entry.path || seen.has(entry.path)) {
          throw new AppError("INVALID_BACKUP", "The backup contains an invalid configuration path");
        }
        seen.add(entry.path);
      }
      return manifest;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_BACKUP", "Unable to load the backup checkpoint", {
        cause: error,
      });
    }
  }

  async listCheckpoints(limit = 50): Promise<BackupCheckpoint[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const root = await this.backupRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && CHECKPOINT_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, boundedLimit);
    const checkpoints: BackupCheckpoint[] = [];
    for (const id of ids) {
      try {
        checkpoints.push(await this.loadCheckpoint(id));
      } catch {
        // A partial or externally modified checkpoint is never presented as usable.
      }
    }
    return checkpoints;
  }

  async restoreCheckpoint(
    checkpointOrId: BackupCheckpoint | string,
    options: RestoreCheckpointOptions,
  ): Promise<string[]> {
    const checkpoint =
      typeof checkpointOrId === "string"
        ? await this.loadCheckpoint(checkpointOrId)
        : await this.loadCheckpoint(checkpointOrId.id);
    const requested = options.paths === undefined ? null : new Set(options.paths);
    const selected = checkpoint.entries.filter(
      (entry) => requested === null || requested.has(entry.path),
    );
    if (selected.length === 0)
      throw new AppError("BACKUP_PATHS_REQUIRED", "No checkpoint paths were selected");
    if (requested !== null && selected.length !== requested.size) {
      throw new AppError(
        "BACKUP_PATH_NOT_FOUND",
        "A selected path is not present in the checkpoint",
      );
    }

    const expected = new Map<string, string | null>();
    for (const entry of selected) {
      const expectation = expectedValue(options.expectedCurrent, entry.path);
      if (!expectation.present) {
        throw new AppError(
          "ROLLBACK_EXPECTATION_REQUIRED",
          "Rollback requires an expected hash for every file",
        );
      }
      const current = await this.filesystem.hash(entry.path);
      if (current !== expectation.value) {
        throw new AppError(
          "ROLLBACK_CONFLICT",
          "Rollback refused to overwrite a concurrently modified file",
          {
            details: { path: entry.path },
          },
        );
      }
      expected.set(entry.path, expectation.value);
    }

    const root = await this.backupRoot();
    const directory = path.join(root, checkpoint.id);
    for (const entry of selected) {
      const currentHash = expected.get(entry.path) ?? null;
      if (!entry.existed) {
        if (currentHash !== null) {
          await this.filesystem.deleteFileAtomic(entry.path, { expectedSha256: currentHash });
        }
        continue;
      }
      if (entry.storageFile === null || entry.sha256 === null || entry.mode === null) {
        throw new AppError("INVALID_BACKUP", "A backup entry is incomplete");
      }
      const storagePath = await this.filesystem.policy.resolveInternal(
        path.join(directory, entry.storageFile),
        true,
      );
      const content = await readBounded(storagePath, this.settings.filesystem.maxReadBytes);
      if (digest(content) !== entry.sha256) {
        throw new AppError("BACKUP_INTEGRITY_FAILED", "A backup file failed its integrity check");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch (error) {
        throw new AppError("INVALID_BACKUP", "A backup source is not valid UTF-8", {
          cause: error,
        });
      }
      await this.filesystem.writeFileAtomic(entry.path, text, {
        expectedSha256: currentHash,
        mode: entry.mode,
      });
    }
    return selected.map((entry) => entry.path);
  }
}
