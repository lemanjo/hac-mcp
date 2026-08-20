import { z } from "zod/v4";

export const pageFields = {
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum results to return"),
  offset: z.number().int().min(0).default(0).describe("Zero-based result offset"),
};

export const confirmationField = {
  confirm: z
    .boolean()
    .default(false)
    .describe("Explicitly approve this operation when deployment policy requires confirmation"),
};

export const dryRunField = {
  dry_run: z
    .boolean()
    .default(false)
    .describe("Validate and return the proposed diff without changing Home Assistant"),
};

export const entityId = z
  .string()
  .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/)
  .describe("Home Assistant entity ID, including domain");

export const jsonObject = z.record(z.string(), z.unknown());
export const resourceId = z.string().min(1).max(255).describe("Home Assistant resource config ID");
export const opaqueId = z.string().min(1).max(255);

export const timeRangeFields = {
  start_time: z.iso.datetime({ offset: true }).describe("Inclusive ISO 8601 start time"),
  end_time: z.iso.datetime({ offset: true }).optional().describe("Exclusive ISO 8601 end time"),
};
