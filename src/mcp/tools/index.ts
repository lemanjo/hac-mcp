import type { McpServer } from "@modelcontextprotocol/server";

import type { Application } from "../../app.js";
import { ToolRegistrar } from "../toolkit.js";
import { registerControlTools } from "./control.js";
import { registerAdminTools } from "./admin.js";
import { registerConfigurationTools } from "./configuration.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerRuntimeTools } from "./runtime.js";

export {
  registerAdminTools,
  registerConfigurationTools,
  registerControlTools,
  registerDiagnosticsTools,
  registerDiscoveryTools,
  registerRuntimeTools,
};

export function registerTools(server: McpServer, app: Application): void {
  const registrar = new ToolRegistrar(server, app);
  registerDiscoveryTools(registrar, app);
  registerRuntimeTools(registrar, app);
  registerControlTools(registrar, app);
  registerAdminTools(registrar, app);
  registerConfigurationTools(registrar, app);
  registerDiagnosticsTools(registrar, app);
}
