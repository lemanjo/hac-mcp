import { z } from "zod/v4";

import type { Application } from "../../app.js";
import type { DiscoveryListOptions } from "../../domains/discovery.js";
import { entityId, opaqueId, pageFields } from "../schemas.js";
import type { ToolRegistrar } from "../toolkit.js";

const emptySchema = z.object({});
const identifier = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .describe("Lowercase Home Assistant identifier");
const areaId = opaqueId.describe("Home Assistant area registry ID");
const deviceId = opaqueId.describe("Home Assistant device registry ID");
const integrationId = opaqueId.describe("Home Assistant config entry ID");

const discoveryFilterFields = {
  query: z.string().min(1).max(255).optional().describe("Case-insensitive text filter"),
  area_id: areaId.optional().describe("Only records related to this area"),
  device_id: deviceId.optional().describe("Only records related to this device"),
  integration_id: integrationId.optional().describe("Only records related to this integration"),
  platform: identifier.optional().describe("Only records provided by this platform"),
  domain: identifier.optional().describe("Only records in this Home Assistant domain"),
  include_disabled: z
    .boolean()
    .default(true)
    .describe("Include records disabled in the Home Assistant registry"),
  ...pageFields,
};

type DiscoveryFilterInput = z.infer<z.ZodObject<typeof discoveryFilterFields>>;

function discoveryOptions(input: DiscoveryFilterInput): DiscoveryListOptions {
  return {
    limit: input.limit,
    offset: input.offset,
    includeDisabled: input.include_disabled,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.area_id === undefined ? {} : { areaId: input.area_id }),
    ...(input.device_id === undefined ? {} : { deviceId: input.device_id }),
    ...(input.integration_id === undefined ? {} : { integrationId: input.integration_id }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.domain === undefined ? {} : { domain: input.domain }),
  };
}

export function registerDiscoveryTools(registrar: ToolRegistrar, app: Application): void {
  registrar.register({
    name: "get_home_assistant_info",
    title: "Get Home Assistant Info",
    description: "Get a combined overview of the API, core configuration, and system health.",
    risk: "READ",
    schema: emptySchema,
    source: "derived",
    stability: "internal",
    handler: () => app.runtime.getHomeAssistantInfo(),
  });

  registrar.register({
    name: "get_system_health",
    title: "Get System Health",
    description: "Get Home Assistant system-health data reported by loaded integrations.",
    risk: "READ",
    schema: emptySchema,
    source: "websocket",
    stability: "internal",
    handler: () => app.runtime.getSystemHealth(),
  });

  registrar.register({
    name: "get_config",
    title: "Get Home Assistant Config",
    description: "Get the public Home Assistant core configuration and runtime version.",
    risk: "READ",
    schema: emptySchema,
    source: "rest",
    stability: "public",
    handler: () => app.runtime.getConfig(),
  });

  registrar.register({
    name: "list_integrations",
    title: "List Integrations",
    description: "List config entries enriched with their related devices, entities, and areas.",
    risk: "READ",
    schema: z.object(discoveryFilterFields),
    source: "websocket",
    stability: "internal",
    handler: (input) => app.discovery.listIntegrations(discoveryOptions(input)),
  });

  registrar.register({
    name: "get_integration",
    title: "Get Integration",
    description: "Get one integration config entry and its registry relationships.",
    risk: "READ",
    schema: z.object({ integration_id: integrationId }),
    source: "websocket",
    stability: "internal",
    handler: ({ integration_id }) => app.discovery.getIntegration(integration_id),
  });

  registrar.register({
    name: "list_areas",
    title: "List Areas",
    description: "List Home Assistant areas with related devices, entities, and integrations.",
    risk: "READ",
    schema: z.object(discoveryFilterFields),
    source: "websocket",
    stability: "internal",
    handler: (input) => app.discovery.listAreas(discoveryOptions(input)),
  });

  registrar.register({
    name: "get_area",
    title: "Get Area",
    description: "Get one Home Assistant area and its registry relationships.",
    risk: "READ",
    schema: z.object({ area_id: areaId }),
    source: "websocket",
    stability: "internal",
    handler: ({ area_id }) => app.discovery.getArea(area_id),
  });

  registrar.register({
    name: "list_devices",
    title: "List Devices",
    description: "List Home Assistant devices with area, entity, integration, and platform data.",
    risk: "READ",
    schema: z.object(discoveryFilterFields),
    source: "websocket",
    stability: "internal",
    handler: (input) => app.discovery.listDevices(discoveryOptions(input)),
  });

  registrar.register({
    name: "get_device",
    title: "Get Device",
    description: "Get one Home Assistant device and its registry relationships.",
    risk: "READ",
    schema: z.object({ device_id: deviceId }),
    source: "websocket",
    stability: "internal",
    handler: ({ device_id }) => app.discovery.getDevice(device_id),
  });

  registrar.register({
    name: "list_entities",
    title: "List Entities",
    description: "List entity-registry entries with effective area, device, and integration data.",
    risk: "READ",
    schema: z.object(discoveryFilterFields),
    source: "websocket",
    stability: "internal",
    handler: (input) => app.discovery.listEntities(discoveryOptions(input)),
  });

  registrar.register({
    name: "get_entity",
    title: "Get Entity",
    description: "Get one entity-registry entry and its registry relationships.",
    risk: "READ",
    schema: z.object({ entity_id: entityId }),
    source: "websocket",
    stability: "internal",
    handler: ({ entity_id }) => app.discovery.getEntity(entity_id),
  });

  registrar.register({
    name: "search_entities",
    title: "Search Entities",
    description: "Search entity IDs, names, platforms, areas, devices, and integrations.",
    risk: "READ",
    schema: z.object({
      ...discoveryFilterFields,
      query: z.string().trim().min(1).max(255).describe("Text to find in entity metadata"),
    }),
    source: "derived",
    stability: "internal",
    handler: (input) => app.discovery.listEntities(discoveryOptions(input)),
  });

  registrar.register({
    name: "search_devices",
    title: "Search Devices",
    description: "Search device IDs, names, manufacturers, models, labels, and areas.",
    risk: "READ",
    schema: z.object({
      ...discoveryFilterFields,
      query: z.string().trim().min(1).max(255).describe("Text to find in device metadata"),
    }),
    source: "derived",
    stability: "internal",
    handler: (input) => app.discovery.listDevices(discoveryOptions(input)),
  });

  registrar.register({
    name: "search_home_assistant_registry",
    title: "Search Home Assistant Registries",
    description: "Search areas, devices, entities, integrations, and platforms in one result set.",
    risk: "READ",
    schema: z.object({
      query: z.string().trim().min(1).max(255).describe("Text to find across Home Assistant"),
      kinds: z
        .array(z.enum(["area", "device", "entity", "integration", "platform"]))
        .min(1)
        .max(5)
        .optional()
        .describe("Optional discovery record types to include"),
      ...pageFields,
    }),
    source: "derived",
    stability: "internal",
    handler: ({ query, kinds, limit, offset }) =>
      app.discovery.search(query, {
        limit,
        offset,
        ...(kinds === undefined ? {} : { kinds }),
      }),
  });
}
