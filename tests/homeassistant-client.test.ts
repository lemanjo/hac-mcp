/* eslint-disable @typescript-eslint/require-await */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAssistantEditorRestAdapter } from "../src/domains/resources.js";
import { TtlCache } from "../src/homeassistant/cache.js";
import { HomeAssistantClient } from "../src/homeassistant/client.js";
import { HomeAssistantRestClient } from "../src/homeassistant/rest.js";
import type { HomeAssistantWebSocketClient } from "../src/homeassistant/websocket.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
let serviceCalls: CapturedRequest[];
let editorConfigs: Map<string, Record<string, unknown>>;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

beforeEach(() => {
  serviceCalls = [];
  editorConfigs = new Map();
});

describe("HomeAssistantRestClient", () => {
  it("sends an immutable bearer credential and JSON request headers", async () => {
    const client = new HomeAssistantRestClient({ baseUrl, token: "secret-token" });
    try {
      const body = { brightness: 42 };
      const result = await client.request<CapturedRequest>("/inspect?mode=full", {
        method: "post",
        headers: {
          accept: "application/problem+json",
          authorization: "Bearer attacker-controlled",
          "x-test": "kept",
        },
        body,
        responseType: "json",
      });

      expect(result).toMatchObject({ method: "POST", url: "/inspect?mode=full", body });
      expect(result.headers.authorization).toBe("Bearer secret-token");
      expect(result.headers.accept).toBe("application/problem+json");
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["content-length"]).toBe(
        String(Buffer.byteLength(JSON.stringify(body))),
      );
      expect(result.headers["x-test"]).toBe("kept");
    } finally {
      client.close();
    }
  });

  it.each([
    [401, "HA_AUTH_FAILED", false],
    [403, "HA_PERMISSION_DENIED", false],
    [404, "HA_NOT_FOUND", false],
    [400, "HA_BAD_REQUEST", false],
    [422, "HA_BAD_REQUEST", false],
    [409, "HA_CONFLICT", false],
    [429, "HA_RATE_LIMITED", true],
    [500, "HA_UNAVAILABLE", true],
    [408, "HA_HTTP_ERROR", true],
    [418, "HA_HTTP_ERROR", false],
  ] as const)("maps HTTP %i to %s", async (status, code, retryable) => {
    const client = new HomeAssistantRestClient({ baseUrl, token: "token" });
    try {
      await expect(client.request(`/status/${status}`)).rejects.toMatchObject({
        code,
        status,
        retryable,
        details: {
          method: "GET",
          path: `/status/${status}`,
          status,
          response: { message: `status ${status}` },
          retry_after: status === 429 ? "7" : null,
        },
      });
    } finally {
      client.close();
    }
  });

  it("maps invalid successful JSON and request timeouts to stable errors", async () => {
    const client = new HomeAssistantRestClient({ baseUrl, token: "token", timeoutMs: 25 });
    try {
      await expect(client.request("/invalid-json", { responseType: "json" })).rejects.toMatchObject(
        { code: "HA_INVALID_RESPONSE", retryable: true },
      );
      await expect(client.request("/slow")).rejects.toMatchObject({
        code: "HA_REQUEST_TIMEOUT",
        retryable: true,
        details: { method: "GET", path: "/slow", timeout_ms: 25 },
      });
    } finally {
      client.close();
    }
  });

  it("aborts responses that exceed the configured byte limit", async () => {
    const client = new HomeAssistantRestClient({
      baseUrl,
      token: "token",
      maxResponseBytes: 32,
    });
    try {
      await expect(client.request("/large", { responseType: "text" })).rejects.toMatchObject({
        code: "HA_RESPONSE_TOO_LARGE",
      });
    } finally {
      client.close();
    }
  });

  it("resolves only origin-relative paths and preserves their query", async () => {
    const client = new HomeAssistantRestClient({
      baseUrl: `${baseUrl}/ignored/base?discarded=yes#fragment`,
      token: "token",
    });
    try {
      await expect(client.request("path-probe?name=Kitchen%20Light")).resolves.toEqual({
        url: "/path-probe?name=Kitchen%20Light",
      });
      await expect(client.request("")).rejects.toMatchObject({ code: "HA_INVALID_PATH" });
      await expect(client.request("//other-host/api")).rejects.toMatchObject({
        code: "HA_INVALID_PATH",
      });
      await expect(client.request("https://other-host/api")).rejects.toMatchObject({
        code: "HA_INVALID_PATH",
      });
    } finally {
      client.close();
    }
  });
});

describe("TtlCache and HomeAssistantClient caching", () => {
  it("coalesces concurrent loads and invalidates a completed value", async () => {
    const cache = new TtlCache<string, string>(1_000);
    const pending = deferred<string>();
    const loader = vi.fn(() => pending.promise);

    const first = cache.getOrLoad("services", loader);
    const second = cache.getOrLoad("services", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve("loaded");
    await expect(Promise.all([first, second])).resolves.toEqual(["loaded", "loaded"]);
    expect(cache.get("services")).toBe("loaded");
    expect(cache.invalidate((key) => key === "services")).toBe(1);
    expect(cache.has("services")).toBe(false);
  });

  it("does not let an invalidated in-flight load overwrite a fresh load", async () => {
    const cache = new TtlCache<string, string>(1_000);
    const stale = deferred<string>();
    const staleResult = cache.getOrLoad("registry", () => stale.promise);

    expect(cache.invalidate()).toBe(0);
    await expect(cache.getOrLoad("registry", async () => "fresh")).resolves.toBe("fresh");
    stale.resolve("stale");
    await expect(staleResult).resolves.toBe("stale");
    expect(cache.get("registry")).toBe("fresh");
  });

  it("coalesces service discovery and honors scoped client invalidation", async () => {
    const first = deferred<Array<{ domain: string; services: Record<string, never> }>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([{ domain: "switch", services: {} }]);
    const rest = { request, close: vi.fn() } as unknown as HomeAssistantRestClient;
    const websocket = fakeWebsocket();
    const client = new HomeAssistantClient(
      { url: "http://homeassistant.local", token: "token" },
      { rest, websocket },
    );

    const one = client.getServices();
    const two = client.getServices();
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve([{ domain: "light", services: {} }]);
    await expect(Promise.all([one, two])).resolves.toEqual([
      [{ domain: "light", services: {} }],
      [{ domain: "light", services: {} }],
    ]);
    expect(client.invalidateCache("services")).toBe(1);
    await expect(client.getServices()).resolves.toEqual([{ domain: "switch", services: {} }]);
    expect(request).toHaveBeenCalledTimes(2);
    await client.close();
  });
});

describe("mock Home Assistant HTTP integration", () => {
  it("drives states, service calls, editor CRUD, and core config validation", async () => {
    editorConfigs.set("morning", { id: "morning", alias: "Morning", triggers: [], actions: [] });
    const websocket = fakeWebsocket();
    const client = new HomeAssistantClient(
      { url: baseUrl, token: "integration-token" },
      { websocket },
    );
    const editor = new HomeAssistantEditorRestAdapter(client);

    try {
      await expect(client.getStates()).resolves.toMatchObject([
        { entity_id: "light.kitchen", state: "off" },
      ]);
      await expect(
        client.callService(
          "light",
          "turn_on",
          { entity_id: "light.kitchen" },
          {
            returnResponse: true,
          },
        ),
      ).resolves.toMatchObject({ service_response: { accepted: true } });
      expect(serviceCalls).toHaveLength(1);
      expect(serviceCalls[0]).toMatchObject({
        method: "POST",
        url: "/api/services/light/turn_on?return_response",
        body: { entity_id: "light.kitchen" },
        headers: { authorization: "Bearer integration-token" },
      });

      await expect(editor.get("automation", "morning")).resolves.toMatchObject({
        alias: "Morning",
      });
      await editor.post("automation", "morning", {
        id: "morning",
        alias: "Updated",
        triggers: [],
        actions: [],
      });
      await expect(editor.get("automation", "morning")).resolves.toMatchObject({
        alias: "Updated",
      });
      await expect(client.checkConfig()).resolves.toEqual({ result: "valid", errors: null });
      await editor.delete("automation", "morning");
      await expect(editor.get("automation", "morning")).rejects.toMatchObject({
        code: "HA_NOT_FOUND",
      });
    } finally {
      await client.close();
    }
  });
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://homeassistant.test");
  if (requestUrl.pathname === "/slow") return;
  if (requestUrl.pathname === "/invalid-json") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{not-json");
    return;
  }
  if (requestUrl.pathname === "/large") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain");
    response.end("x".repeat(1_024));
    return;
  }
  const statusMatch = /^\/status\/(\d+)$/.exec(requestUrl.pathname);
  if (statusMatch !== null) {
    const status = Number(statusMatch[1]);
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    if (status === 429) response.setHeader("retry-after", "7");
    response.end(JSON.stringify({ message: `status ${status}` }));
    return;
  }
  if (requestUrl.pathname === "/inspect") {
    sendJson(response, {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await readJsonBody(request),
    });
    return;
  }
  if (requestUrl.pathname === "/path-probe") {
    sendJson(response, { url: request.url });
    return;
  }
  if (requestUrl.pathname === "/api/states") {
    sendJson(response, [
      {
        entity_id: "light.kitchen",
        state: "off",
        attributes: { friendly_name: "Kitchen" },
        last_changed: "2026-08-20T00:00:00Z",
        last_updated: "2026-08-20T00:00:00Z",
        context: {},
      },
    ]);
    return;
  }
  if (requestUrl.pathname === "/api/services/light/turn_on") {
    serviceCalls.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await readJsonBody(request),
    });
    sendJson(response, {
      changed_states: [],
      service_response: { accepted: true },
    });
    return;
  }
  if (requestUrl.pathname === "/api/config/core/check_config") {
    sendJson(response, { result: "valid", errors: null });
    return;
  }
  const editorMatch = /^\/api\/config\/automation\/config\/([^/]+)$/.exec(requestUrl.pathname);
  if (editorMatch !== null) {
    const id = decodeURIComponent(editorMatch[1]!);
    if (request.method === "GET") {
      const config = editorConfigs.get(id);
      if (config === undefined) {
        response.statusCode = 404;
        sendJson(response, { message: "not found" });
      } else {
        sendJson(response, config);
      }
      return;
    }
    if (request.method === "POST") {
      editorConfigs.set(id, (await readJsonBody(request)) as Record<string, unknown>);
      sendJson(response, { result: "ok" });
      return;
    }
    if (request.method === "DELETE") {
      editorConfigs.delete(id);
      sendJson(response, { result: "ok" });
      return;
    }
  }
  response.statusCode = 404;
  sendJson(response, { message: "unknown route" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function fakeWebsocket(): HomeAssistantWebSocketClient {
  return {
    connected: false,
    close: vi.fn(async () => undefined),
  } as unknown as HomeAssistantWebSocketClient;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
