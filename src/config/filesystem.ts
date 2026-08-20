import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../shared/errors.js";
import {
  ConfigPathPolicy,
  type ConfigPathKind,
  type ResolvedConfigPath,
} from "../security/paths.js";
import type { Settings } from "./settings.js";
import { yamlTopLevelKeys } from "./yaml-editor.js";

type FilesystemSettings = Settings["filesystem"];

export interface ConfigFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  modifiedAt: string;
  mode: number;
  kind: Exclude<ConfigPathKind, "secrets_metadata">;
}

export interface ConfigFileMetadata {
  path: string;
  bytes: number;
  modifiedAt: string;
  kind: ConfigPathKind;
  secretKeys?: string[];
}

export interface AtomicWriteOptions {
  /** `null` means the file must not exist. Omit to disable the optimistic concurrency check. */
  expectedSha256?: string | null;
  mode?: number;
}

export interface AtomicDeleteOptions {
  expectedSha256?: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function asFilesystemSettings(settings: Settings | FilesystemSettings): FilesystemSettings {
  return "filesystem" in settings ? settings.filesystem : settings;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support syncing directory descriptors.
    if (!(
      error instanceof Error &&
      "code" in error &&
      ["EINVAL", "ENOTSUP"].includes(error.code as string)
    )) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class ConfigFilesystem {
  readonly policy: ConfigPathPolicy;
  readonly settings: FilesystemSettings;

  constructor(settings: Settings | FilesystemSettings, policy?: ConfigPathPolicy) {
    this.settings = asFilesystemSettings(settings);
    this.policy = policy ?? new ConfigPathPolicy(this.settings);
  }

  private async readResolved(resolved: ResolvedConfigPath): Promise<{
    content: Buffer;
    bytes: number;
    modifiedAt: string;
    mode: number;
    sha256: string;
  }> {
    let handle;
    try {
      handle = await open(resolved.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new AppError(
          "CONFIG_NOT_REGULAR_FILE",
          "The configuration path is not a regular file",
        );
      }
      if (info.size > this.settings.maxReadBytes) {
        throw new AppError(
          "CONFIG_FILE_TOO_LARGE",
          "The configuration file exceeds the read limit",
          {
            details: { bytes: info.size, max_bytes: this.settings.maxReadBytes },
          },
        );
      }

      const buffer = Buffer.alloc(this.settings.maxReadBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, null);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > this.settings.maxReadBytes) {
        throw new AppError(
          "CONFIG_FILE_TOO_LARGE",
          "The configuration file grew beyond the read limit",
          {
            details: { max_bytes: this.settings.maxReadBytes },
          },
        );
      }
      const content = buffer.subarray(0, offset);
      return {
        content,
        bytes: offset,
        modifiedAt: info.mtime.toISOString(),
        mode: info.mode & 0o777,
        sha256: sha256(content),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isMissing(error)) {
        throw new AppError("CONFIG_FILE_NOT_FOUND", "The configuration file does not exist", {
          cause: error,
        });
      }
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        throw new AppError(
          "CONFIG_SYMLINK_DENIED",
          "Symbolic links are not permitted in configuration paths",
          {
            cause: error,
          },
        );
      }
      throw new AppError("CONFIG_READ_FAILED", "Unable to read the configuration file", {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }

  private decode(content: Buffer): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch (error) {
      throw new AppError("CONFIG_NOT_UTF8", "Configuration sources must be valid UTF-8 text", {
        cause: error,
      });
    }
  }

  async readFile(requestedPath: string): Promise<ConfigFile> {
    const resolved = await this.policy.resolve(requestedPath, "read");
    if (resolved.kind === "secrets_metadata") {
      throw new AppError(
        "SECRET_VALUES_DENIED",
        "Secret values are never accessible through the filesystem API",
      );
    }
    const file = await this.readResolved(resolved);
    return {
      path: resolved.relativePath,
      content: this.decode(file.content),
      bytes: file.bytes,
      sha256: file.sha256,
      modifiedAt: file.modifiedAt,
      mode: file.mode,
      kind: resolved.kind,
    };
  }

  async readFileIfExists(requestedPath: string): Promise<ConfigFile | null> {
    const resolved = await this.policy.resolve(requestedPath, "write");
    if (!resolved.exists) return null;
    const file = await this.readResolved(resolved);
    return {
      path: resolved.relativePath,
      content: this.decode(file.content),
      bytes: file.bytes,
      sha256: file.sha256,
      modifiedAt: file.modifiedAt,
      mode: file.mode,
      kind: resolved.kind as Exclude<ConfigPathKind, "secrets_metadata">,
    };
  }

  async metadata(requestedPath: string): Promise<ConfigFileMetadata> {
    const resolved = await this.policy.resolve(requestedPath, "metadata");
    const file = await this.readResolved(resolved);
    const result: ConfigFileMetadata = {
      path: resolved.relativePath,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      kind: resolved.kind,
    };
    if (resolved.kind === "secrets_metadata") {
      try {
        result.secretKeys = yamlTopLevelKeys(this.decode(file.content));
      } catch (error) {
        throw new AppError("INVALID_SECRETS_YAML", "Unable to read secrets.yaml metadata", {
          cause: error,
        });
      }
    }
    return result;
  }

  async hash(requestedPath: string): Promise<string | null> {
    const file = await this.readFileIfExists(requestedPath);
    return file?.sha256 ?? null;
  }

  private async assertExpected(
    requestedPath: string,
    expectedSha256: string | null | undefined,
  ): Promise<ConfigFile | null> {
    const current = await this.readFileIfExists(requestedPath);
    if (expectedSha256 !== undefined && (current?.sha256 ?? null) !== expectedSha256) {
      throw new AppError(
        "CONFIG_CONCURRENT_MODIFICATION",
        "The configuration file changed during the operation",
        {
          details: { path: current?.path ?? requestedPath },
        },
      );
    }
    return current;
  }

  async writeFileAtomic(
    requestedPath: string,
    content: string,
    options: AtomicWriteOptions = {},
  ): Promise<ConfigFile> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > this.settings.maxReadBytes) {
      throw new AppError(
        "CONFIG_FILE_TOO_LARGE",
        "The configuration source exceeds the configured size limit",
        {
          details: { bytes: bytes.byteLength, max_bytes: this.settings.maxReadBytes },
        },
      );
    }

    const resolved = await this.policy.resolve(requestedPath, "write");
    const current = await this.assertExpected(resolved.relativePath, options.expectedSha256);
    const mode = options.mode ?? current?.mode ?? 0o600;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new AppError("INVALID_FILE_MODE", "The requested configuration file mode is invalid");
    }

    const temporaryPath = path.join(
      path.dirname(resolved.absolutePath),
      `.${path.basename(resolved.absolutePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle;
    let temporaryExists = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      );
      temporaryExists = true;
      await handle.chmod(mode);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.assertExpected(resolved.relativePath, options.expectedSha256);
      const rechecked = await this.policy.resolve(resolved.relativePath, "write");
      if (rechecked.absolutePath !== resolved.absolutePath) {
        throw new AppError(
          "CONFIG_PATH_CHANGED",
          "The configuration path changed during the operation",
        );
      }
      await rename(temporaryPath, resolved.absolutePath);
      temporaryExists = false;
      await syncDirectory(path.dirname(resolved.absolutePath));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "CONFIG_WRITE_FAILED",
        "Unable to atomically write the configuration file",
        {
          cause: error,
        },
      );
    } finally {
      await handle?.close();
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    }
    return this.readFile(resolved.relativePath);
  }

  async deleteFileAtomic(requestedPath: string, options: AtomicDeleteOptions = {}): Promise<void> {
    const resolved = await this.policy.resolve(requestedPath, "write");
    if (!resolved.exists) {
      if (options.expectedSha256 !== undefined) {
        throw new AppError(
          "CONFIG_CONCURRENT_MODIFICATION",
          "The configuration file no longer exists",
        );
      }
      return;
    }
    await this.assertExpected(resolved.relativePath, options.expectedSha256);
    const rechecked = await this.policy.resolve(resolved.relativePath, "write");
    if (rechecked.absolutePath !== resolved.absolutePath || !rechecked.exists) {
      throw new AppError(
        "CONFIG_PATH_CHANGED",
        "The configuration path changed during the operation",
      );
    }
    try {
      await unlink(resolved.absolutePath);
      await syncDirectory(path.dirname(resolved.absolutePath));
    } catch (error) {
      throw new AppError("CONFIG_DELETE_FAILED", "Unable to remove the configuration file", {
        cause: error,
      });
    }
  }
}

export async function readConfigFile(
  settings: Settings,
  requestedPath: string,
): Promise<ConfigFile> {
  return new ConfigFilesystem(settings).readFile(requestedPath);
}

export async function writeConfigFileAtomic(
  settings: Settings,
  requestedPath: string,
  content: string,
  options?: AtomicWriteOptions,
): Promise<ConfigFile> {
  return new ConfigFilesystem(settings).writeFileAtomic(requestedPath, content, options);
}
