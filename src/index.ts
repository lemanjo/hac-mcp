import { Application } from "./app.js";
import { loadSettings } from "./config/settings.js";
import { startServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const settings = await loadSettings();
  const app = new Application(settings);
  const server = await startServer(app);
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down`);
    try {
      await server.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Home Assistant Admin MCP failed to start", error);
  process.exitCode = 1;
});
