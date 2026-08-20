import http from "node:http";
import https from "node:https";

import { AppError } from "../shared/errors.js";
import type { JsonValue } from "../shared/types.js";

export type RestResponseType = "auto" | "json" | "text";

export interface RestClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  verifyTls?: boolean;
  maxResponseBytes?: number;
}

export interface RestRequestOptions {
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  responseType?: RestResponseType;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class HomeAssistantRestClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly httpAgent = new http.Agent({ keepAlive: true });
  private readonly httpsAgent: https.Agent;

  constructor(options: RestClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    if (options.token.length === 0) {
      throw new AppError("HA_AUTH_REQUIRED", "A Home Assistant access token is required");
    }
    this.token = options.token;
    this.timeoutMs = positiveNumber(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "REST timeout");
    this.maxResponseBytes = positiveNumber(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maximum REST response size",
    );
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: options.verifyTls ?? true,
    });
  }

  async request<T = unknown>(path: string, options: RestRequestOptions = {}): Promise<T> {
    const url = this.resolvePath(path);
    const method = (options.method ?? "GET").toUpperCase();
    const timeoutMs = positiveNumber(options.timeoutMs ?? this.timeoutMs, "REST timeout");
    const responseType = options.responseType ?? "auto";
    const headers: Record<string, string> = { ...options.headers };
    setHeaderIfMissing(
      headers,
      "Accept",
      responseType === "text" ? "text/plain, */*" : "application/json",
    );
    setHeader(headers, "Authorization", `Bearer ${this.token}`);

    let payload: string | Uint8Array | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof Uint8Array) {
        payload = options.body;
      } else {
        try {
          payload = JSON.stringify(options.body);
        } catch (error) {
          throw new AppError("HA_INVALID_REQUEST", "REST request body is not JSON serializable", {
            details: { method, path: pathForDetails(url) },
            cause: error,
          });
        }
        if (payload === undefined) {
          throw new AppError("HA_INVALID_REQUEST", "REST request body is not JSON serializable", {
            details: { method, path: pathForDetails(url) },
          });
        }
        setHeaderIfMissing(headers, "Content-Type", "application/json");
      }
      setHeader(headers, "Content-Length", String(Buffer.byteLength(payload)));
    }

    if (options.signal?.aborted === true) {
      throw abortedError(method, url);
    }

    let response: RawResponse;
    try {
      response = await this.execute(url, method, headers, payload, timeoutMs, options.signal);
    } catch (error) {
      throw mapNetworkError(error, method, url);
    }
    return this.parseResponse<T>(response, method, url, responseType);
  }

  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private resolvePath(path: string): URL {
    if (path.length === 0) {
      throw new AppError("HA_INVALID_PATH", "Home Assistant REST path cannot be empty");
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
      throw new AppError(
        "HA_INVALID_PATH",
        "REST requests must use a Home Assistant-relative path",
        {
          details: { path },
        },
      );
    }
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return new URL(normalized, this.baseUrl);
  }

  private execute(
    url: URL,
    method: string,
    headers: Readonly<Record<string, string>>,
    payload: string | Uint8Array | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener: (() => void) | undefined;

      const cleanup = (): void => {
        clearTimeout(timer);
        if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
      };
      const resolveOnce = (value: RawResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        url,
        {
          method,
          headers,
          agent: url.protocol === "https:" ? this.httpsAgent : this.httpAgent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;

          response.on("data", (chunk: Buffer | string) => {
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            receivedBytes += buffer.length;
            if (receivedBytes > this.maxResponseBytes) {
              rejectOnce(
                new AppError("HA_RESPONSE_TOO_LARGE", "Home Assistant REST response is too large", {
                  details: {
                    method,
                    path: pathForDetails(url),
                    max_bytes: this.maxResponseBytes,
                  },
                }),
              );
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            resolveOnce({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("aborted", () => {
            rejectOnce(
              new AppError("HA_CONNECTION_LOST", "Home Assistant closed the REST response early", {
                details: { method, path: pathForDetails(url) },
                retryable: true,
              }),
            );
          });
          response.on("error", (error) => rejectOnce(mapNetworkError(error, method, url)));
        },
      );

      request.on("error", (error) => rejectOnce(mapNetworkError(error, method, url)));
      const timer = setTimeout(() => {
        rejectOnce(
          new AppError(
            "HA_REQUEST_TIMEOUT",
            `Home Assistant did not respond within ${timeoutMs}ms`,
            {
              details: { method, path: pathForDetails(url), timeout_ms: timeoutMs },
              retryable: true,
            },
          ),
        );
        request.destroy();
      }, timeoutMs);
      timer.unref();

      if (signal !== undefined) {
        abortListener = () => {
          rejectOnce(abortedError(method, url));
          request.destroy();
        };
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }

      request.end(payload);
    });
  }

  private parseResponse<T>(
    response: RawResponse,
    method: string,
    url: URL,
    responseType: RestResponseType,
  ): T {
    const contentType = headerValue(response.headers["content-type"]);
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpError(response, method, url, contentType);
    }
    if (response.status === 204 || response.body.length === 0) return undefined as T;

    const shouldParseJson =
      responseType === "json" || (responseType === "auto" && isJsonContentType(contentType));
    if (!shouldParseJson) return response.body as T;

    try {
      return JSON.parse(response.body) as T;
    } catch (error) {
      throw new AppError("HA_INVALID_RESPONSE", "Home Assistant returned invalid JSON", {
        details: {
          method,
          path: pathForDetails(url),
          content_type: contentType ?? null,
          response_excerpt: response.body.slice(0, 500),
        },
        retryable: true,
        cause: error,
      });
    }
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL is invalid", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL must not contain credentials");
  }
  url.search = "";
  url.hash = "";
  return url;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError("HA_INVALID_CONFIGURATION", `${label} must be a positive number`);
  }
  return value;
}

function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string): void {
  if (!Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) {
    headers[name] = value;
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
  headers[name] = value;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && /(^|\/)json(?:\s*;|$)|\+json(?:\s*;|$)/i.test(contentType);
}

function pathForDetails(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function abortedError(method: string, url: URL): AppError {
  return new AppError("HA_REQUEST_ABORTED", "Home Assistant REST request was aborted", {
    details: { method, path: pathForDetails(url) },
  });
}

function mapNetworkError(error: unknown, method: string, url: URL): AppError {
  if (error instanceof AppError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const details: Record<string, JsonValue> = {
    method,
    path: pathForDetails(url),
    network_code: code ?? null,
  };
  if (code !== undefined && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return new AppError("HA_TLS_ERROR", "TLS validation failed for Home Assistant", {
      details,
      cause: error,
    });
  }
  if (
    code !== undefined &&
    ["ERR_HTTP_INVALID_HEADER_VALUE", "ERR_INVALID_CHAR", "ERR_INVALID_HTTP_TOKEN"].includes(code)
  ) {
    return new AppError("HA_INVALID_REQUEST", "Home Assistant REST request headers are invalid", {
      details,
      cause: error,
    });
  }
  if (
    code !== undefined &&
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(code)
  ) {
    return new AppError(
      "HA_UNREACHABLE",
      "Home Assistant is unreachable; verify its URL and availability",
      {
        details,
        retryable: true,
        cause: error,
      },
    );
  }
  return new AppError("HA_NETWORK_ERROR", "Home Assistant REST request failed", {
    details,
    retryable: true,
    cause: error,
  });
}

function mapHttpError(
  response: RawResponse,
  method: string,
  url: URL,
  contentType: string | undefined,
): AppError {
  const status = response.status;
  const retryAfter = headerValue(response.headers["retry-after"]);
  let responseDetail: JsonValue = response.body.slice(0, 2_000);
  if (response.body.length === 0) {
    responseDetail = null;
  } else if (isJsonContentType(contentType)) {
    try {
      responseDetail = JSON.parse(response.body) as JsonValue;
    } catch {
      // Keep the text excerpt when an error response claims to be JSON but is malformed.
    }
  }
  const details: Record<string, JsonValue> = {
    method,
    path: pathForDetails(url),
    status,
    response: responseDetail,
    retry_after: retryAfter ?? null,
  };

  if (status === 401) {
    return new AppError("HA_AUTH_FAILED", "Home Assistant rejected the access token", {
      details,
      status,
    });
  }
  if (status === 403) {
    return new AppError(
      "HA_PERMISSION_DENIED",
      "The Home Assistant user cannot perform this request",
      {
        details,
        status,
      },
    );
  }
  if (status === 404) {
    return new AppError("HA_NOT_FOUND", "The requested Home Assistant resource was not found", {
      details,
      status,
    });
  }
  if (status === 400 || status === 422) {
    return new AppError("HA_BAD_REQUEST", "Home Assistant rejected the request data", {
      details,
      status,
    });
  }
  if (status === 409) {
    return new AppError("HA_CONFLICT", "The Home Assistant request conflicts with current state", {
      details,
      status,
    });
  }
  if (status === 429) {
    return new AppError("HA_RATE_LIMITED", "Home Assistant is rate limiting requests", {
      details,
      retryable: true,
      status,
    });
  }
  if (status >= 500) {
    return new AppError(
      "HA_UNAVAILABLE",
      "Home Assistant encountered an error while handling the request",
      {
        details,
        retryable: true,
        status,
      },
    );
  }
  return new AppError("HA_HTTP_ERROR", `Home Assistant REST request failed with status ${status}`, {
    details,
    retryable: status === 408,
    status,
  });
}
