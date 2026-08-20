import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { Settings } from "../config/settings.js";
import { AppError } from "../shared/errors.js";

export type ConfigPathOperation = "metadata" | "read" | "write";
export type ConfigPathKind = "yaml" | "custom_component" | "secrets_metadata";

export interface ResolvedConfigPath {
  absolutePath: string;
  relativePath: string;
  kind: ConfigPathKind;
  exists: boolean;
}

export interface ResolveWithinRootOptions {
  mustExist?: boolean;
  requireParent?: boolean;
}

type FilesystemSettings = Settings["filesystem"];

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const CUSTOM_COMPONENT_EXTENSIONS = new Set([".json", ".py", ".pyi", ".yaml", ".yml"]);
const PRIVATE_KEY_EXTENSIONS = new Set([".der", ".key", ".p12", ".pfx", ".pem"]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function canonicalConfigRoot(configuredRoot: string): Promise<string> {
  try {
    const root = await realpath(path.resolve(configuredRoot));
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throw new AppError(
      "CONFIG_ROOT_UNAVAILABLE",
      "The Home Assistant configuration root is unavailable",
      { cause: error },
    );
  }
}

function normalizedRelativePath(root: string, requestedPath: string): string {
  if (requestedPath.length === 0 || hasControlCharacter(requestedPath)) {
    throw new AppError(
      "INVALID_CONFIG_PATH",
      "Configuration path is empty or contains control characters",
    );
  }
  if (requestedPath.includes("\\")) {
    throw new AppError("INVALID_CONFIG_PATH", "Configuration paths must use forward slashes");
  }

  let relative: string;
  if (path.isAbsolute(requestedPath)) {
    relative = path.relative(root, path.resolve(requestedPath));
  } else {
    const segments = requestedPath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new AppError(
        "INVALID_CONFIG_PATH",
        "Configuration path contains an invalid path segment",
      );
    }
    relative = requestedPath;
  }

  const normalized = path.normalize(relative);
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    throw new AppError(
      "CONFIG_PATH_OUTSIDE_ROOT",
      "Configuration path is outside the Home Assistant root",
    );
  }
  return normalized.split(path.sep).join("/");
}

function safeConfiguredDirectory(directory: string): string {
  if (
    directory.length === 0 ||
    path.isAbsolute(directory) ||
    directory.includes("\\") ||
    hasControlCharacter(directory)
  ) {
    throw new AppError("INVALID_CONFIGURATION", "A filesystem allowlist directory is invalid");
  }
  const segments = directory.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AppError("INVALID_CONFIGURATION", "A filesystem allowlist directory is invalid");
  }
  return segments.join("/");
}

function classifyPath(
  relativePath: string,
  settings: FilesystemSettings,
  operation: ConfigPathOperation,
): ConfigPathKind {
  const segments = relativePath.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments.at(-1) ?? "";
  const extension = path.extname(basename);

  if (lowerSegments.some((segment) => segment === ".storage" || segment === ".git")) {
    throw new AppError(
      "SENSITIVE_CONFIG_PATH",
      "Home Assistant storage and repository internals are not accessible",
    );
  }
  if (
    lowerSegments.some((segment) => segment === "auth" || segment.startsWith(".auth")) ||
    /(^|[._-])(auth|credentials?|token|backup[_-]?key)([._-]|$)/i.test(basename)
  ) {
    throw new AppError("SENSITIVE_CONFIG_PATH", "Authentication data is not accessible");
  }
  if (
    PRIVATE_KEY_EXTENSIONS.has(extension) ||
    /(^|[._-])(id_rsa|id_dsa|id_ecdsa|id_ed25519|private[_-]?key)([._-]|$)/i.test(basename)
  ) {
    throw new AppError("SENSITIVE_CONFIG_PATH", "Private key material is not accessible");
  }
  if (
    extension === ".db" ||
    extension === ".sqlite" ||
    extension === ".sqlite3" ||
    /\.(db|sqlite|sqlite3)-(shm|wal)$/i.test(basename)
  ) {
    throw new AppError("SENSITIVE_CONFIG_PATH", "Database files are not accessible");
  }

  if (basename === "secrets.yaml" || basename === "secrets.yml") {
    if (settings.allowSecretValues && operation !== "metadata") return "yaml";
    if (
      operation !== "metadata" ||
      settings.allowSecretsMetadata !== true ||
      segments.length !== 1
    ) {
      throw new AppError(
        "SECRET_VALUES_DENIED",
        "Secret values are never accessible through the filesystem API",
      );
    }
    return "secrets_metadata";
  }

  if (lowerSegments[0] === "custom_components") {
    if (
      !settings.allowCustomComponents ||
      segments.length < 3 ||
      !CUSTOM_COMPONENT_EXTENSIONS.has(extension)
    ) {
      throw new AppError(
        "CONFIG_PATH_NOT_ALLOWED",
        "Custom component source access is not enabled for this path",
      );
    }
    return "custom_component";
  }

  if (!YAML_EXTENSIONS.has(extension)) {
    throw new AppError("CONFIG_PATH_NOT_ALLOWED", "Only YAML configuration files are accessible");
  }
  if (segments.length === 1) return "yaml";

  const allowed = settings.allowedDirectories.map(safeConfiguredDirectory);
  if (!allowed.some((directory) => relativePath.startsWith(`${directory}/`))) {
    throw new AppError(
      "CONFIG_PATH_NOT_ALLOWED",
      "The configuration path is not in an allowed directory",
    );
  }
  return "yaml";
}

/**
 * Resolve an existing or prospective path and reject every symlink below root.
 * Rejecting in-root symlinks as well avoids a later link swap changing the security decision.
 */
export async function resolveWithinRoot(
  configuredRoot: string,
  requestedPath: string,
  options: ResolveWithinRootOptions = {},
): Promise<{ root: string; absolutePath: string; relativePath: string; exists: boolean }> {
  const lexicalRoot = path.resolve(configuredRoot);
  const root = await canonicalConfigRoot(lexicalRoot);

  let relativePath: string;
  if (path.isAbsolute(requestedPath)) {
    const absolute = path.resolve(requestedPath);
    if (isWithin(lexicalRoot, absolute)) {
      relativePath = normalizedRelativePath(lexicalRoot, absolute);
    } else if (isWithin(root, absolute)) {
      relativePath = normalizedRelativePath(root, absolute);
    } else {
      throw new AppError(
        "CONFIG_PATH_OUTSIDE_ROOT",
        "Configuration path is outside the Home Assistant root",
      );
    }
  } else {
    relativePath = normalizedRelativePath(root, requestedPath);
  }

  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(root, absolutePath)) {
    throw new AppError(
      "CONFIG_PATH_OUTSIDE_ROOT",
      "Configuration path is outside the Home Assistant root",
    );
  }

  let exists = true;
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new AppError(
          "CONFIG_SYMLINK_DENIED",
          "Symbolic links are not permitted in configuration paths",
        );
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new AppError("INVALID_CONFIG_PATH", "A configuration path parent is not a directory");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      exists = false;
      if (options.requireParent && index < segments.length - 1) {
        throw new AppError(
          "CONFIG_PARENT_MISSING",
          "The configuration file parent directory does not exist",
        );
      }
      break;
    }
  }

  if (exists) {
    const canonical = await realpath(absolutePath);
    if (!isWithin(root, canonical)) {
      throw new AppError(
        "CONFIG_SYMLINK_ESCAPE",
        "The configuration path resolves outside its root",
      );
    }
  } else if (options.mustExist) {
    throw new AppError("CONFIG_FILE_NOT_FOUND", "The configuration file does not exist");
  }

  if (options.requireParent) {
    const parent = path.dirname(absolutePath);
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
    } catch (error) {
      throw new AppError(
        "CONFIG_PARENT_MISSING",
        "The configuration file parent directory does not exist",
        {
          cause: error,
        },
      );
    }
    if (!isWithin(root, canonicalParent)) {
      throw new AppError(
        "CONFIG_SYMLINK_ESCAPE",
        "The configuration file parent resolves outside its root",
      );
    }
  }

  return { root, absolutePath, relativePath, exists };
}

export class ConfigPathPolicy {
  readonly settings: FilesystemSettings;

  constructor(settings: Settings | FilesystemSettings) {
    this.settings = "filesystem" in settings ? settings.filesystem : settings;
  }

  async root(): Promise<string> {
    return canonicalConfigRoot(this.settings.root);
  }

  async resolve(
    requestedPath: string,
    operation: ConfigPathOperation = "read",
  ): Promise<ResolvedConfigPath> {
    if (!this.settings.enabled) {
      throw new AppError("FILESYSTEM_DISABLED", "Home Assistant filesystem access is disabled");
    }
    const resolved = await resolveWithinRoot(this.settings.root, requestedPath, {
      mustExist: operation !== "write",
      requireParent: operation === "write",
    });
    const kind = classifyPath(resolved.relativePath, this.settings, operation);
    return {
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      kind,
      exists: resolved.exists,
    };
  }

  async resolveInternal(requestedPath: string, mustExist = false): Promise<string> {
    const resolved = await resolveWithinRoot(this.settings.root, requestedPath, { mustExist });
    return resolved.absolutePath;
  }
}
