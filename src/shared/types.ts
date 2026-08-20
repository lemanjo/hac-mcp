export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Risk = "READ" | "CONTROL" | "CONFIG" | "HIGH_IMPACT";
export type Mode = "read_only" | "control" | "admin";

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface OperationMeta {
  risk: Risk;
  source?: "rest" | "websocket" | "config_api" | "filesystem" | "derived";
  api_stability?: "public" | "internal" | "filesystem_fallback";
  pagination?: Pagination;
  warnings?: string[];
  dry_run?: boolean;
  changed?: boolean;
  reload_required?: boolean;
  restart_required?: boolean;
  causes_temporary_home_assistant_outage?: boolean;
}

export interface Success<T> {
  success: true;
  data: T;
  meta: OperationMeta;
}

export interface Failure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: JsonValue;
    retryable: boolean;
  };
  meta: OperationMeta;
}

export type Result<T> = Success<T> | Failure;

export interface PageInput {
  limit?: number;
  offset?: number;
}

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_reported?: string;
  last_updated: string;
  context: Record<string, unknown>;
}

export interface EntityRegistryEntry {
  entity_id: string;
  id?: string;
  unique_id?: string;
  platform?: string;
  config_entry_id?: string | null;
  device_id?: string | null;
  area_id?: string | null;
  name?: string | null;
  original_name?: string | null;
  icon?: string | null;
  disabled_by?: string | null;
  hidden_by?: string | null;
  labels?: string[];
  [key: string]: unknown;
}

export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  area_id?: string | null;
  config_entries?: string[];
  config_entry_id?: string;
  disabled_by?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  labels?: string[];
  [key: string]: unknown;
}

export interface AreaRegistryEntry {
  area_id: string;
  name: string;
  aliases?: string[];
  floor_id?: string | null;
  icon?: string | null;
  labels?: string[];
  [key: string]: unknown;
}

export interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  state?: string;
  source?: string;
  disabled_by?: string | null;
  supports_options?: boolean;
  supports_reconfigure?: boolean;
  [key: string]: unknown;
}

export interface ToolContext {
  confirm?: boolean;
}

export function paginate<T>(items: T[], input: PageInput): { items: T[]; pagination: Pagination } {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    items: items.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      total: items.length,
      has_more: offset + limit < items.length,
    },
  };
}

export function asJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
}
