import { describe, expect, it } from "vitest";

import {
  buildDependencyGraph,
  extractEntityReferences,
  findBrokenAutomationReferences,
  findDevicesWithoutArea,
  findDuplicateEntities,
  findEntitiesWithoutArea,
  findOrphanedEntities,
  findStaleSensors,
  findUnavailableEntities,
  findUnusedHelpers,
  unifiedSearch,
  type DiagnosticsInput,
} from "../src/diagnostics/index.js";
import type {
  ConfigEntry,
  DeviceRegistryEntry,
  EntityRegistryEntry,
  EntityState,
} from "../src/shared/types.js";

const NOW = "2026-08-20T12:00:00.000Z";

function state(
  entityId: string,
  value = "on",
  lastUpdated = NOW,
  attributes: Record<string, unknown> = {},
): EntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes,
    last_changed: lastUpdated,
    last_updated: lastUpdated,
    context: {},
  };
}

describe("dependency extraction", () => {
  const nestedConfiguration = {
    trigger: [{ platform: "state", entity_id: "binary_sensor.front_door" }],
    condition: [
      {
        value_template:
          "{{ is_state('input_boolean.guests_home', 'on') and states.sensor.outdoor_temperature.state | float > 20 }}",
      },
    ],
    action: [
      {
        action: "light.turn_on",
        target: { entity_id: ["light.kitchen", "scene.evening"] },
      },
      {
        action: "script.notify_family",
        data: { message: "Inside: {{ states('sensor.indoor_temperature') }}" },
      },
    ],
  };

  it("recursively extracts nested values and template references with precise paths", () => {
    const references = extractEntityReferences(nestedConfiguration);

    expect(references).toEqual([
      {
        entity_id: "binary_sensor.front_door",
        path: "$.trigger[0].entity_id",
        value: "binary_sensor.front_door",
      },
      {
        entity_id: "input_boolean.guests_home",
        path: "$.condition[0].value_template",
        value:
          "{{ is_state('input_boolean.guests_home', 'on') and states.sensor.outdoor_temperature.state | float > 20 }}",
      },
      {
        entity_id: "light.kitchen",
        path: "$.action[0].target.entity_id[0]",
        value: "light.kitchen",
      },
      {
        entity_id: "scene.evening",
        path: "$.action[0].target.entity_id[1]",
        value: "scene.evening",
      },
      {
        entity_id: "script.notify_family",
        path: "$.action[1].action",
        value: "script.notify_family",
      },
      {
        entity_id: "sensor.indoor_temperature",
        path: "$.action[1].data.message",
        value: "Inside: {{ states('sensor.indoor_temperature') }}",
      },
      {
        entity_id: "sensor.outdoor_temperature",
        path: "$.condition[0].value_template",
        value:
          "{{ is_state('input_boolean.guests_home', 'on') and states.sensor.outdoor_temperature.state | float > 20 }}",
      },
    ]);
    expect(references).not.toContainEqual(expect.objectContaining({ entity_id: "light.turn_on" }));
  });

  it("retains source and value evidence in dependency and dependent queries", () => {
    const graph = buildDependencyGraph({
      automations: [
        {
          id: "arrival",
          entity_id: "automation.arrival",
          alias: "Arrival",
          config: nestedConfiguration,
        },
      ],
    });

    const dependencies = graph.getAutomationDependencies("arrival");
    expect(dependencies).toContainEqual({
      entity_id: "sensor.indoor_temperature",
      evidence: [
        {
          entity_id: "sensor.indoor_temperature",
          path: "$.action[1].data.message",
          value: "Inside: {{ states('sensor.indoor_temperature') }}",
          source_kind: "automation",
          source_id: "arrival",
        },
      ],
    });
    expect(graph.getEntityDependents("sensor.indoor_temperature")).toEqual([
      {
        source_kind: "automation",
        source_id: "arrival",
        source_entity_id: "automation.arrival",
        name: "Arrival",
        evidence: [
          {
            entity_id: "sensor.indoor_temperature",
            path: "$.action[1].data.message",
            value: "Inside: {{ states('sensor.indoor_temperature') }}",
            source_kind: "automation",
            source_id: "arrival",
          },
        ],
      },
    ]);
  });

  it("includes allowlisted configuration files in dependency evidence", () => {
    const graph = buildDependencyGraph({
      configFiles: [
        {
          path: "packages/lighting.yaml",
          parsed: { target: { entity_id: "light.kitchen" } },
        },
      ],
    });

    expect(graph.getEntityDependents("light.kitchen")).toEqual([
      expect.objectContaining({
        source_kind: "config_file",
        source_id: "packages/lighting.yaml",
        evidence: [
          expect.objectContaining({
            entity_id: "light.kitchen",
            path: "$.target.entity_id",
          }),
        ],
      }),
    ]);
  });

  it("reports only unknown automation references and includes evidence", () => {
    const findings = findBrokenAutomationReferences({
      states: [state("light.kitchen")],
      entityRegistry: [{ entity_id: "sensor.outdoor_temperature" }],
      automations: [
        {
          id: "climate_alert",
          entity_id: "automation.climate_alert",
          config: {
            condition: "{{ states('sensor.outdoor_temperature') | float > 30 }}",
            action: [
              {
                action: "light.turn_on",
                target: { entity_id: ["light.kitchen", "switch.missing_fan"] },
              },
              {
                condition: "{{ is_state('binary_sensor.missing_window', 'on') }}",
              },
            ],
          },
        },
      ],
    });

    expect(findings).toEqual([
      {
        automation_id: "climate_alert",
        automation_entity_id: "automation.climate_alert",
        entity_id: "binary_sensor.missing_window",
        evidence: [
          {
            entity_id: "binary_sensor.missing_window",
            path: "$.action[1].condition",
            value: "{{ is_state('binary_sensor.missing_window', 'on') }}",
          },
        ],
      },
      {
        automation_id: "climate_alert",
        automation_entity_id: "automation.climate_alert",
        entity_id: "switch.missing_fan",
        evidence: [
          {
            entity_id: "switch.missing_fan",
            path: "$.action[0].target.entity_id[1]",
            value: "switch.missing_fan",
          },
        ],
      },
    ]);
  });
});

describe("diagnostic audits", () => {
  it("finds unavailable and stale states using explicit time boundaries", () => {
    const states = [
      state("sensor.offline", "unavailable", "2026-08-17T12:00:00.000Z"),
      state("sensor.unknown", "unknown", "2026-08-20T11:00:00.000Z"),
      state("sensor.old", "21", "2026-08-18T12:00:00.000Z", { friendly_name: "Old" }),
      state("sensor.fresh", "22", "2026-08-20T11:00:00.000Z"),
    ];

    expect(findUnavailableEntities(states).map(({ entity_id }) => entity_id)).toEqual([
      "sensor.offline",
    ]);
    expect(
      findUnavailableEntities(states, { includeUnknown: true }).map(({ entity_id }) => entity_id),
    ).toEqual(["sensor.offline", "sensor.unknown"]);
    expect(
      findStaleSensors(states, {
        asOf: NOW,
        staleAfterMs: 24 * 60 * 60 * 1_000,
      }),
    ).toEqual([
      {
        entity_id: "sensor.old",
        state: "21",
        last_updated: "2026-08-18T12:00:00.000Z",
        age_ms: 48 * 60 * 60 * 1_000,
        name: "Old",
      },
    ]);
  });

  it("finds state, registry, device, and config-entry orphans", () => {
    const integrations: ConfigEntry[] = [{ entry_id: "present", domain: "demo", title: "Present" }];
    const findings = findOrphanedEntities({
      states: [state("sensor.state_only"), state("sensor.linked")],
      entityRegistry: [
        {
          entity_id: "sensor.linked",
          device_id: "missing-device",
          config_entry_id: "missing-entry",
        },
        { entity_id: "sensor.registry_only" },
      ],
      deviceRegistry: [],
      integrations,
    });

    expect(findings).toEqual([
      {
        entity_id: "sensor.linked",
        reason: "missing_config_entry",
        missing_id: "missing-entry",
      },
      {
        entity_id: "sensor.linked",
        reason: "missing_device",
        missing_id: "missing-device",
      },
      { entity_id: "sensor.registry_only", reason: "registry_without_state" },
      { entity_id: "sensor.state_only", reason: "state_without_registry" },
    ]);
  });

  it("finds duplicate state IDs, registry IDs, and platform-scoped unique IDs", () => {
    const findings = findDuplicateEntities({
      states: [state("SENSOR.DUPLICATE"), state("sensor.duplicate")],
      entityRegistry: [
        { entity_id: "sensor.registry_duplicate" },
        { entity_id: "SENSOR.REGISTRY_DUPLICATE" },
        { entity_id: "sensor.first", platform: "demo", unique_id: "same" },
        { entity_id: "sensor.second", platform: "demo", unique_id: "same" },
      ],
    });

    expect(findings).toEqual([
      {
        duplicate_key: "entity_id",
        source: "states",
        value: "sensor.duplicate",
        entity_ids: ["sensor.duplicate"],
        occurrences: 2,
      },
      {
        duplicate_key: "entity_id",
        source: "entity_registry",
        value: "sensor.registry_duplicate",
        entity_ids: ["sensor.registry_duplicate"],
        occurrences: 2,
      },
      {
        duplicate_key: "unique_id",
        source: "entity_registry",
        value: "same",
        entity_ids: ["sensor.first", "sensor.second"],
        occurrences: 2,
      },
    ]);
  });

  it("finds invalid area assignments while honoring direct and inherited areas", () => {
    const devices: DeviceRegistryEntry[] = [
      { id: "inherited", area_id: "kitchen" },
      { id: "unassigned", name: "Loose device" },
      { id: "unknown", area_id: "removed-area" },
    ];
    const entities: EntityRegistryEntry[] = [
      { entity_id: "sensor.direct", area_id: "kitchen" },
      { entity_id: "sensor.inherited", device_id: "inherited" },
      { entity_id: "sensor.unassigned" },
      { entity_id: "sensor.missing_device", device_id: "missing" },
      { entity_id: "sensor.unknown_area", area_id: "removed-area" },
    ];
    const areas = [{ area_id: "kitchen", name: "Kitchen" }];

    expect(findEntitiesWithoutArea(entities, devices, areas)).toEqual([
      {
        entity_id: "sensor.missing_device",
        device_id: "missing",
        reason: "missing_device",
      },
      { entity_id: "sensor.unassigned", reason: "unassigned" },
      {
        entity_id: "sensor.unknown_area",
        reason: "unknown_area",
        area_id: "removed-area",
      },
    ]);
    expect(findDevicesWithoutArea(devices, areas)).toEqual([
      { device_id: "unassigned", name: "Loose device", reason: "unassigned" },
      { device_id: "unknown", reason: "unknown_area", area_id: "removed-area" },
    ]);
  });

  it("finds unused helpers across resources, registry entries, and states", () => {
    const input: DiagnosticsInput = {
      helpers: [
        { entity_id: "input_boolean.used", name: "Used" },
        { entity_id: "input_boolean.unused", name: "Unused" },
      ],
      entityRegistry: [{ entity_id: "timer.registry_used", name: "Registry helper" }],
      states: [state("counter.state_only", "3", NOW, { friendly_name: "State helper" })],
      automations: [
        {
          id: "helper_consumer",
          config: {
            condition: "{{ is_state('input_boolean.used', 'on') }}",
            action: { target: { entity_id: "timer.registry_used" } },
          },
        },
      ],
    };

    expect(findUnusedHelpers(input)).toEqual([
      { entity_id: "counter.state_only", name: "State helper", source: "state" },
      { entity_id: "input_boolean.unused", name: "Unused", source: "resource" },
    ]);
  });
});

describe("unified search", () => {
  it("matches typo-tolerant terms across joined entity and location fields", () => {
    const page = unifiedSearch(
      {
        states: [
          state("sensor.kitchen_temperature", "22.4", NOW, {
            friendly_name: "Kitchen Temperature",
            unit_of_measurement: "C",
          }),
          state("light.garage", "off", NOW, { friendly_name: "Garage Light" }),
        ],
        entityRegistry: [
          { entity_id: "sensor.kitchen_temperature", device_id: "thermostat" },
          { entity_id: "light.garage" },
        ],
        deviceRegistry: [{ id: "thermostat", name: "Kitchen climate sensor", area_id: "kitchen" }],
        areaRegistry: [{ area_id: "kitchen", name: "Kitchen" }],
      },
      { query: "kithcen temprature", kinds: ["entity"], minimumScore: 0.6 },
    );

    expect(page.pagination).toEqual({ limit: 100, offset: 0, total: 1, has_more: false });
    expect(page.items[0]).toMatchObject({
      kind: "entity",
      id: "sensor.kitchen_temperature",
      title: "Kitchen Temperature",
      matched_fields: ["id"],
    });
    expect(page.items[0]!.score).toBeGreaterThan(0);
  });

  it("applies kind filtering and stable offset pagination after fuzzy scoring", () => {
    const input = {
      states: [
        state("sensor.alpha", "1", NOW, { friendly_name: "Alpha" }),
        state("sensor.beta", "2", NOW, { friendly_name: "Beta" }),
        state("sensor.gamma", "3", NOW, { friendly_name: "Gamma" }),
      ],
      configFiles: [{ path: "dashboards/kitchen.yaml", content: "title: Kitchen dashboard" }],
    };
    const page = unifiedSearch(input, {
      query: "sensr",
      kinds: ["entity"],
      minimumScore: 0.8,
      limit: 1,
      offset: 1,
    });

    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 3, has_more: true });
    expect(page.items.map(({ id }) => id)).toEqual(["sensor.beta"]);
    expect(page.items.every(({ kind }) => kind === "entity")).toBe(true);

    const files = unifiedSearch(input, {
      query: "dashbord",
      kinds: ["config_file"],
      minimumScore: 0.7,
    });
    expect(files.items.map(({ id }) => id)).toEqual(["dashboards/kitchen.yaml"]);
  });
});
