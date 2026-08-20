import type { AddressInfo } from "node:net";

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
  onCommand: (socket: WebSocket, message: Record<string, unknown>) => void,
  validToken = "valid-token",
): Promise<MockServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
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
      onCommand(socket, message);
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

  it("assembles system-health subscription events instead of treating it as a command", async () => {
    const mock = await createMockServer((socket, message) => {
      if (message.type === "system_health/info") {
        result(socket, message.id, null);
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "event",
              event: { type: "initial", data: { recorder: { info: { recording: true } } } },
            }),
          );
          socket.send(JSON.stringify({ id: message.id, type: "event", event: { type: "finish" } }));
        }, 5);
      } else if (message.type === "unsubscribe_events") {
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
      await expect(client.getSystemHealth()).resolves.toMatchObject({
        complete: true,
        domains: { recorder: { info: { recording: true } } },
      });
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
