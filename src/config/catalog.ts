import { readdir } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import type { ConfigurationFileRecord } from "../diagnostics/dependency-graph.js";
import { redactSecrets } from "../security/secrets.js";
import { AppError } from "../shared/errors.js";
import type { ConfigFilesystem } from "./filesystem.js";
import type { Settings } from "./settings.js";

const YAML_EXTENSION = /\.ya?ml$/i;

export interface ConfigurationCatalog {
  files: ConfigurationFileRecord[];
  scanned: number;
  truncated: boolean;
}

export function parseHomeAssistantYaml(source: string, allowSecretValues: boolean): unknown {
  const markerTags = [
    "!include",
    "!include_dir_list",
    "!include_dir_named",
    "!include_dir_merge_list",
    "!include_dir_merge_named",
    "!input",
  ];
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    customTags: [
      {
        tag: "!secret",
        resolve: (value: string) => (allowSecretValues ? value : "[REDACTED]"),
      },
      {
        tag: "!env_var",
        resolve: (value: string) =>
          allowSecretValues
            ? { yaml_tag: "!env_var", value }
            : { yaml_tag: "!env_var", value: "[REDACTED]" },
      },
      ...markerTags.map((tag) => ({
        tag,
        resolve: (value: string) => ({ yaml_tag: tag, value }),
      })),
    ],
  });
  if (document.errors.length > 0) {
    throw new AppError("INVALID_YAML", "The YAML source is invalid", {
      details: { errors: document.errors.map((error) => error.message) },
    });
  }
  try {
    return redactSecrets(document.toJS({ maxAliasCount: 100 }), allowSecretValues);
  } catch (error) {
    throw new AppError("INVALID_YAML", "The YAML source contains an invalid alias", {
      cause: error,
    });
  }
}

export async function loadConfigurationCatalog(
  filesystem: ConfigFilesystem,
  settings: Settings,
  options: { maxFiles?: number; maxEntries?: number; maxDepth?: number } = {},
): Promise<ConfigurationCatalog> {
  if (!settings.filesystem.enabled) return { files: [], scanned: 0, truncated: false };
  const maxFiles = options.maxFiles ?? 200;
  const maxEntries = options.maxEntries ?? 5_000;
  const maxDepth = options.maxDepth ?? 32;
  const root = await filesystem.policy.root();
  const rootEntries = await readdir(root, { withFileTypes: true });
  const candidates = new Set<string>();
  let scanned = rootEntries.length;
  let truncated = false;

  for (const entry of rootEntries) {
    if (
      entry.isFile() &&
      YAML_EXTENSION.test(entry.name) &&
      !/^secrets\.ya?ml$/i.test(entry.name)
    ) {
      candidates.add(entry.name);
    }
  }
  if (candidates.size > maxFiles || scanned >= maxEntries) truncated = true;

  const queue: Array<{ absolute: string; relative: string; depth: number }> = [];
  for (const directory of settings.filesystem.allowedDirectories) {
    try {
      queue.push({
        absolute: await filesystem.policy.resolveInternal(directory, true),
        relative: directory.replace(/\/$/, ""),
        depth: 0,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFIG_FILE_NOT_FOUND") throw error;
    }
  }

  while (queue.length > 0 && candidates.size < maxFiles && scanned < maxEntries) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) {
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
      } else if (entry.isFile() && YAML_EXTENSION.test(entry.name)) {
        candidates.add(relative);
      }
      if (candidates.size >= maxFiles || scanned >= maxEntries) {
        truncated = true;
        break;
      }
    }
  }
  if (queue.length > 0) truncated = true;

  const files: ConfigurationFileRecord[] = [];
  for (const candidate of [...candidates].sort().slice(0, maxFiles)) {
    try {
      const file = await filesystem.readFile(candidate);
      files.push({
        path: file.path,
        parsed: parseHomeAssistantYaml(file.content, settings.filesystem.allowSecretValues),
        modified_at: file.modifiedAt,
        sha256: file.sha256,
      });
    } catch (error) {
      files.push({
        path: candidate,
        error:
          error instanceof AppError ? `${error.code}: ${error.message}` : "Unable to read file",
      });
    }
  }
  return { files, scanned, truncated };
}
