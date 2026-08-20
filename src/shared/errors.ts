import type { JsonValue, Risk } from "./types.js";

export class AppError extends Error {
  readonly code: string;
  readonly details?: JsonValue;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: { details?: JsonValue; retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function errorResult(error: unknown, risk: Risk) {
  const normalized =
    error instanceof AppError
      ? error
      : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unknown error", {
          retryable: false,
        });
  return {
    success: false as const,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      retryable: normalized.retryable,
    },
    meta: { risk },
  };
}
