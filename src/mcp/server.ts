import { createHash, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { NextFunction, Request, Response } from "express";

import type { Application } from "../app.js";
import { registerTools } from "./tools/index.js";

export interface RunningServer {
  close(): Promise<void>;
}

export function createServer(app: Application): McpServer {
  const server = new McpServer({
    name: "home-assistant-admin-mcp",
    version: "0.1.0",
  });
  registerTools(server, app);
  return server;
}

export async function startServer(app: Application): Promise<RunningServer> {
  if (app.settings.mcp.transport === "stdio") return startStdio(app);
  return startHttp(app);
}

function startStdio(app: Application): RunningServer {
  const handle: StdioServerHandle = serveStdio(() => createServer(app), {
    onerror: (error) => console.error("MCP stdio error", error),
  });
  return {
    close: async () => {
      await handle.close();
      await app.close();
    },
  };
}

async function startHttp(appContext: Application): Promise<RunningServer> {
  const settings = appContext.settings.mcp;
  const handler = createMcpHandler(() => createServer(appContext), {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => console.error("MCP handler error", error),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("MCP HTTP adapter error", error),
  });
  const expressApp = createMcpExpressApp({
    host: settings.host,
    allowedHosts: settings.allowedHosts,
    allowedOrigins: settings.allowedOrigins,
    jsonLimit: `${settings.maxRequestBytes}b`,
  });

  expressApp.disable("x-powered-by");
  expressApp.get("/livez", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  expressApp.get("/readyz", async (_request, response) => {
    try {
      await appContext.client.getInfo();
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });
  expressApp.all(
    "/mcp",
    staticBearerAuth(settings.authToken!),
    (request, response) => void nodeHandler(request, response, request.body),
  );

  const httpServer = await listen(expressApp, settings.port, settings.host);
  console.error(
    `Home Assistant Admin MCP listening on http://${settings.host}:${settings.port}/mcp`,
  );
  return {
    close: async () => {
      await closeHttp(httpServer);
      await handler.close();
      await appContext.close();
    },
  };
}

export function staticBearerAuth(expectedToken: string) {
  const expected = createHash("sha256").update(expectedToken).digest();
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = request.header("authorization");
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1] ?? "";
    const actual = createHash("sha256").update(token).digest();
    if (token.length === 0 || !timingSafeEqual(actual, expected)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="home-assistant-admin-mcp"');
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function listen(
  expressApp: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
