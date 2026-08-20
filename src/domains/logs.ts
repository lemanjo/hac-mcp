import type { HomeAssistantClient } from "../homeassistant/client.js";
import { AppError } from "../shared/errors.js";

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_LINES = 10_000;
export const MAX_LOG_ENTRIES = 2_000;

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "UNKNOWN";
export type LogMode = "full" | "condensed";

export interface LogTimestampFilter {
  from?: string | number | Date;
  to?: string | number | Date;
}

export interface LogQueryOptions {
  mode?: LogMode;
  maxBytes?: number;
  maxLines?: number;
  maxEntries?: number;
  severity?: LogSeverity | readonly LogSeverity[];
  minimumSeverity?: Exclude<LogSeverity, "UNKNOWN">;
  integration?: string | readonly string[];
  component?: string | readonly string[];
  entityId?: string | readonly string[];
  deviceId?: string | readonly string[];
  timestamp?: LogTimestampFilter;
  startTime?: string | number | Date;
  endTime?: string | number | Date;
  query?: string;
}

export interface LogEntry {
  timestamp?: string;
  severity: LogSeverity;
  logger?: string;
  integration?: string;
  component?: string;
  message: string;
  entity_ids: string[];
  raw: string;
  line_count: number;
  byte_count: number;
}

export interface LogResult {
  mode: LogMode;
  text: string;
  entries: LogEntry[];
  source_bytes: number;
  source_lines: number;
  matched_entries: number;
  truncated: {
    bytes: boolean;
    lines: boolean;
    entries: boolean;
    output: boolean;
  };
  limits: {
    max_bytes: number;
    max_lines: number;
    max_entries: number;
  };
}

export type RecentLogOptions = Omit<LogQueryOptions, "severity" | "minimumSeverity">;
export type IntegrationLogOptions = Omit<RecentLogOptions, "integration">;

interface ParsedHeader {
  timestamp?: string;
  severity: LogSeverity;
  logger?: string;
  message: string;
}

interface EntryBuilder extends ParsedHeader {
  lines: string[];
}

const SEVERITY_RANK: Record<LogSeverity, number> = {
  UNKNOWN: 0,
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

const CURRENT_HEADER =
  /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(CRITICAL|ERROR|WARNING|WARN|INFO|DEBUG)\b(?:\s+\([^)]*\))?\s*(?:\[([^\]]+)\])?\s*(.*)$/i;
const OLD_HEADER = /^(\d{2}-\d{2}-\d{2,4}\s+\d{2}:\d{2}:\d{2})\s+([^:]+):\s*(.*)$/;
const ENTITY_ID = /\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/gi;

function normalizedSeverity(value: string): LogSeverity {
  const severity = value.toUpperCase();
  if (severity === "WARN") return "WARNING";
  return severity in SEVERITY_RANK ? (severity as LogSeverity) : "UNKNOWN";
}

function parseHeader(line: string): ParsedHeader | undefined {
  const current = CURRENT_HEADER.exec(line);
  if (current !== null) {
    const timestamp = current[1];
    const logger = current[3]?.trim();
    return {
      ...(timestamp === undefined ? {} : { timestamp }),
      severity: normalizedSeverity(current[2] ?? "UNKNOWN"),
      ...(logger === undefined || logger.length === 0 ? {} : { logger }),
      message: current[4]?.trim() ?? "",
    };
  }
  const old = OLD_HEADER.exec(line);
  if (old !== null) {
    return {
      ...(old[1] === undefined ? {} : { timestamp: old[1] }),
      severity: "ERROR",
      ...(old[2] === undefined ? {} : { logger: old[2].trim() }),
      message: old[3]?.trim() ?? "",
    };
  }
  return undefined;
}

function integrationFromLogger(logger: string | undefined): string | undefined {
  if (logger === undefined) return undefined;
  const match = /(?:^|\.)(?:custom_components|components)\.([a-z0-9_]+)/i.exec(logger);
  return match?.[1]?.toLowerCase();
}

function componentFromLogger(logger: string | undefined): string | undefined {
  if (logger === undefined) return undefined;
  const component = integrationFromLogger(logger);
  if (component !== undefined) return component;
  return logger.split(".").filter(Boolean).at(-1)?.toLowerCase();
}

function finishEntry(entry: EntryBuilder): LogEntry {
  const raw = entry.lines.join("\n");
  const entityText = [entry.message, ...entry.lines.slice(1)].join("\n");
  const ids = [...new Set(entityText.match(ENTITY_ID)?.map((id) => id.toLowerCase()) ?? [])].sort();
  const integration = integrationFromLogger(entry.logger);
  const component = componentFromLogger(entry.logger);
  return {
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
    severity: entry.severity,
    ...(entry.logger === undefined ? {} : { logger: entry.logger }),
    ...(integration === undefined ? {} : { integration }),
    ...(component === undefined ? {} : { component }),
    message: entry.message,
    entity_ids: ids,
    raw,
    line_count: entry.lines.length,
    byte_count: Buffer.byteLength(raw),
  };
}

export function parseHomeAssistantLogs(lines: readonly string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: EntryBuilder | undefined;
  const finish = (): void => {
    if (current === undefined) return;
    entries.push(finishEntry(current));
    current = undefined;
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header !== undefined) {
      finish();
      current = { ...header, lines: [line] };
      continue;
    }
    const loggerMatch = /^Logger:\s*(.+)$/i.exec(line);
    if (loggerMatch !== null) {
      finish();
      const logger = loggerMatch[1]?.trim();
      current = {
        severity: "ERROR",
        ...(logger === undefined || logger.length === 0 ? {} : { logger }),
        message: "",
        lines: [line],
      };
      continue;
    }
    if (current !== undefined) {
      current.lines.push(line);
      const lastLogged = /^Last logged:\s*(.+)$/i.exec(line);
      if (lastLogged?.[1] !== undefined) current.timestamp = lastLogged[1].trim();
      if (
        current.message.length === 0 &&
        line.trim().length > 0 &&
        !/^(Source|First occurred|Last logged):/i.test(line)
      ) {
        current.message = line.trim();
      }
      continue;
    }
    if (line.trim().length > 0 && !/^-{3,}$/.test(line.trim())) {
      current = { severity: "UNKNOWN", message: line.trim(), lines: [line] };
    }
  }
  finish();
  return entries;
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new AppError("HA_LOG_LIMIT", `${label} must be between 1 and ${maximum}`, {
      details: { requested_limit: result, maximum_limit: maximum },
    });
  }
  return result;
}

function tailBytes(value: string, maximum: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.length <= maximum) return { text: value, truncated: false };
  let result = buffer.subarray(buffer.length - maximum).toString("utf8");
  const newline = result.indexOf("\n");
  if (newline >= 0) result = result.slice(newline + 1);
  return { text: result, truncated: true };
}

function filterValues(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = (typeof value === "string" ? [value] : [...value])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) {
    throw new AppError("HA_INVALID_LOG_FILTER", "Log filter values cannot be empty");
  }
  return [...new Set(values)];
}

function filterTime(value: string | number | Date | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(result)) {
    throw new AppError("HA_INVALID_TIME", `Invalid log ${label}`, {
      details: { value: String(value) },
    });
  }
  return result;
}

function entryTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const direct = Date.parse(value.replace(",", "."));
  if (Number.isFinite(direct)) return direct;
  const old = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (old === null) return undefined;
  const yearPart = Number(old[3]);
  const year = yearPart < 100 ? 2000 + yearPart : yearPart;
  return new Date(
    year,
    Number(old[2]) - 1,
    Number(old[1]),
    Number(old[4]),
    Number(old[5]),
    Number(old[6]),
  ).getTime();
}

function condensedEntry(entry: LogEntry): string {
  const timestamp = entry.timestamp === undefined ? "" : `${entry.timestamp} `;
  const logger = entry.logger === undefined ? "" : ` [${entry.logger}]`;
  return `${timestamp}${entry.severity}${logger} ${entry.message}`.trim();
}

/** Bounded parsing and filtering of Home Assistant's current-session error log. */
export class LogsService {
  constructor(readonly client: HomeAssistantClient) {}

  async getLogs(options: LogQueryOptions = {}): Promise<LogResult> {
    const mode = options.mode ?? "full";
    if (mode !== "full" && mode !== "condensed") {
      throw new AppError("HA_INVALID_LOG_FILTER", "Log mode must be full or condensed");
    }
    const maxBytes = boundedInteger(options.maxBytes, 512 * 1024, MAX_LOG_BYTES, "Log byte limit");
    const maxLines = boundedInteger(options.maxLines, 2_000, MAX_LOG_LINES, "Log line limit");
    const maxEntries = boundedInteger(options.maxEntries, 500, MAX_LOG_ENTRIES, "Log entry limit");
    let raw: string;
    try {
      raw = await this.client.getLogs();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "HA_NOT_FOUND") throw error;
      const entries = await this.client.getSystemLog();
      raw = entries
        .map((entry) => {
          const timestamp = new Date(entry.timestamp * 1_000).toISOString();
          const message = entry.message.join("\n");
          const exception = entry.exception ? `\n${entry.exception}` : "";
          return `${timestamp} ${entry.level.toUpperCase()} [${entry.name}] ${message}${exception}`;
        })
        .join("\n");
    }
    const sourceBytes = Buffer.byteLength(raw);
    const sourceLines = raw.length === 0 ? 0 : raw.split(/\r?\n/).length;
    const byteLimited = tailBytes(raw, maxBytes);
    let lines = byteLimited.text.split(/\r?\n/);
    const linesTruncated = lines.length > maxLines;
    if (linesTruncated) lines = lines.slice(-maxLines);
    const parsed = parseHomeAssistantLogs(lines);

    const requestedSeverities =
      options.severity === undefined
        ? undefined
        : typeof options.severity === "string"
          ? [options.severity]
          : options.severity;
    const selectedSeverities =
      requestedSeverities === undefined
        ? undefined
        : new Set(requestedSeverities.map(normalizedSeverity));
    if (requestedSeverities?.length === 0) {
      throw new AppError("HA_INVALID_LOG_FILTER", "At least one log severity is required");
    }
    const minimumSeverity =
      options.minimumSeverity === undefined
        ? undefined
        : normalizedSeverity(options.minimumSeverity);
    if (options.minimumSeverity !== undefined && minimumSeverity === "UNKNOWN") {
      throw new AppError("HA_INVALID_LOG_FILTER", "Invalid minimum log severity");
    }
    const integrations = filterValues(options.integration);
    const components = filterValues(options.component);
    const entities = filterValues(options.entityId);
    const devices = filterValues(options.deviceId);
    const from = filterTime(options.startTime ?? options.timestamp?.from, "start time");
    const to = filterTime(options.endTime ?? options.timestamp?.to, "end time");
    if (from !== undefined && to !== undefined && to < from) {
      throw new AppError("HA_INVALID_TIME_RANGE", "Log end time must not be before start time");
    }
    const query = options.query?.trim().toLowerCase();
    if (options.query !== undefined && query?.length === 0) {
      throw new AppError("HA_INVALID_LOG_FILTER", "Log query cannot be empty");
    }

    let deviceEntities = new Map<string, Set<string>>();
    if (devices !== undefined) {
      const requestedDevices = new Set(devices);
      deviceEntities = new Map(devices.map((deviceId) => [deviceId, new Set<string>()]));
      for (const entity of await this.client.getEntityRegistry()) {
        if (
          entity.device_id !== null &&
          entity.device_id !== undefined &&
          requestedDevices.has(entity.device_id.toLowerCase())
        ) {
          deviceEntities.get(entity.device_id.toLowerCase())?.add(entity.entity_id.toLowerCase());
        }
      }
    }

    const matching = parsed.filter((entry) => {
      const rawLower = entry.raw.toLowerCase();
      const timestamp = entryTime(entry.timestamp);
      return (
        (selectedSeverities === undefined || selectedSeverities.has(entry.severity)) &&
        (minimumSeverity === undefined ||
          SEVERITY_RANK[entry.severity] >= SEVERITY_RANK[minimumSeverity]) &&
        (integrations === undefined ||
          integrations.some(
            (integration) => entry.integration === integration || rawLower.includes(integration),
          )) &&
        (components === undefined ||
          components.some(
            (component) => entry.component === component || rawLower.includes(component),
          )) &&
        (entities === undefined || entities.some((entity) => entry.entity_ids.includes(entity))) &&
        (devices === undefined ||
          devices.some(
            (device) =>
              rawLower.includes(device) ||
              [...(deviceEntities.get(device) ?? [])].some((entity) =>
                entry.entity_ids.includes(entity),
              ),
          )) &&
        (from === undefined || (timestamp !== undefined && timestamp >= from)) &&
        (to === undefined || (timestamp !== undefined && timestamp <= to)) &&
        (query === undefined || rawLower.includes(query))
      );
    });
    const entriesTruncated = matching.length > maxEntries;
    const entries = entriesTruncated ? matching.slice(-maxEntries) : matching;
    const output = entries
      .map((entry) => (mode === "full" ? entry.raw : condensedEntry(entry)))
      .join("\n");
    const outputLimited = tailBytes(output, maxBytes);
    return {
      mode,
      text: outputLimited.text,
      entries,
      source_bytes: sourceBytes,
      source_lines: sourceLines,
      matched_entries: matching.length,
      truncated: {
        bytes: byteLimited.truncated,
        lines: linesTruncated,
        entries: entriesTruncated,
        output: outputLimited.truncated,
      },
      limits: { max_bytes: maxBytes, max_lines: maxLines, max_entries: maxEntries },
    };
  }

  getFullLogs(options: Omit<LogQueryOptions, "mode"> = {}): Promise<LogResult> {
    return this.getLogs({ ...options, mode: "full" });
  }

  getCondensedLogs(options: Omit<LogQueryOptions, "mode"> = {}): Promise<LogResult> {
    return this.getLogs({ ...options, mode: "condensed" });
  }

  getRecentErrors(options: RecentLogOptions = {}): Promise<LogResult> {
    return this.getLogs({
      maxEntries: 50,
      ...options,
      severity: ["ERROR", "CRITICAL"],
    });
  }

  getRecentWarnings(options: RecentLogOptions = {}): Promise<LogResult> {
    return this.getLogs({ maxEntries: 50, ...options, severity: "WARNING" });
  }

  getIntegrationErrors(
    integration: string | readonly string[],
    options: IntegrationLogOptions = {},
  ): Promise<LogResult> {
    return this.getLogs({
      maxEntries: 100,
      ...options,
      integration,
      severity: ["ERROR", "CRITICAL"],
    });
  }
}

export { LogsService as LoggingService };

export function createLogsService(client: HomeAssistantClient): LogsService {
  return new LogsService(client);
}
