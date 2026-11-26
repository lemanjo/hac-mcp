import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { HomeAssistantClient } from "../src/homeassistant/client.js";
import { HomeAssistantWebSocketClient } from "../src/homeassistant/websocket.js";
import type { HomeAssistantRestClient } from "../src/homeassistant/rest.js";

interface MockServer {
  server: WebSocketServer;
  url: string;
}

const openServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function createMockServer(
  onCommand: (socket: WebSocket, message: Record<string, unknown>, transport: Socket) => void,
  validToken = "valid-token",
): Promise<MockServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket, request) => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.8.2" }));
    socket.on("message", (raw: RawData) => {
      const buffer = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      const message = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(
          JSON.stringify(
            message.access_token === validToken
              ? { type: "auth_ok", ha_version: "2026.8.2" }
              : { type: "auth_invalid", message: "Invalid access token" },
          ),
        );
        return;
      }
      onCommand(socket, message, request.socket);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

function result(socket: WebSocket, id: unknown, value: unknown): void {
  socket.send(JSON.stringify({ id, type: "result", success: true, result: value }));
}

describe("HomeAssistantWebSocketClient", () => {
  it("authenticates and correlates concurrent commands that finish out of order", async () => {
    const mock = await createMockServer((socket, message) => {
      const delay = message.type === "slow" ? 20 : 1;
      setTimeout(() => result(socket, message.id, { command: message.type }), delay);
    });
    const client = new HomeAssistantWebSocketClient({
      baseUrl: mock.url,
      token: "valid-token",
      timeoutMs: 1_000,
    });

    try {
      const [slow, fast] = await Promise.all([
        client.command<{ command: string }>({ type: "slow" }),
        client.command<{ command: string }>({ type: "fast" }),
      ]);
      expect(slow).toEqual({ command: "slow" });
      expect(fast).toEqual({ command: "fast" });
      expect(client.connected).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("collects a bounded event subscription and unsubscribes", async () => {
    let unsubscribed = false;
    const mock = await createMockServer((socket, message) => {
      if (message.type === "subscribe_events") {
        result(socket, message.id, null);
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "event",
              event: {
                event_type: "state_changed",
                data: { entity_id: "light.kitchen" },
                origin: "LOCAL",
                time_fired: "2026-08-20T12:00:00Z",
                context: {},
              },
            }),
          );
        }, 5);
      } else if (message.type === "unsubscribe_events") {
        unsubscribed = true;
        result(socket, message.id, null);
      }
    });
    const client = new HomeAssistantWebSocketClient({
      baseUrl: mock.url,
      token: "valid-token",
      timeoutMs: 1_000,
    });

    try {
      await expect(
        client.collectEvents({ eventType: "state_changed", count: 1, timeoutMs: 500 }),
      ).resolves.toMatchObject([{ data: { entity_id: "light.kitchen" } }]);
      expect(unsubscribed).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("applies system-health updates sent in the same batch as the subscription acknowledgement", async () => {
    let subscriptionId: unknown;
    const unsubscribedIds: unknown[] = [];
    const initial = {
      type: "initial",
      data: {
        recorder: {
          manage_url: "/config/recorder",
          info: { recording: true, database: { type: "pending" }, migration: { type: "pending" } },
        },
        homeassistant: { info: { version: "2026.8.2" } },
      },
    };
    const success = {
      type: "update",
      domain: "recorder",
      key: "database",
      success: true,
      data: "ok",
    };
    const failure = {
      type: "update",
      domain: "recorder",
      key: "migration",
      success: false,
      error: { type: "failed", error: "unknown" },
    };
    const finish = { type: "finish" };
    const events = [initial, success, failure, finish];
    const mock = await createMockServer((socket, message, transport) => {
      if (message.type === "system_health/info") {
        subscriptionId = message.id;
        // Flush the acknowledgement and events together, as separate WebSocket frames.
        transport.cork();
        result(socket, message.id, null);
        for (const event of events) {
          socket.send(JSON.stringify({ id: message.id, type: "event", event }));
        }
        transport.uncork();
      } else if (message.type === "unsubscribe_events") {
        unsubscribedIds.push(message.subscription);
        result(socket, message.id, null);
      }
    });
    const websocket = new HomeAssistantWebSocketClient({
      baseUrl: mock.url,
      token: "valid-token",
      timeoutMs: 1_000,
    });
    const rest = { close() {} } as HomeAssistantRestClient;
    const client = new HomeAssistantClient(
      { url: mock.url, token: "valid-token" },
      { rest, websocket },
    );

    try {
      await expect(client.getSystemHealth()).resolves.toEqual({
        complete: true,
        domains: {
          recorder: {
            manage_url: "/config/recorder",
            info: { recording: true, database: "ok", migration: failure.error },
          },
          homeassistant: initial.data.homeassistant,
        },
        raw_events: events,
      });
      expect(subscriptionId).toEqual(expect.any(Number));
      expect(unsubscribedIds).toEqual([subscriptionId]);
    } finally {
      await client.close();
    }
  });

  it("fails closed when Home Assistant rejects the token", async () => {
    const mock = await createMockServer(() => undefined);
    const client = new HomeAssistantWebSocketClient({
      baseUrl: mock.url,
      token: "wrong-token",
      timeoutMs: 1_000,
    });

    await expect(client.command({ type: "get_states" })).rejects.toMatchObject({
      code: "HA_WS_AUTH_FAILED",
      retryable: false,
    });
    await client.close();
  });
});
