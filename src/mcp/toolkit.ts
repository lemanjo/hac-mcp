import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod/v4";

import type { Application } from "../app.js";
import { errorResult } from "../shared/errors.js";
import { asJson, type OperationMeta, type Risk } from "../shared/types.js";

export interface ToolDefinition<TSchema extends z.ZodType<Record<string, unknown>>> {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  resolveRisk?: (input: z.infer<TSchema>) => Risk;
  schema: TSchema;
  source?: OperationMeta["source"];
  stability?: OperationMeta["api_stability"];
  handler: (input: z.infer<TSchema>) => unknown;
  authorize?: (input: z.infer<TSchema>) => {
    domain?: string;
    entityId?: string;
    entityIds?: string[];
  };
  destructive?: boolean;
  idempotent?: boolean;
  metadata?: Partial<OperationMeta>;
}

export class ToolRegistrar {
  constructor(
    private readonly server: McpServer,
    private readonly app: Application,
  ) {}

  register<TSchema extends z.ZodType<Record<string, unknown>>>(
    definition: ToolDefinition<TSchema>,
  ): void {
    this.server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: `${definition.description} Risk: ${definition.risk}${definition.resolveRisk === undefined ? "." : " minimum; arguments may escalate to CONFIG or HIGH_IMPACT."}`,
        inputSchema: definition.schema,
        annotations: {
          readOnlyHint: definition.risk === "READ",
          destructiveHint: definition.destructive ?? definition.risk === "HIGH_IMPACT",
          idempotentHint: definition.idempotent ?? definition.risk === "READ",
          openWorldHint: definition.source !== "filesystem" && definition.source !== "derived",
        },
        _meta: {
          "com.home-assistant-admin-mcp/risk": definition.risk,
          "com.home-assistant-admin-mcp/dynamic-risk": definition.resolveRisk !== undefined,
          "com.home-assistant-admin-mcp/mode-required": modeForRisk(definition.risk),
          "com.home-assistant-admin-mcp/source": definition.source ?? "derived",
        },
      },
      (async (rawInput: Record<string, unknown>) => {
        const input = rawInput as z.infer<TSchema>;
        let effectiveRisk = definition.risk;
        try {
          effectiveRisk = definition.resolveRisk?.(input) ?? definition.risk;
          const authorization = definition.authorize?.(input) ?? {};
          this.app.policy.authorize({
            risk: effectiveRisk,
            operation: definition.name,
            confirm: input.confirm === true,
            ...authorization,
          });
          const data = asJson(await definition.handler(input));
          const result = {
            success: true as const,
            data,
            meta: {
              risk: effectiveRisk,
              ...(definition.source === undefined ? {} : { source: definition.source }),
              ...(definition.stability === undefined
                ? {}
                : { api_stability: definition.stability }),
              ...definition.metadata,
            },
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const result = errorResult(error, effectiveRisk);
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      }) as any,
    );
  }
}

function modeForRisk(risk: Risk): "read_only" | "control" | "admin" {
  if (risk === "READ") return "read_only";
  if (risk === "CONTROL") return "control";
  return "admin";
}
