import type { HomeAssistantClient, ServiceCallExtendedResponse } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";

export const MAX_HISTORY_ENTITY_IDS = 100;
export const MAX_LOGBOOK_FILTER_IDS = 100;
export const MAX_STATISTIC_IDS = 100;
export const MAX_LOGBOOK_ENTRIES = 5_000;

export type TimeInput = string | number | Date;

export interface HistoryQuery {
  entityIds: readonly string[];
  startTime?: TimeInput;
  endTime?: TimeInput;
  minimalResponse?: boolean;
  noAttributes?: boolean;
  significantChangesOnly?: boolean;
}

/** REST minimal responses intentionally omit fields on intermediate rows. */
export interface HistoryState {
  entity_id?: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
  context?: Record<string, unknown>;
}

export interface LogbookQuery {
  startTime: TimeInput;
  endTime?: TimeInput;
  entityIds?: readonly string[];
  deviceIds?: readonly string[];
  contextId?: string;
  source?: "websocket" | "rest";
  limit?: number;
}

export interface LogbookEntry {
  when: number | string;
  name: string;
  message?: string;
  entity_id?: string;
  icon?: string;
  source?: string;
  domain?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  context_id?: string;
  context_user_id?: string | null;
  context_event_type?: string;
  context_domain?: string;
  context_service?: string;
  context_entity_id?: string;
  context_name?: string;
  context_state?: string;
  context_source?: string;
  context_message?: string;
  [key: string]: unknown;
}

export type StatisticPeriod = "5minute" | "hour" | "day" | "week" | "month" | "year";
export type StatisticType = "change" | "last_reset" | "max" | "mean" | "min" | "state" | "sum";

export interface StatisticsQuery {
  statisticIds: readonly string[];
  startTime: TimeInput;
  endTime?: TimeInput;
  period: StatisticPeriod;
  types: readonly StatisticType[];
  units?: Readonly<Record<string, string>>;
}

export interface StatisticValue {
  start: string;
  end: string;
  change?: number | null;
  last_reset?: string | null;
  max?: number | null;
  mean?: number | null;
  min?: number | null;
  state?: number | null;
  sum?: number | null;
}

export interface RecorderStatisticsResponse {
  statistics: Record<string, StatisticValue[]>;
}

export interface RecorderInfo {
  backlog: number | null;
  db_in_default_location: boolean;
  max_backlog: number;
  migration_in_progress: boolean;
  migration_is_live: boolean;
  recording: boolean;
  thread_running: boolean;
  [key: string]: unknown;
}

export interface StatisticsMetadata {
  statistic_id: string;
  source: string;
  name?: string | null;
  statistics_unit_of_measurement: string | null;
  unit_class: string | null;
  has_sum: boolean;
  mean_type: number;
  [key: string]: unknown;
}

export interface StatisticsMetadataQuery {
  statisticIds?: readonly string[];
}

const STATISTIC_PERIODS = new Set<StatisticPeriod>([
  "5minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);
const STATISTIC_TYPES = new Set<StatisticType>([
  "change",
  "last_reset",
  "max",
  "mean",
  "min",
  "state",
  "sum",
]);

function time(value: TimeInput, label: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError("HA_INVALID_TIME", `Invalid Home Assistant ${label}`, {
      details: { value: String(value) },
    });
  }
  return date.toISOString();
}

function validateRange(start: string | undefined, end: string | undefined): void {
  if (start !== undefined && end !== undefined && Date.parse(end) < Date.parse(start)) {
    throw new AppError("HA_INVALID_TIME_RANGE", "End time must not be before start time", {
      details: { start_time: start, end_time: end },
    });
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function entityIds(values: readonly string[], maximum: number, label: string): string[] {
  if (values.length === 0 || values.length > maximum) {
    throw new AppError(
      "HA_ENTITY_IDS_REQUIRED",
      `${label} requires between 1 and ${maximum} entity IDs`,
      { details: { entity_count: values.length, maximum_entities: maximum } },
    );
  }
  const normalized = values.map((value) => {
    const id = value.trim().toLowerCase();
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) {
      throw new AppError("HA_INVALID_ENTITY_ID", `Invalid Home Assistant entity ID: ${value}`);
    }
    return id;
  });
  return [...new Set(normalized)];
}

function opaqueIds(values: readonly string[], maximum: number, label: string): string[] {
  if (values.length === 0 || values.length > maximum) {
    throw new AppError("HA_INVALID_REQUEST", `${label} must contain between 1 and ${maximum} IDs`, {
      details: { id_count: values.length, maximum_ids: maximum },
    });
  }
  const normalized = values.map((value) => {
    const id = value.trim();
    if (id.length === 0 || id.length > 255 || hasControlCharacter(id)) {
      throw new AppError("HA_INVALID_REQUEST", `Invalid ${label} ID`);
    }
    return id;
  });
  return [...new Set(normalized)];
}

function statisticIds(values: readonly string[]): string[] {
  if (values.length === 0 || values.length > MAX_STATISTIC_IDS) {
    throw new AppError(
      "HA_STATISTIC_IDS_REQUIRED",
      `Statistics queries require between 1 and ${MAX_STATISTIC_IDS} statistic IDs`,
      { details: { statistic_count: values.length, maximum_statistics: MAX_STATISTIC_IDS } },
    );
  }
  return opaqueIds(values, MAX_STATISTIC_IDS, "statistic");
}

function flag(parameters: URLSearchParams, name: string, enabled: boolean | undefined): void {
  if (enabled === true) parameters.append(name, "");
}

/** Recorder-backed state history, activity/logbook, and statistics queries. */
export class HistoryService {
  constructor(readonly client: HomeAssistantClient) {}

  getHistory(query: HistoryQuery): Promise<HistoryState[][]> {
    const ids = entityIds(query.entityIds, MAX_HISTORY_ENTITY_IDS, "History");
    const startTime =
      query.startTime === undefined ? undefined : time(query.startTime, "start time");
    const endTime = query.endTime === undefined ? undefined : time(query.endTime, "end time");
    validateRange(startTime, endTime);
    const parameters = new URLSearchParams({ filter_entity_id: ids.join(",") });
    if (endTime !== undefined) parameters.set("end_time", endTime);
    flag(parameters, "minimal_response", query.minimalResponse);
    flag(parameters, "no_attributes", query.noAttributes);
    if (query.significantChangesOnly !== undefined) {
      parameters.set("significant_changes_only", query.significantChangesOnly ? "1" : "0");
    }
    const period =
      startTime === undefined
        ? "/api/history/period"
        : `/api/history/period/${encodeURIComponent(startTime)}`;
    return this.client.restRequest<HistoryState[][]>(`${period}?${parameters.toString()}`, {
      responseType: "json",
    });
  }

  async getLogbook(query: LogbookQuery): Promise<LogbookEntry[]> {
    const startTime = time(query.startTime, "logbook start time");
    const endTime =
      query.endTime === undefined ? undefined : time(query.endTime, "logbook end time");
    validateRange(startTime, endTime);
    const ids =
      query.entityIds === undefined
        ? undefined
        : entityIds(query.entityIds, MAX_LOGBOOK_FILTER_IDS, "Logbook");
    const deviceIds =
      query.deviceIds === undefined
        ? undefined
        : opaqueIds(query.deviceIds, MAX_LOGBOOK_FILTER_IDS, "device");
    const limit = query.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOGBOOK_ENTRIES) {
      throw new AppError(
        "HA_LOGBOOK_LIMIT",
        `Logbook limit must be between 1 and ${MAX_LOGBOOK_ENTRIES}`,
        { details: { requested_limit: limit, maximum_limit: MAX_LOGBOOK_ENTRIES } },
      );
    }

    const source = query.source ?? "websocket";
    if (source !== "websocket" && source !== "rest") {
      throw new AppError("HA_INVALID_REQUEST", "Logbook source must be websocket or rest");
    }
    let entries: LogbookEntry[];
    if (source === "websocket") {
      const command: {
        type: string;
        start_time: string;
        end_time?: string;
        entity_ids?: string[];
        device_ids?: string[];
        context_id?: string;
      } = { type: "logbook/get_events", start_time: startTime };
      if (endTime !== undefined) command.end_time = endTime;
      if (ids !== undefined) command.entity_ids = ids;
      if (deviceIds !== undefined) command.device_ids = deviceIds;
      if (query.contextId !== undefined) {
        const contextId = query.contextId.trim();
        if (contextId.length === 0 || contextId.length > 255) {
          throw new AppError("HA_INVALID_REQUEST", "Invalid Home Assistant context ID");
        }
        command.context_id = contextId;
      }
      entries = await this.client.wsCommand<LogbookEntry[]>(command);
    } else {
      if ((ids?.length ?? 0) > 1 || deviceIds !== undefined || query.contextId !== undefined) {
        throw new AppError(
          "HA_LOGBOOK_FILTER_UNSUPPORTED",
          "The REST logbook API supports at most one entity and no device/context filter; use websocket",
        );
      }
      const parameters = new URLSearchParams();
      if (endTime !== undefined) parameters.set("end_time", endTime);
      if (ids?.[0] !== undefined) parameters.set("entity", ids[0]);
      const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
      entries = await this.client.restRequest<LogbookEntry[]>(
        `/api/logbook/${encodeURIComponent(startTime)}${suffix}`,
        { responseType: "json" },
      );
    }
    return entries.length <= limit ? entries : entries.slice(-limit);
  }

  async getStatistics(query: StatisticsQuery): Promise<RecorderStatisticsResponse> {
    const ids = statisticIds(query.statisticIds);
    const startTime = time(query.startTime, "statistics start time");
    const endTime =
      query.endTime === undefined ? undefined : time(query.endTime, "statistics end time");
    validateRange(startTime, endTime);
    if (!STATISTIC_PERIODS.has(query.period)) {
      throw new AppError("HA_INVALID_REQUEST", "Invalid recorder statistics period", {
        details: { period: query.period },
      });
    }
    if (query.types.length === 0 || query.types.some((type) => !STATISTIC_TYPES.has(type))) {
      throw new AppError(
        "HA_INVALID_REQUEST",
        "At least one valid recorder statistic type is required",
      );
    }
    const types = [...new Set(query.types)];
    const data: Record<string, unknown> = {
      statistic_ids: ids,
      start_time: startTime,
      period: query.period,
      types,
    };
    if (endTime !== undefined) data.end_time = endTime;
    if (query.units !== undefined) data.units = { ...query.units };
    const response = await this.client.callService<RecorderStatisticsResponse>(
      "recorder",
      "get_statistics",
      data,
      { returnResponse: true },
    );
    if (Array.isArray(response) || !isStatisticsResponse(response)) {
      throw new AppError(
        "HA_INVALID_RESPONSE",
        "Home Assistant recorder.get_statistics returned no service response",
      );
    }
    return response.service_response;
  }

  getRecorderInfo(): Promise<RecorderInfo> {
    return this.client.wsCommand<RecorderInfo>({ type: "recorder/info" });
  }

  getStatisticsMetadata(query: StatisticsMetadataQuery = {}): Promise<StatisticsMetadata[]> {
    const command: { type: string; statistic_ids?: string[] } = {
      type: "recorder/get_statistics_metadata",
    };
    if (query.statisticIds !== undefined) command.statistic_ids = statisticIds(query.statisticIds);
    return this.client.wsCommand<StatisticsMetadata[]>(command);
  }

  listStatisticIds(statisticType?: "mean" | "sum"): Promise<StatisticsMetadata[]> {
    return this.client.wsCommand<StatisticsMetadata[]>({
      type: "recorder/list_statistic_ids",
      ...(statisticType === undefined ? {} : { statistic_type: statisticType }),
    });
  }
}

export function createHistoryService(client: HomeAssistantClient): HistoryService {
  return new HistoryService(client);
}

function isStatisticsResponse(
  response: ServiceCallExtendedResponse<RecorderStatisticsResponse>,
): response is ServiceCallExtendedResponse<RecorderStatisticsResponse> {
  const serviceResponse = response.service_response;
  return (
    typeof serviceResponse === "object" &&
    serviceResponse !== null &&
    "statistics" in serviceResponse &&
    typeof serviceResponse.statistics === "object" &&
    serviceResponse.statistics !== null
  );
}
