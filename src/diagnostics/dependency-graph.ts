export type DiagnosticResourceKind =
  "automation" | "script" | "scene" | "helper" | "entity" | "config_file" | (string & {});

export interface ResourceConfig {
  kind?: DiagnosticResourceKind;
  resource_type?: DiagnosticResourceKind;
  id?: string;
  entity_id?: string;
  name?: string;
  alias?: string;
  title?: string;
  config?: unknown;
  configuration?: unknown;
  value?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface ConfigurationFileRecord {
  path: string;
  content?: string;
  parsed?: unknown;
  value?: unknown;
  error?: string;
  modified_at?: string;
  [key: string]: unknown;
}

export interface DependencyGraphInput {
  resources?: readonly ResourceConfig[];
  resourceConfigs?: readonly ResourceConfig[];
  automations?: readonly ResourceConfig[];
  scripts?: readonly ResourceConfig[];
  scenes?: readonly ResourceConfig[];
  helpers?: readonly ResourceConfig[];
  entityConfigs?: readonly ResourceConfig[];
  configFiles?: readonly ConfigurationFileRecord[];
  configurationFiles?: readonly ConfigurationFileRecord[];
}

export interface EntityReference {
  entity_id: string;
  path: string;
  value: string;
}

export interface EntityReferenceExtractionOptions {
  rootPath?: string;
  knownEntityIds?: Iterable<string>;
  includeUnknown?: boolean;
  ignoreServiceValues?: boolean;
}

export interface DependencyEvidence extends EntityReference {
  source_kind: DiagnosticResourceKind;
  source_id: string;
}

export interface EntityDependency {
  entity_id: string;
  evidence: DependencyEvidence[];
}

export interface DependencySourceReference {
  source_kind: DiagnosticResourceKind;
  source_id: string;
  source_entity_id?: string;
  name?: string;
  evidence: DependencyEvidence[];
}

export interface DependencyQueryOptions {
  transitive?: boolean;
  maxDepth?: number;
}

export interface DependencySource {
  kind: DiagnosticResourceKind;
  id: string;
  entity_id?: string;
  name?: string;
  resource: ResourceConfig | ConfigurationFileRecord;
  references: EntityReference[];
}

const SERVICE_VALUE_KEYS = new Set(["action", "service", "service_template"]);
const SERVICE_ACTIONS = new Set(["reload", "toggle", "turn_off", "turn_on"]);
const NON_ENTITY_DOMAINS = new Set(["states", "state", "trigger", "this", "config", "namespace"]);
const FILE_EXTENSIONS = new Set([
  "com",
  "css",
  "gif",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "js",
  "json",
  "local",
  "md",
  "net",
  "org",
  "png",
  "svg",
  "ts",
  "yaml",
  "yml",
]);
const ENTITY_ID_PATTERN = "[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isEntityId(value: string): boolean {
  if (!new RegExp(`^${ENTITY_ID_PATTERN}$`, "i").test(value)) return false;
  const [domain, objectId] = value.toLowerCase().split(".");
  return (
    domain !== undefined &&
    objectId !== undefined &&
    !NON_ENTITY_DOMAINS.has(domain) &&
    !FILE_EXTENSIONS.has(objectId)
  );
}

function referencesInString(value: string): string[] {
  const found = new Set<string>();

  // Dot notation needs a dedicated pass because the generic matcher deliberately
  // ignores dotted suffixes such as `kitchen.attributes`.
  const statesPattern = new RegExp(`\\bstates\\.(${ENTITY_ID_PATTERN})(?![a-z0-9_])`, "gi");
  for (const match of value.matchAll(statesPattern)) {
    const candidate = match[1]?.toLowerCase();
    if (candidate && isEntityId(candidate)) found.add(candidate);
  }

  const genericPattern = new RegExp(`(?<![a-z0-9_.])(${ENTITY_ID_PATTERN})(?![a-z0-9_])`, "gi");
  for (const match of value.matchAll(genericPattern)) {
    const candidate = match[1]?.toLowerCase();
    if (!candidate || !isEntityId(candidate)) continue;

    const index = match.index ?? 0;
    const prefix = value.slice(Math.max(0, index - 4), index);
    if (prefix.endsWith("://") || prefix.endsWith("@")) continue;
    found.add(candidate);
  }

  return [...found].sort(compareText);
}

function isServiceCall(value: string): boolean {
  const [domain, action] = value.trim().toLowerCase().split(".");
  if (!domain || !action) return false;
  return !((domain === "script" || domain === "scene") && !SERVICE_ACTIONS.has(action));
}

/** Recursively extracts Home Assistant entity IDs and the JSON-style path of each use. */
export function extractEntityReferences(
  value: unknown,
  options: EntityReferenceExtractionOptions = {},
): EntityReference[] {
  const rootPath = options.rootPath ?? "$";
  const known = options.knownEntityIds
    ? new Set([...options.knownEntityIds].map((entityId) => entityId.toLowerCase()))
    : undefined;
  const includeUnknown = options.includeUnknown ?? true;
  const ignoreServiceValues = options.ignoreServiceValues ?? true;
  const references: EntityReference[] = [];
  const ancestors = new Set<object>();

  const visit = (child: unknown, path: string, parentKey?: string): void => {
    if (typeof child === "string") {
      const candidates =
        ignoreServiceValues &&
        parentKey !== undefined &&
        SERVICE_VALUE_KEYS.has(parentKey) &&
        isEntityId(child.trim()) &&
        isServiceCall(child)
          ? []
          : referencesInString(child);
      for (const entityId of candidates) {
        if (!includeUnknown && known && !known.has(entityId)) continue;
        references.push({ entity_id: entityId, path, value: child });
      }
      return;
    }

    if (child === null || typeof child !== "object" || ancestors.has(child)) return;
    ancestors.add(child);
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${path}[${index}]`, parentKey));
    } else {
      for (const key of Object.keys(child).sort(compareText)) {
        visit((child as Record<string, unknown>)[key], appendPath(path, key), key);
      }
    }
    ancestors.delete(child);
  };

  visit(value, rootPath);
  return references.sort(
    (left, right) =>
      compareText(left.entity_id, right.entity_id) ||
      compareText(left.path, right.path) ||
      compareText(left.value, right.value),
  );
}

export function extractEntityIds(
  value: unknown,
  options: EntityReferenceExtractionOptions = {},
): string[] {
  return [...new Set(extractEntityReferences(value, options).map(({ entity_id }) => entity_id))];
}

function resourcePayload(resource: ResourceConfig): unknown {
  if (Object.hasOwn(resource, "config")) return resource.config;
  if (Object.hasOwn(resource, "configuration")) return resource.configuration;
  if (Object.hasOwn(resource, "value")) return resource.value;

  const metadata = new Set([
    "alias",
    "enabled",
    "entity_id",
    "id",
    "kind",
    "name",
    "resource_type",
    "title",
  ]);
  return Object.fromEntries(Object.entries(resource).filter(([key]) => !metadata.has(key)));
}

function resourceName(resource: ResourceConfig): string | undefined {
  const value = resource.name ?? resource.alias ?? resource.title;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceEntityId(
  resource: ResourceConfig,
  kind: DiagnosticResourceKind,
): string | undefined {
  if (typeof resource.entity_id !== "string" || !isEntityId(resource.entity_id)) return undefined;
  const entityId = resource.entity_id.toLowerCase();
  if (kind === "automation" && !entityId.startsWith("automation.")) return undefined;
  if (kind === "script" && !entityId.startsWith("script.")) return undefined;
  if (kind === "scene" && !entityId.startsWith("scene.")) return undefined;
  return entityId;
}

function addResources(
  output: DependencySource[],
  resources: readonly ResourceConfig[] | undefined,
  defaultKind: DiagnosticResourceKind,
): void {
  resources?.forEach((resource, index) => {
    const kind = resource.kind ?? resource.resource_type ?? defaultKind;
    const entityId = resourceEntityId(resource, kind);
    const id =
      (typeof resource.id === "string" && resource.id.length > 0 ? resource.id : undefined) ??
      entityId ??
      `${kind}:${index}`;
    const references = extractEntityReferences(resourcePayload(resource)).filter(
      (reference) => reference.entity_id !== entityId,
    );
    const name = resourceName(resource);
    output.push({
      kind,
      id,
      ...(entityId === undefined ? {} : { entity_id: entityId }),
      ...(name === undefined ? {} : { name }),
      resource,
      references,
    });
  });
}

/** Normalizes grouped or flat resources into stable dependency sources. */
export function collectDependencySources(input: DependencyGraphInput): DependencySource[] {
  const sources: DependencySource[] = [];
  addResources(sources, input.automations, "automation");
  addResources(sources, input.scripts, "script");
  addResources(sources, input.scenes, "scene");
  addResources(sources, input.helpers, "helper");
  addResources(sources, input.entityConfigs, "entity");
  addResources(sources, input.resources ?? input.resourceConfigs, "resource");

  (input.configFiles ?? input.configurationFiles)?.forEach((file) => {
    const payload = file.parsed ?? file.value ?? file.content ?? "";
    sources.push({
      kind: "config_file",
      id: file.path,
      name: file.path,
      resource: file,
      references: extractEntityReferences(payload),
    });
  });

  return sources.sort(
    (left, right) =>
      compareText(String(left.kind), String(right.kind)) || compareText(left.id, right.id),
  );
}

function aggregateDependencies(evidence: DependencyEvidence[]): EntityDependency[] {
  const grouped = new Map<string, DependencyEvidence[]>();
  for (const item of evidence) {
    const group = grouped.get(item.entity_id) ?? [];
    group.push(item);
    grouped.set(item.entity_id, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([entityId, items]) => ({
      entity_id: entityId,
      evidence: items.sort(
        (left, right) =>
          compareText(String(left.source_kind), String(right.source_kind)) ||
          compareText(left.source_id, right.source_id) ||
          compareText(left.path, right.path) ||
          compareText(left.value, right.value),
      ),
    }));
}

export class DependencyGraph {
  readonly sources: readonly DependencySource[];

  constructor(input: DependencyGraphInput | readonly ResourceConfig[]) {
    this.sources = collectDependencySources(
      isResourceConfigList(input) ? { resources: input } : input,
    );
  }

  getEntityDependencies(
    entityId: string,
    options: DependencyQueryOptions = {},
  ): EntityDependency[] {
    const normalized = entityId.toLowerCase();
    const roots = this.sources.filter(
      (source) => source.entity_id === normalized || source.id.toLowerCase() === normalized,
    );
    return this.dependenciesFrom(roots, normalized, options);
  }

  getAutomationDependencies(
    automationId: string,
    options: DependencyQueryOptions = {},
  ): EntityDependency[] {
    const normalized = automationId.toLowerCase();
    const qualified = normalized.startsWith("automation.")
      ? normalized
      : `automation.${normalized}`;
    const roots = this.sources.filter(
      (source) =>
        source.kind === "automation" &&
        (source.id.toLowerCase() === normalized || source.entity_id === qualified),
    );
    return this.dependenciesFrom(roots, qualified, options);
  }

  getEntityDependents(entityId: string): DependencySourceReference[] {
    const normalized = entityId.toLowerCase();
    return this.sources
      .map((source): DependencySourceReference | undefined => {
        const evidence = source.references
          .filter((reference) => reference.entity_id === normalized)
          .map((reference) => ({
            ...reference,
            source_kind: source.kind,
            source_id: source.id,
          }));
        if (evidence.length === 0) return undefined;
        return {
          source_kind: source.kind,
          source_id: source.id,
          ...(source.entity_id === undefined ? {} : { source_entity_id: source.entity_id }),
          ...(source.name === undefined ? {} : { name: source.name }),
          evidence,
        };
      })
      .filter((source): source is DependencySourceReference => source !== undefined)
      .sort(
        (left, right) =>
          compareText(String(left.source_kind), String(right.source_kind)) ||
          compareText(left.source_id, right.source_id),
      );
  }

  private dependenciesFrom(
    roots: readonly DependencySource[],
    rootEntityId: string,
    options: DependencyQueryOptions,
  ): EntityDependency[] {
    const evidence: DependencyEvidence[] = [];
    const visitedSources = new Set<DependencySource>();
    const maxDepth = Math.max(0, options.maxDepth ?? 20);

    const visit = (source: DependencySource, depth: number): void => {
      if (visitedSources.has(source)) return;
      visitedSources.add(source);

      for (const reference of source.references) {
        if (reference.entity_id === rootEntityId) continue;
        evidence.push({
          ...reference,
          source_kind: source.kind,
          source_id: source.id,
        });
        if (options.transitive === true && depth < maxDepth) {
          for (const dependencySource of this.sources) {
            if (dependencySource.entity_id === reference.entity_id)
              visit(dependencySource, depth + 1);
          }
        }
      }
    };

    roots.forEach((source) => visit(source, 0));
    return aggregateDependencies(evidence);
  }
}

function isResourceConfigList(
  input: DependencyGraphInput | readonly ResourceConfig[],
): input is readonly ResourceConfig[] {
  return Array.isArray(input);
}

export function buildDependencyGraph(
  input: DependencyGraphInput | readonly ResourceConfig[],
): DependencyGraph {
  return new DependencyGraph(input);
}

export function getEntityDependencies(
  entityId: string,
  input: DependencyGraphInput | readonly ResourceConfig[],
  options: DependencyQueryOptions = {},
): EntityDependency[] {
  return new DependencyGraph(input).getEntityDependencies(entityId, options);
}

export function getAutomationDependencies(
  automationId: string,
  input: DependencyGraphInput | readonly ResourceConfig[],
  options: DependencyQueryOptions = {},
): EntityDependency[] {
  return new DependencyGraph(input).getAutomationDependencies(automationId, options);
}
