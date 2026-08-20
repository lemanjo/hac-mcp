import type {
  AreaRegistryEntry,
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
  PageInput,
  Pagination,
} from "../shared/types.js";
import { paginate } from "../shared/types.js";
import type { ConfigurationFileRecord, ResourceConfig } from "./dependency-graph.js";

export type SearchKind =
  | "entity"
  | "device"
  | "area"
  | "automation"
  | "script"
  | "scene"
  | "helper"
  | "integration"
  | "config_file";

export interface UnifiedSearchInput {
  states?: readonly EntityState[];
  entityRegistry?: readonly EntityRegistryEntry[];
  entities?: readonly EntityRegistryEntry[];
  deviceRegistry?: readonly DeviceRegistryEntry[];
  devices?: readonly DeviceRegistryEntry[];
  areaRegistry?: readonly AreaRegistryEntry[];
  areas?: readonly AreaRegistryEntry[];
  resources?: readonly ResourceConfig[];
  resourceConfigs?: readonly ResourceConfig[];
  automations?: readonly ResourceConfig[];
  scripts?: readonly ResourceConfig[];
  scenes?: readonly ResourceConfig[];
  helpers?: readonly ResourceConfig[];
  integrations?: readonly ConfigEntry[];
  configEntries?: readonly ConfigEntry[];
  configFiles?: readonly ConfigurationFileRecord[];
  configurationFiles?: readonly ConfigurationFileRecord[];
}

export interface UnifiedSearchOptions extends PageInput {
  query: string;
  kinds?: readonly SearchKind[];
  minimumScore?: number;
}

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  score: number;
  matched_fields: string[];
  excerpt?: string;
  record: unknown;
}

export interface SearchPage {
  items: SearchResult[];
  pagination: Pagination;
}

export interface SearchField {
  name: string;
  value: string;
  weight: number;
}

export interface SearchDocument {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  fields: SearchField[];
  excerpt?: string;
  record: unknown;
}

const KIND_ORDER: Record<SearchKind, number> = {
  entity: 0,
  device: 1,
  area: 2,
  automation: 3,
  script: 4,
  scene: 5,
  helper: 6,
  integration: 7,
  config_file: 8,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function words(value: string): string[] {
  const normalized = normalize(value);
  return normalized ? normalized.split(" ") : [];
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function tokenSimilarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (candidate.startsWith(query)) return 0.94;
  if (query.length >= 3 && candidate.includes(query)) return 0.86;
  if (candidate.length >= 3 && query.startsWith(candidate)) return 0.82;
  if (Math.min(query.length, candidate.length) < 3) return 0;
  const distance = levenshtein(query, candidate);
  return Math.max(0, 1 - distance / Math.max(query.length, candidate.length));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function join(values: readonly unknown[]): string | undefined {
  const result = values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return result.length > 0 ? result.join(" ") : undefined;
}

function field(name: string, value: unknown, weight: number): SearchField | undefined {
  const stringValue = text(value);
  return stringValue === undefined ? undefined : { name, value: stringValue, weight };
}

function fields(values: Array<SearchField | undefined>): SearchField[] {
  return values.filter((value): value is SearchField => value !== undefined);
}

function stableValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (ancestors.has(value)) return '"[Circular]"';
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableValue(item, ancestors)).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>)
        .sort(compareText)
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key], ancestors)}`,
        )
        .join(",")}}`;
  ancestors.delete(value);
  return result;
}

function hash(value: unknown): string {
  let result = 2_166_136_261;
  for (const character of stableValue(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function resourceId(resource: ResourceConfig, kind: SearchKind): string {
  return text(resource.id) ?? text(resource.entity_id) ?? `${kind}:${hash(resource)}`;
}

function resourceTitle(resource: ResourceConfig, id: string): string {
  return text(resource.name) ?? text(resource.alias) ?? text(resource.title) ?? id;
}

function searchableResource(resource: ResourceConfig): string {
  return stableValue(resource.config ?? resource.configuration ?? resource.value ?? resource);
}

function buildEntityDocuments(input: UnifiedSearchInput): SearchDocument[] {
  const states = [...(input.states ?? [])].sort(
    (left, right) =>
      compareText(left.entity_id.toLowerCase(), right.entity_id.toLowerCase()) ||
      compareText(right.last_updated, left.last_updated),
  );
  const registry = [...(input.entityRegistry ?? input.entities ?? [])].sort((left, right) =>
    compareText(left.entity_id.toLowerCase(), right.entity_id.toLowerCase()),
  );
  const stateById = new Map<string, EntityState>();
  const registryById = new Map<string, EntityRegistryEntry>();
  for (const state of states) {
    const id = state.entity_id.toLowerCase();
    if (!stateById.has(id)) stateById.set(id, state);
  }
  for (const entity of registry) {
    const id = entity.entity_id.toLowerCase();
    if (!registryById.has(id)) registryById.set(id, entity);
  }

  const deviceById = new Map(
    (input.deviceRegistry ?? input.devices ?? []).map((device) => [device.id, device]),
  );
  const areaById = new Map(
    (input.areaRegistry ?? input.areas ?? []).map((area) => [area.area_id, area]),
  );
  const ids = [...new Set([...stateById.keys(), ...registryById.keys()])].sort(compareText);
  return ids.map((id) => {
    const state = stateById.get(id);
    const entity = registryById.get(id);
    const device = entity?.device_id ? deviceById.get(entity.device_id) : undefined;
    const areaId = entity?.area_id ?? device?.area_id;
    const area = areaId ? areaById.get(areaId) : undefined;
    const friendlyName = text(state?.attributes.friendly_name);
    const title = friendlyName ?? entity?.name ?? entity?.original_name ?? id;
    const stateDetails = join([
      state?.state,
      state?.attributes.device_class,
      state?.attributes.unit_of_measurement,
      state?.attributes.icon,
    ]);
    const metadata = join([
      entity?.platform,
      entity?.unique_id,
      entity?.config_entry_id,
      entity?.device_id,
      entity?.area_id,
      ...(entity?.labels ?? []),
    ]);
    const location = join([
      device?.name_by_user,
      device?.name,
      device?.manufacturer,
      device?.model,
      area?.name,
      ...(area?.aliases ?? []),
    ]);
    return {
      kind: "entity",
      id,
      title,
      ...(state === undefined ? {} : { subtitle: state.state }),
      fields: fields([
        field("id", id, 6),
        field("name", join([friendlyName, entity?.name, entity?.original_name]), 5),
        field("state", stateDetails, 2),
        field("metadata", metadata, 2),
        field("location", location, 3),
      ]),
      record: { state, registry: entity },
    };
  });
}

function buildDeviceDocuments(input: UnifiedSearchInput): SearchDocument[] {
  const areaById = new Map(
    (input.areaRegistry ?? input.areas ?? []).map((area) => [area.area_id, area]),
  );
  return [...(input.deviceRegistry ?? input.devices ?? [])]
    .sort((left, right) => compareText(left.id, right.id))
    .map((device) => {
      const title = device.name_by_user ?? device.name ?? device.id;
      const area = device.area_id ? areaById.get(device.area_id) : undefined;
      return {
        kind: "device",
        id: device.id,
        title,
        fields: fields([
          field("id", device.id, 6),
          field("name", join([device.name_by_user, device.name]), 5),
          field("model", join([device.manufacturer, device.model]), 3),
          field("area", join([area?.name, ...(area?.aliases ?? [])]), 3),
          field(
            "metadata",
            join([
              device.area_id,
              device.config_entry_id,
              ...(device.config_entries ?? []),
              ...(device.labels ?? []),
            ]),
            2,
          ),
        ]),
        record: device,
      };
    });
}

function buildAreaDocuments(areas: readonly AreaRegistryEntry[]): SearchDocument[] {
  return [...areas]
    .sort((left, right) => compareText(left.area_id, right.area_id))
    .map((area) => ({
      kind: "area",
      id: area.area_id,
      title: area.name,
      fields: fields([
        field("id", area.area_id, 6),
        field("name", area.name, 5),
        field("aliases", join(area.aliases ?? []), 4),
        field("metadata", join([area.floor_id, area.icon, ...(area.labels ?? [])]), 2),
      ]),
      record: area,
    }));
}

function buildResourceDocuments(
  resources: readonly ResourceConfig[],
  kind: "automation" | "script" | "scene" | "helper",
): SearchDocument[] {
  return resources
    .map((resource) => {
      const id = resourceId(resource, kind);
      const title = resourceTitle(resource, id);
      return {
        kind,
        id,
        title,
        fields: fields([
          field("id", id, 6),
          field("name", join([resource.name, resource.alias, resource.title]), 5),
          field("configuration", searchableResource(resource), 1),
        ]),
        record: resource,
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
}

function resourcesFor(
  input: UnifiedSearchInput,
  kind: "automation" | "script" | "scene" | "helper",
): readonly ResourceConfig[] {
  const grouped =
    kind === "automation"
      ? input.automations
      : kind === "script"
        ? input.scripts
        : kind === "scene"
          ? input.scenes
          : input.helpers;
  const flat = (input.resources ?? input.resourceConfigs ?? []).filter(
    (resource) => (resource.kind ?? resource.resource_type) === kind,
  );
  return [...new Set([...(grouped ?? []), ...flat])];
}

function buildIntegrationDocuments(integrations: readonly ConfigEntry[]): SearchDocument[] {
  return [...integrations]
    .sort((left, right) => compareText(left.entry_id, right.entry_id))
    .map((integration) => ({
      kind: "integration",
      id: integration.entry_id,
      title: integration.title,
      ...(integration.state === undefined ? {} : { subtitle: integration.state }),
      fields: fields([
        field("id", integration.entry_id, 6),
        field("name", integration.title, 5),
        field("domain", integration.domain, 4),
        field(
          "metadata",
          join([integration.state, integration.source, integration.disabled_by]),
          2,
        ),
      ]),
      record: integration,
    }));
}

function fileExcerpt(file: ConfigurationFileRecord): string | undefined {
  if (!file.content) return undefined;
  const compact = file.content.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function buildFileDocuments(files: readonly ConfigurationFileRecord[]): SearchDocument[] {
  return [...files]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => {
      const configuration = file.parsed ?? file.value;
      const excerpt = fileExcerpt(file);
      return {
        kind: "config_file",
        id: file.path,
        title: file.path.split("/").filter(Boolean).at(-1) ?? file.path,
        subtitle: file.path,
        fields: fields([
          field("path", file.path, 6),
          field("content", file.content, 1),
          field(
            "configuration",
            configuration === undefined ? undefined : stableValue(configuration),
            1,
          ),
          field("error", file.error, 3),
        ]),
        ...(excerpt === undefined ? {} : { excerpt }),
        record: file,
      };
    });
}

export function buildSearchDocuments(input: UnifiedSearchInput): SearchDocument[] {
  return [
    ...buildEntityDocuments(input),
    ...buildDeviceDocuments(input),
    ...buildAreaDocuments(input.areaRegistry ?? input.areas ?? []),
    ...buildResourceDocuments(resourcesFor(input, "automation"), "automation"),
    ...buildResourceDocuments(resourcesFor(input, "script"), "script"),
    ...buildResourceDocuments(resourcesFor(input, "scene"), "scene"),
    ...buildResourceDocuments(resourcesFor(input, "helper"), "helper"),
    ...buildIntegrationDocuments(input.integrations ?? input.configEntries ?? []),
    ...buildFileDocuments(input.configFiles ?? input.configurationFiles ?? []),
  ].sort(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || compareText(left.id, right.id),
  );
}

function scoreDocument(
  document: SearchDocument,
  query: string,
  minimumScore: number,
): SearchResult | undefined {
  const normalizedQuery = normalize(query);
  const queryTokens = words(query);
  if (!normalizedQuery) {
    return {
      kind: document.kind,
      id: document.id,
      title: document.title,
      ...(document.subtitle === undefined ? {} : { subtitle: document.subtitle }),
      score: 0,
      matched_fields: [],
      ...(document.excerpt === undefined ? {} : { excerpt: document.excerpt }),
      record: document.record,
    };
  }

  const matchedFields = new Set<string>();
  let score = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    let bestSimilarity = 0;
    let bestField: string | undefined;
    for (const candidateField of document.fields) {
      const similarity = Math.max(
        0,
        ...words(candidateField.value).map((candidate) => tokenSimilarity(queryToken, candidate)),
      );
      const weighted = similarity * candidateField.weight;
      bestSimilarity = Math.max(bestSimilarity, similarity);
      if (
        weighted > best ||
        (weighted === best &&
          bestField !== undefined &&
          compareText(candidateField.name, bestField) < 0)
      ) {
        best = weighted;
        bestField = candidateField.name;
      }
    }
    if (bestSimilarity < minimumScore) return undefined;
    score += best;
    if (bestField) matchedFields.add(bestField);
  }

  for (const candidateField of document.fields) {
    const normalizedField = normalize(candidateField.value);
    if (normalizedField === normalizedQuery) {
      score += candidateField.weight * 1.5;
      matchedFields.add(candidateField.name);
    } else if (normalizedField.includes(normalizedQuery)) {
      score += candidateField.weight * 0.75;
      matchedFields.add(candidateField.name);
    }
  }

  return {
    kind: document.kind,
    id: document.id,
    title: document.title,
    ...(document.subtitle === undefined ? {} : { subtitle: document.subtitle }),
    score: Math.round(score * 1_000_000) / 1_000_000,
    matched_fields: [...matchedFields].sort(compareText),
    ...(document.excerpt === undefined ? {} : { excerpt: document.excerpt }),
    record: document.record,
  };
}

/** Token and typo-tolerant search over a caller-supplied Home Assistant snapshot. */
export function unifiedSearch(
  input: UnifiedSearchInput,
  options: UnifiedSearchOptions,
): SearchPage {
  const selectedKinds = options.kinds ? new Set(options.kinds) : undefined;
  const minimumScore = Math.min(1, Math.max(0, options.minimumScore ?? 0.55));
  const results = buildSearchDocuments(input)
    .filter((document) => !selectedKinds || selectedKinds.has(document.kind))
    .flatMap((document): SearchResult[] => {
      const result = scoreDocument(document, options.query, minimumScore);
      return result ? [result] : [];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
        compareText(normalize(left.title), normalize(right.title)) ||
        compareText(left.id, right.id),
    );
  return paginate(results, options);
}

export function search(
  input: UnifiedSearchInput,
  query: string,
  options: Omit<UnifiedSearchOptions, "query"> = {},
): SearchPage {
  return unifiedSearch(input, { ...options, query });
}
