import { z } from "zod/v4";

import type { Application } from "../../app.js";
import {
  MAX_HISTORY_ENTITY_IDS,
  MAX_LOGBOOK_ENTRIES,
  MAX_LOGBOOK_FILTER_IDS,
  MAX_RUNTIME_EVENT_COLLECTION_MS,
  MAX_RUNTIME_EVENT_COUNT,
  MAX_STATISTIC_IDS,
  type StateListOptions,
} from "../../domains/index.js";
import { paginate } from "../../shared/types.js";
import { entityId, opaqueId, pageFields, timeRangeFields } from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";

const identifier = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .describe("Lowercase Home Assistant identifier");
const areaId = opaqueId.describe("Home Assistant area registry ID");
const deviceId = opaqueId.describe("Home Assistant device registry ID");

const stateFilterFields = {
  query: z.string().trim().min(1).max(255).optional().describe("Entity ID or friendly-name text"),
  domain: identifier.optional().describe("Only states in this entity domain"),
  state: z.string().max(255).optional().describe("Only entities with this exact state"),
  include_unavailable: z
    .boolean()
    .default(true)
    .describe("Include entities whose state is unavailable or unknown"),
  ...pageFields,
};

type StateFilterInput = z.infer<z.ZodObject<typeof stateFilterFields>>;

function stateOptions(input: StateFilterInput): StateListOptions {
  return {
    limit: input.limit,
    offset: input.offset,
    includeUnavailable: input.include_unavailable,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    ...(input.state === undefined ? {} : { state: input.state }),
  };
}

const eventTypeFields = {
  query: z.string().trim().min(1).max(255).optional().describe("Event-type text filter"),
  minimum_listeners: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Only event types with at least this many listeners"),
  ...pageFields,
};

const statisticPeriod = z.enum(["5minute", "hour", "day", "week", "month", "year"]);
const statisticType = z.enum(["change", "last_reset", "max", "mean", "min", "state", "sum"]);
const eventCollectionFields = {
  event_type: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional exact event type; omit to observe all event types"),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_RUNTIME_EVENT_COUNT)
    .default(1)
    .describe("Maximum events to collect before unsubscribing"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_RUNTIME_EVENT_COLLECTION_MS)
    .default(30_000)
    .describe("Maximum collection duration before unsubscribing"),
};

export function registerRuntimeTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "list_services",
    title: "List Services",
    description: "List callable Home Assistant services and their live field definitions.",
    risk: "READ",
    schema: z.object({
      query: z.string().trim().min(1).max(255).optional().describe("Service text filter"),
      domain: identifier.optional().describe("Only services in this domain"),
      ...pageFields,
    }),
    source: "rest",
    stability: "public",
    handler: ({ query, domain, limit, offset }) =>
      app.runtime.listServices({
        limit,
        offset,
        ...(query === undefined ? {} : { query }),
        ...(domain === undefined ? {} : { domain }),
      }),
  });

  registrar.register({
    name: "list_event_types",
    title: "List Event Types",
    description: "List registered Home Assistant event types and their listener counts.",
    risk: "READ",
    schema: z.object(eventTypeFields),
    source: "rest",
    stability: "public",
    handler: ({ query, minimum_listeners, limit, offset }) =>
      app.runtime.listEventTypes({
        limit,
        offset,
        minimumListeners: minimum_listeners,
        ...(query === undefined ? {} : { query }),
      }),
  });

  registrar.register({
    name: "get_state",
    title: "Get State",
    description: "Get the current state and attributes of one Home Assistant entity.",
    risk: "READ",
    schema: z.object({ entity_id: entityId }),
    source: "rest",
    stability: "public",
    handler: ({ entity_id }) => app.runtime.getState(entity_id),
  });

  registrar.register({
    name: "get_states",
    title: "Get States",
    description: "List current entity states with optional text, domain, and state filters.",
    risk: "READ",
    schema: z.object(stateFilterFields),
    source: "rest",
    stability: "public",
    handler: (input) => app.runtime.listStates(stateOptions(input)),
  });

  registrar.register({
    name: "get_states_by_area",
    title: "Get States By Area",
    description:
      "List current states for entities assigned directly or through devices to an area.",
    risk: "READ",
    schema: z.object({ area_id: areaId, ...stateFilterFields }),
    source: "derived",
    stability: "internal",
    handler: ({ area_id, ...input }) => app.runtime.listStatesByArea(area_id, stateOptions(input)),
  });

  registrar.register({
    name: "get_states_by_device",
    title: "Get States By Device",
    description: "List current states for entities associated with a device-registry entry.",
    risk: "READ",
    schema: z.object({ device_id: deviceId, ...stateFilterFields }),
    source: "derived",
    stability: "internal",
    handler: ({ device_id, ...input }) =>
      app.runtime.listStatesByDevice(device_id, stateOptions(input)),
  });

  registrar.register({
    name: "get_history",
    title: "Get State History",
    description: "Get recorder-backed state history grouped by requested entity.",
    risk: "READ",
    schema: z.object({
      entity_ids: z
        .array(entityId)
        .min(1)
        .max(MAX_HISTORY_ENTITY_IDS)
        .describe("Entities whose state history should be returned"),
      start_time: timeRangeFields.start_time.optional(),
      end_time: timeRangeFields.end_time,
      minimal_response: z.boolean().default(true).describe("Use compact intermediate history rows"),
      no_attributes: z.boolean().default(false).describe("Omit state attributes"),
      significant_changes_only: z
        .boolean()
        .default(false)
        .describe("Return only significant state changes"),
    }),
    source: "rest",
    stability: "public",
    handler: ({
      entity_ids,
      start_time,
      end_time,
      minimal_response,
      no_attributes,
      significant_changes_only,
    }) =>
      app.history.getHistory({
        entityIds: entity_ids,
        minimalResponse: minimal_response,
        noAttributes: no_attributes,
        significantChangesOnly: significant_changes_only,
        ...(start_time === undefined ? {} : { startTime: start_time }),
        ...(end_time === undefined ? {} : { endTime: end_time }),
      }),
  });

  registrar.register({
    name: "get_logbook",
    title: "Get Logbook",
    description:
      "Get bounded Home Assistant logbook activity with entity, device, or context filters.",
    risk: "READ",
    schema: z.object({
      ...timeRangeFields,
      entity_ids: z
        .array(entityId)
        .min(1)
        .max(MAX_LOGBOOK_FILTER_IDS)
        .optional()
        .describe("Only activity involving these entities"),
      device_ids: z
        .array(deviceId)
        .min(1)
        .max(MAX_LOGBOOK_FILTER_IDS)
        .optional()
        .describe("Only activity involving these devices"),
      context_id: opaqueId.optional().describe("Only activity with this context ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LOGBOOK_ENTRIES)
        .default(1_000)
        .describe("Maximum newest matching entries to return"),
    }),
    source: "websocket",
    stability: "internal",
    handler: ({ start_time, end_time, entity_ids, device_ids, context_id, limit }) =>
      app.history.getLogbook({
        startTime: start_time,
        source: "websocket",
        limit,
        ...(end_time === undefined ? {} : { endTime: end_time }),
        ...(entity_ids === undefined ? {} : { entityIds: entity_ids }),
        ...(device_ids === undefined ? {} : { deviceIds: device_ids }),
        ...(context_id === undefined ? {} : { contextId: context_id }),
      }),
  });

  registrar.register({
    name: "get_events",
    title: "Get Events",
    description: "Collect a bounded one-shot batch of live Home Assistant events.",
    risk: "READ",
    schema: z.object(eventCollectionFields),
    source: "websocket",
    stability: "public",
    handler: ({ event_type, count, timeout_ms }) =>
      app.runtime.collectEvents({
        count,
        timeoutMs: timeout_ms,
        ...(event_type === undefined ? {} : { eventType: event_type }),
      }),
  });

  registrar.register({
    name: "subscribe_events",
    title: "Subscribe To Events",
    description:
      "Temporarily subscribe to Home Assistant events, returning when count or timeout is reached.",
    risk: "READ",
    schema: z.object(eventCollectionFields),
    source: "websocket",
    stability: "public",
    handler: ({ event_type, count, timeout_ms }) =>
      app.runtime.collectEvents({
        count,
        timeoutMs: timeout_ms,
        ...(event_type === undefined ? {} : { eventType: event_type }),
      }),
  });

  registrar.register({
    name: "get_statistics",
    title: "Get Statistics",
    description: "Get recorder long-term statistic values for an explicit time range and period.",
    risk: "READ",
    schema: z.object({
      statistic_ids: z
        .array(opaqueId.describe("Home Assistant statistic ID"))
        .min(1)
        .max(MAX_STATISTIC_IDS),
      ...timeRangeFields,
      period: statisticPeriod.describe("Aggregation period"),
      types: z
        .array(statisticType)
        .min(1)
        .max(7)
        .default(["mean", "min", "max"])
        .describe("Statistic values to include"),
      units: z
        .record(z.string(), z.string())
        .optional()
        .describe("Requested output units keyed by unit class"),
    }),
    source: "rest",
    stability: "public",
    handler: ({ statistic_ids, start_time, end_time, period, types, units }) =>
      app.history.getStatistics({
        statisticIds: statistic_ids,
        startTime: start_time,
        period,
        types,
        ...(end_time === undefined ? {} : { endTime: end_time }),
        ...(units === undefined ? {} : { units }),
      }),
  });

  registrar.register({
    name: "get_recorder_statistics",
    title: "Get Recorder Statistics",
    description: "List recorder statistic metadata used to discover valid long-term statistic IDs.",
    risk: "READ",
    schema: z.object({
      statistic_ids: z
        .array(opaqueId.describe("Home Assistant statistic ID"))
        .min(1)
        .max(MAX_STATISTIC_IDS)
        .optional()
        .describe("Optional statistic IDs whose metadata should be returned"),
      ...pageFields,
    }),
    source: "websocket",
    stability: "internal",
    handler: async ({ statistic_ids, limit, offset }) => {
      const statistics = await app.history.getStatisticsMetadata({
        ...(statistic_ids === undefined ? {} : { statisticIds: statistic_ids }),
      });
      return paginate(statistics, { limit, offset });
    },
  });
}
