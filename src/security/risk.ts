import { AppError } from "../shared/errors.js";
import type { Mode, Risk } from "../shared/types.js";
import type { Settings } from "../config/settings.js";

const allowedByMode: Record<Mode, ReadonlySet<Risk>> = {
  read_only: new Set(["READ"]),
  control: new Set(["READ", "CONTROL"]),
  admin: new Set(["READ", "CONTROL", "CONFIG", "HIGH_IMPACT"]),
};

export interface AuthorizationRequest {
  risk: Risk;
  operation: string;
  confirm?: boolean;
  domain?: string;
  entityId?: string;
  entityIds?: string[];
}

export class PermissionPolicy {
  constructor(private readonly settings: Settings) {}

  authorize(request: AuthorizationRequest): void {
    if (!allowedByMode[this.settings.mcp.mode].has(request.risk)) {
      throw new AppError(
        "OPERATION_NOT_PERMITTED",
        `${request.operation} is disabled in MCP mode`,
        {
          details: { mode: this.settings.mcp.mode, required_risk: request.risk },
        },
      );
    }

    const entityIds =
      request.entityIds ?? (request.entityId === undefined ? [] : [request.entityId]);
    const domains = new Set([
      ...(request.domain === undefined ? [] : [request.domain]),
      ...entityIds.map((entityId) => entityId.split(".", 1)[0] ?? ""),
    ]);
    const deniedDomain = [...domains].find(
      (domain) => this.settings.permissions.sensitiveDomains[domain] === "deny",
    );
    if (deniedDomain !== undefined) {
      throw new AppError(
        "SENSITIVE_OPERATION_DENIED",
        `${deniedDomain} operations are denied by policy`,
      );
    }

    const sensitiveCover = entityIds.some(
      (entityId) =>
        entityId.startsWith("cover.") &&
        this.settings.permissions.sensitiveCovers.some((term) =>
          entityId.toLowerCase().includes(term.toLowerCase()),
        ),
    );
    const requiresConfirmation =
      this.settings.permissions.requireConfirmationFor.includes(
        request.risk as "CONTROL" | "CONFIG" | "HIGH_IMPACT",
      ) ||
      [...domains].some(
        (domain) => this.settings.permissions.sensitiveDomains[domain] === "confirm",
      ) ||
      sensitiveCover;

    if (requiresConfirmation && request.confirm !== true) {
      throw new AppError(
        "CONFIRMATION_REQUIRED",
        `${request.operation} requires explicit confirmation`,
        {
          details: {
            risk: request.risk,
            domains: [...domains].sort(),
            entity_ids: entityIds,
            retry_with: { confirm: true },
          },
        },
      );
    }
  }
}

export const RISK_METADATA: Record<Risk, Record<string, boolean | string>> = {
  READ: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  CONTROL: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  CONFIG: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  HIGH_IMPACT: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};
