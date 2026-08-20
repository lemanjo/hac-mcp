import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  type Document,
  type Node,
  type ParsedNode,
} from "yaml";

import { AppError } from "../shared/errors.js";
import type { JsonValue } from "../shared/types.js";

export type YamlPathSegment = string | number;
export type YamlPath = readonly YamlPathSegment[];

export type YamlPatchOperation =
  { op: "set"; path: YamlPath; value: JsonValue } | { op: "delete"; path: YamlPath };

export interface YamlPatchResult {
  content: string;
  changed: boolean;
  operations: Array<{ op: "set" | "delete"; path: YamlPath; changed: boolean }>;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function validatePath(path: YamlPath): void {
  if (!Array.isArray(path)) {
    throw new AppError("INVALID_YAML_PATH", "A YAML path must be an array");
  }
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Number.isSafeInteger(segment) || segment < 0) {
        throw new AppError(
          "INVALID_YAML_PATH",
          "YAML sequence indexes must be non-negative integers",
        );
      }
    } else if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      hasControlCharacter(segment)
    ) {
      throw new AppError(
        "INVALID_YAML_PATH",
        "YAML mapping keys must be non-empty strings without control characters",
      );
    }
  }
}

function validatePatchValue(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 100)
    throw new AppError("INVALID_YAML_VALUE", "The YAML patch value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError("INVALID_YAML_VALUE", "YAML patch numbers must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new AppError("INVALID_YAML_VALUE", "YAML patch values must be JSON-compatible");
  }
  if (seen.has(value)) {
    throw new AppError("INVALID_YAML_VALUE", "YAML patch values cannot contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validatePatchValue(child, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AppError("INVALID_YAML_VALUE", "YAML patch values must be plain JSON objects");
    }
    for (const child of Object.values(value)) validatePatchValue(child, depth + 1, seen);
  }
  seen.delete(value);
}

function parseYamlDocument(source: string): Document.Parsed<ParsedNode> {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AppError("INVALID_YAML", "The YAML source is invalid", {
      details: { errors: document.errors.map((error) => error.message) },
    });
  }
  try {
    document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new AppError("INVALID_YAML", "The YAML source contains an invalid alias", {
      details: { error: error instanceof Error ? error.message : "Alias resolution failed" },
      cause: error,
    });
  }
  return document;
}

function replacementNode(
  document: Document.Parsed<ParsedNode>,
  value: JsonValue,
  previous: unknown,
): Node {
  const replacement = document.createNode(value);
  if (isNode(previous)) {
    if (previous.comment !== undefined) replacement.comment = previous.comment;
    if (previous.commentBefore !== undefined) replacement.commentBefore = previous.commentBefore;
    if (previous.spaceBefore !== undefined) replacement.spaceBefore = previous.spaceBefore;
  }
  return replacement;
}

export function validateYaml(source: string): void {
  parseYamlDocument(source);
}

export function yamlTopLevelKeys(source: string): string[] {
  const document = parseYamlDocument(source);
  if (document.contents === null) return [];
  if (!isMap(document.contents)) {
    throw new AppError("INVALID_YAML_STRUCTURE", "Expected a top-level YAML mapping");
  }
  const keys: string[] = [];
  for (const pair of document.contents.items) {
    if (
      isScalar(pair.key) &&
      (typeof pair.key.value === "string" || typeof pair.key.value === "number")
    ) {
      keys.push(String(pair.key.value));
    }
  }
  return [...new Set(keys)].sort();
}

export class YamlEditor {
  private readonly original: string;
  private readonly document: Document.Parsed<ParsedNode>;
  private readonly operationResults: YamlPatchResult["operations"] = [];

  constructor(source: string) {
    this.original = source;
    this.document = parseYamlDocument(source);
  }

  set(path: YamlPath, value: JsonValue): this {
    validatePath(path);
    validatePatchValue(value);
    try {
      const before = this.document.toString({ lineWidth: 0 });
      if (path.length === 0) {
        this.document.contents = replacementNode(
          this.document,
          value,
          this.document.contents,
        ) as ParsedNode;
      } else {
        const previous = this.document.getIn(path, true);
        this.document.setIn(path, replacementNode(this.document, value, previous));
      }
      const changed = this.document.toString({ lineWidth: 0 }) !== before;
      this.operationResults.push({ op: "set", path: [...path], changed });
      return this;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("YAML_PATCH_FAILED", "Unable to set the requested YAML path", {
        cause: error,
      });
    }
  }

  delete(path: YamlPath): this {
    validatePath(path);
    try {
      let changed: boolean;
      if (path.length === 0) {
        changed = this.document.contents !== null;
        this.document.contents = null;
      } else {
        changed = this.document.deleteIn(path);
      }
      this.operationResults.push({ op: "delete", path: [...path], changed });
      return this;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("YAML_PATCH_FAILED", "Unable to delete the requested YAML path", {
        cause: error,
      });
    }
  }

  apply(operations: readonly YamlPatchOperation[]): this {
    for (const operation of operations) {
      if (operation.op === "set") this.set(operation.path, operation.value);
      else if (operation.op === "delete") this.delete(operation.path);
      else
        throw new AppError("INVALID_YAML_OPERATION", "YAML patch operations must be set or delete");
    }
    return this;
  }

  result(): YamlPatchResult {
    const content = this.document.toString({ lineWidth: 0 });
    validateYaml(content);
    return {
      content,
      changed: content !== this.original,
      operations: this.operationResults.map((operation) => ({
        ...operation,
        path: [...operation.path],
      })),
    };
  }
}

export function applyYamlPatches(
  source: string,
  operations: readonly YamlPatchOperation[],
): YamlPatchResult {
  return new YamlEditor(source).apply(operations).result();
}
