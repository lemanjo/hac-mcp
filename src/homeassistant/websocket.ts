import WebSocket, { type RawData } from "ws";

import { AppError } from "../shared/errors.js";
import type { JsonValue } from "../shared/types.js";

export interface WebSocketClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  verifyTls?: boolean;
  maxPendingCommands?: number;
  maxSubscriptions?: number;
  maxCollectedEvents?: number;
  maxEventCollectionMs?: number;
  maxPayloadBytes?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onError?: (error: unknown) => void;
}

export interface WebSocketCommand {
  type: string;
  [key: string]: unknown;
}

export interface WebSocketCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HomeAssistantEvent<T = Record<string, unknown>> {
  event_type: string;
  data: T;
  origin: string;
  time_fired: string;
  context: Record<string, unknown>;
}

export type EventHandler<T = Record<string, unknown>> = (
  event: HomeAssistantEvent<T>,
) => void | Promise<void>;

export type SubscriptionHandler<T = unknown> = (event: T) => void | Promise<void>;

export interface CollectEventsOptions {
  eventType?: string;
  count?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CollectSubscriptionOptions<T> {
  timeoutMs?: number;
  maxEvents?: number;
  signal?: AbortSignal;
  until?: (event: T, events: readonly T[]) => boolean;
}

interface PendingCommand {
  commandType: string;
  resolve: (value: unknown) => void;
  reject: (error: AppError) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

interface Subscription {
  logicalId: number;
  command: WebSocketCommand;
  handler: SubscriptionHandler;
  wireId: number | undefined;
  activationPromise: Promise<void> | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING = 1_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_MAX_COLLECTED_EVENTS = 1_000;
const DEFAULT_MAX_COLLECTION_MS = 5 * 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_RECONNECT_MIN_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

/** A single persistent Home Assistant WebSocket connection shared by all callers. */
export class HomeAssistantWebSocketClient {
  private readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly verifyTls: boolean;
  private readonly maxPendingCommands: number;
  private readonly maxSubscriptions: number;
  private readonly maxCollectedEvents: number;
  private readonly maxEventCollectionMs: number;
  private readonly maxPayloadBytes: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly wireSubscriptions = new Map<number, number>();

  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private authenticationError: AppError | undefined;
  private ready = false;
  private closing = false;
  private maintainConnection = false;
  private nextId = 1;
  private nextLogicalSubscriptionId = 1;
  private reconnectAttempt = 0;
  private connectedAt: number | undefined;

  constructor(options: WebSocketClientOptions) {
    this.url = websocketUrl(options.baseUrl);
    if (options.token.length === 0) {
      throw new AppError("HA_AUTH_REQUIRED", "A Home Assistant access token is required");
    }
    this.token = options.token;
    this.timeoutMs = positiveNumber(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "WebSocket timeout");
    this.verifyTls = options.verifyTls ?? true;
    this.maxPendingCommands = positiveInteger(
      options.maxPendingCommands ?? DEFAULT_MAX_PENDING,
      "maximum pending WebSocket commands",
    );
    this.maxSubscriptions = positiveInteger(
      options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
      "maximum WebSocket subscriptions",
    );
    this.maxCollectedEvents = positiveInteger(
      options.maxCollectedEvents ?? DEFAULT_MAX_COLLECTED_EVENTS,
      "maximum collected events",
    );
    this.maxEventCollectionMs = positiveNumber(
      options.maxEventCollectionMs ?? DEFAULT_MAX_COLLECTION_MS,
      "maximum event collection duration",
    );
    this.maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "maximum WebSocket payload size",
    );
    this.reconnectMinDelayMs = positiveNumber(
      options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS,
      "minimum reconnect delay",
    );
    this.reconnectMaxDelayMs = positiveNumber(
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      "maximum reconnect delay",
    );
    if (this.reconnectMaxDelayMs < this.reconnectMinDelayMs) {
      throw new AppError(
        "HA_INVALID_CONFIGURATION",
        "Maximum reconnect delay must not be less than minimum reconnect delay",
      );
    }
    this.onError = options.onError;
  }

  get connected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.closing) {
      throw new AppError("HA_WS_CLOSED", "Home Assistant WebSocket client is closed");
    }
    if (this.authenticationError !== undefined) throw this.authenticationError;
    this.maintainConnection = true;
    if (this.connected) return;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.connectPromise === undefined) {
      const attempt = this.openSocket();
      this.connectPromise = attempt;
      const clearAttempt = (): void => {
        if (this.connectPromise === attempt) this.connectPromise = undefined;
      };
      void attempt.then(clearAttempt, clearAttempt);
    }
    await this.connectPromise;
  }

  async command<T = unknown>(
    command: WebSocketCommand,
    options: WebSocketCommandOptions = {},
  ): Promise<T> {
    validateCommand(command);
    await this.connect();
    const response = await this.sendReadyCommand<T>(command, options);
    return response.result;
  }

  async subscribeEvents<T = Record<string, unknown>>(
    eventType: string | undefined,
    handler: EventHandler<T>,
  ): Promise<() => Promise<void>> {
    const command: WebSocketCommand = { type: "subscribe_events" };
    if (eventType !== undefined) command.event_type = eventType;
    return this.subscribeCommand(command, (event) => {
      if (!isObject(event)) return;
      return handler(event as unknown as HomeAssistantEvent<T>);
    });
  }

  async subscribeCommand<T = unknown>(
    command: WebSocketCommand,
    handler: SubscriptionHandler<T>,
  ): Promise<() => Promise<void>> {
    validateCommand(command);
    if (this.subscriptions.size >= this.maxSubscriptions) {
      throw new AppError("HA_WS_SUBSCRIPTION_LIMIT", "WebSocket subscription limit reached", {
        details: { max_subscriptions: this.maxSubscriptions },
      });
    }

    const logicalId = this.nextLogicalSubscriptionId++;
    const subscription: Subscription = {
      logicalId,
      command: { ...command },
      handler: handler as SubscriptionHandler,
      wireId: undefined,
      activationPromise: undefined,
    };
    this.subscriptions.set(logicalId, subscription);

    try {
      await this.connect();
      await this.activateSubscription(subscription);
    } catch (error) {
      if (this.subscriptions.get(logicalId) === subscription) this.subscriptions.delete(logicalId);
      throw error;
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;
      await this.removeSubscription(logicalId);
    };
  }

  async collectSubscription<T = unknown>(
    command: WebSocketCommand,
    options: CollectSubscriptionOptions<T> = {},
  ): Promise<T[]> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxEvents = options.maxEvents ?? this.maxCollectedEvents;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > this.maxCollectedEvents) {
      throw new AppError(
        "HA_WS_COLLECTION_LIMIT",
        `Subscription event limit must be between 1 and ${this.maxCollectedEvents}`,
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.maxEventCollectionMs) {
      throw new AppError(
        "HA_WS_COLLECTION_LIMIT",
        `Subscription duration must be between 1ms and ${this.maxEventCollectionMs}ms`,
      );
    }
    if (options.signal?.aborted === true) throw collectionAbortedError();

    const events: T[] = [];
    let complete!: () => void;
    let fail!: (error: AppError) => void;
    let finished = false;
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      complete();
    };
    const unsubscribe = await this.subscribeCommand<T>(command, (event) => {
      if (finished) return;
      events.push(event);
      if (events.length >= maxEvents || options.until?.(event, events) === true) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    const abortListener = (): void => {
      if (finished) return;
      finished = true;
      fail(collectionAbortedError());
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    try {
      await completion;
      return events;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortListener);
      await unsubscribe().catch((error) => this.reportError(error));
    }
  }

  async collectEvents<T = Record<string, unknown>>(
    options: CollectEventsOptions = {},
  ): Promise<Array<HomeAssistantEvent<T>>> {
    const count = options.count ?? 1;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(count) || count <= 0 || count > this.maxCollectedEvents) {
      throw new AppError(
        "HA_WS_COLLECTION_LIMIT",
        `Event count must be between 1 and ${this.maxCollectedEvents}`,
        { details: { requested_count: count, max_events: this.maxCollectedEvents } },
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.maxEventCollectionMs) {
      throw new AppError(
        "HA_WS_COLLECTION_LIMIT",
        `Event collection duration must be between 1ms and ${this.maxEventCollectionMs}ms`,
        { details: { requested_timeout_ms: timeoutMs, max_timeout_ms: this.maxEventCollectionMs } },
      );
    }
    const signal = options.signal;
    if (isSignalAborted(signal)) throw collectionAbortedError();

    const events: Array<HomeAssistantEvent<T>> = [];
    let resolveCompletion!: (value: Array<HomeAssistantEvent<T>>) => void;
    let rejectCompletion!: (error: AppError) => void;
    let finished = false;
    const completion = new Promise<Array<HomeAssistantEvent<T>>>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolveCompletion(events);
    };

    const unsubscribe = await this.subscribeEvents<T>(options.eventType, (event) => {
      if (finished) return;
      events.push(event);
      if (events.length >= count) finish();
    });

    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    const abortListener = (): void => {
      if (finished) return;
      finished = true;
      rejectCompletion(collectionAbortedError());
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    if (isSignalAborted(signal)) abortListener();

    try {
      return await completion;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      try {
        await unsubscribe();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) this.closePromise = this.performClose();
    return this.closePromise;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url, {
          handshakeTimeout: this.timeoutMs,
          maxPayload: this.maxPayloadBytes,
          perMessageDeflate: false,
          rejectUnauthorized: this.verifyTls,
        });
      } catch (error) {
        reject(mapSocketError(error, this.url));
        return;
      }

      this.socket = socket;
      this.ready = false;
      let settled = false;
      let authenticated = false;
      let authSent = false;
      const authTimer = setTimeout(() => {
        fail(
          new AppError(
            "HA_WS_TIMEOUT",
            `Home Assistant WebSocket did not authenticate within ${this.timeoutMs}ms`,
            {
              details: { timeout_ms: this.timeoutMs },
              retryable: true,
            },
          ),
        );
      }, this.timeoutMs);
      authTimer.unref();

      const rejectConnection = (error: AppError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        reject(error);
      };
      const fail = (error: AppError, fatalAuthentication = false): void => {
        if (fatalAuthentication) {
          this.authenticationError = error;
        }
        rejectConnection(error);
        this.handleDisconnect(socket, 1006, error.message);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      };

      socket.on("message", (data: RawData) => {
        let message: Record<string, unknown>;
        try {
          message = parseMessage(data);
        } catch (error) {
          const protocolError =
            error instanceof AppError
              ? error
              : new AppError(
                  "HA_WS_PROTOCOL_ERROR",
                  "Invalid WebSocket message from Home Assistant",
                  {
                    retryable: true,
                    cause: error,
                  },
                );
          if (!authenticated) {
            fail(protocolError);
          } else {
            this.reportError(protocolError);
            socket.close(1002, "Invalid Home Assistant message");
          }
          return;
        }

        const type = typeof message.type === "string" ? message.type : "";
        if (!authenticated) {
          if (type === "auth_required") {
            if (authSent) {
              fail(
                new AppError(
                  "HA_WS_PROTOCOL_ERROR",
                  "Home Assistant repeated its authentication request",
                ),
              );
              return;
            }
            authSent = true;
            try {
              socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
            } catch (error) {
              fail(mapSocketError(error, this.url));
            }
            return;
          }
          if (type === "auth_invalid") {
            const serverMessage = typeof message.message === "string" ? `: ${message.message}` : "";
            fail(
              new AppError(
                "HA_WS_AUTH_FAILED",
                `Home Assistant rejected WebSocket authentication${serverMessage}`,
              ),
              true,
            );
            return;
          }
          if (type === "auth_ok" && authSent) {
            authenticated = true;
            settled = true;
            clearTimeout(authTimer);
            this.ready = true;
            this.connectedAt = Date.now();
            resolve();
            queueMicrotask(() => {
              void this.restoreSubscriptions(socket);
            });
            return;
          }
          fail(
            new AppError(
              "HA_WS_PROTOCOL_ERROR",
              "Unexpected authentication message from Home Assistant",
              {
                details: { message_type: type || null },
                retryable: true,
              },
            ),
          );
          return;
        }

        this.handleServerMessage(socket, message);
      });

      socket.on("error", (error) => {
        if (!authenticated) fail(mapSocketError(error, this.url));
      });
      socket.on("close", (code, reason) => {
        clearTimeout(authTimer);
        if (!settled) {
          rejectConnection(disconnectedError(code, reason.toString()));
        }
        this.handleDisconnect(socket, code, reason.toString());
      });
    });
  }

  private handleServerMessage(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket !== this.socket) return;
    const type = typeof message.type === "string" ? message.type : "";
    const id =
      typeof message.id === "number" && Number.isSafeInteger(message.id) ? message.id : undefined;

    if (type === "ping" && id === undefined) {
      try {
        socket.send(JSON.stringify({ type: "pong" }));
      } catch (error) {
        this.reportError(mapSocketError(error, this.url));
      }
      return;
    }
    if (id === undefined) return;

    if (type === "result") {
      if (message.success === true) {
        this.resolvePending(id, message.result);
      } else {
        this.rejectPending(id, commandError(this.pending.get(id)?.commandType, message.error));
      }
      return;
    }
    if (type === "pong") {
      this.resolvePending(id, undefined);
      return;
    }
    if (type === "event") {
      const logicalId = this.wireSubscriptions.get(id);
      const subscription = logicalId === undefined ? undefined : this.subscriptions.get(logicalId);
      if (subscription === undefined || !isObject(message.event)) return;
      try {
        const result = subscription.handler(message.event);
        if (result !== undefined)
          void Promise.resolve(result).catch((error) => this.reportError(error));
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private async sendReadyCommand<T>(
    command: WebSocketCommand,
    options: WebSocketCommandOptions = {},
  ): Promise<{ id: number; result: T }> {
    const socket = this.socket;
    if (!this.ready || socket?.readyState !== WebSocket.OPEN) {
      throw new AppError("HA_WS_DISCONNECTED", "Home Assistant WebSocket is not connected", {
        retryable: true,
      });
    }
    if (this.pending.size >= this.maxPendingCommands) {
      throw new AppError(
        "HA_WS_PENDING_LIMIT",
        "Too many Home Assistant WebSocket commands are pending",
        {
          details: { max_pending_commands: this.maxPendingCommands },
          retryable: true,
        },
      );
    }
    if (options.signal?.aborted === true) throw commandAbortedError(command.type);

    const timeoutMs = positiveNumber(
      options.timeoutMs ?? this.timeoutMs,
      "WebSocket command timeout",
    );
    const id = this.allocateId();
    let payload: string;
    try {
      payload = JSON.stringify({ ...command, id });
      if (typeof payload !== "string") throw new TypeError("Command serialized to no value");
    } catch (error) {
      throw new AppError("HA_WS_INVALID_COMMAND", "WebSocket command is not JSON serializable", {
        details: { command_type: command.type },
        cause: error,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          id,
          new AppError("HA_WS_COMMAND_TIMEOUT", `WebSocket command ${command.type} timed out`, {
            details: { command_type: command.type, timeout_ms: timeoutMs },
            retryable: true,
          }),
        );
      }, timeoutMs);
      timer.unref();

      const pending: PendingCommand = {
        commandType: command.type,
        resolve: (result) => resolve({ id, result: result as T }),
        reject,
        timer,
        signal: options.signal,
        abortListener: undefined,
      };
      if (options.signal !== undefined) {
        pending.abortListener = () => this.rejectPending(id, commandAbortedError(command.type));
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      try {
        socket.send(payload, (error) => {
          if (error != null) this.rejectPending(id, mapSocketError(error, this.url));
        });
      } catch (error) {
        this.rejectPending(id, mapSocketError(error, this.url));
      }
    });
  }

  private async activateSubscription(subscription: Subscription): Promise<void> {
    if (subscription.activationPromise !== undefined) return subscription.activationPromise;
    if (this.subscriptions.get(subscription.logicalId) !== subscription) return;

    const socket = this.socket;
    const activation = (async () => {
      const response = await this.sendReadyCommand<unknown>(subscription.command);
      if (
        this.subscriptions.get(subscription.logicalId) === subscription &&
        this.socket === socket &&
        this.connected
      ) {
        subscription.wireId = response.id;
        this.wireSubscriptions.set(response.id, subscription.logicalId);
      } else if (this.socket === socket && this.connected) {
        try {
          await this.unsubscribeWire(response.id);
        } catch (error) {
          this.reportError(error);
        }
      }
    })();
    subscription.activationPromise = activation;
    try {
      await activation;
    } finally {
      if (subscription.activationPromise === activation) subscription.activationPromise = undefined;
    }
  }

  private async removeSubscription(logicalId: number): Promise<void> {
    const subscription = this.subscriptions.get(logicalId);
    if (subscription === undefined) return;
    this.subscriptions.delete(logicalId);
    const wireId = subscription.wireId;
    subscription.wireId = undefined;
    if (wireId === undefined) return;
    this.wireSubscriptions.delete(wireId);
    if (this.connected) await this.unsubscribeWire(wireId);
  }

  private async unsubscribeWire(wireId: number): Promise<void> {
    await this.sendReadyCommand({ type: "unsubscribe_events", subscription: wireId });
  }

  private async restoreSubscriptions(socket: WebSocket): Promise<void> {
    if (socket !== this.socket || !this.connected) return;
    const results = await Promise.allSettled(
      [...this.subscriptions.values()].map((subscription) =>
        this.activateSubscription(subscription),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") this.reportError(result.reason);
    }
  }

  private resolvePending(id: number, value: unknown): void {
    const pending = this.takePending(id);
    pending?.resolve(value);
  }

  private rejectPending(id: number, error: AppError): void {
    const pending = this.takePending(id);
    pending?.reject(error);
  }

  private takePending(id: number): PendingCommand | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abortListener !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private rejectAllPending(error: AppError): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }

  private handleDisconnect(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.ready = false;
    this.wireSubscriptions.clear();
    for (const subscription of this.subscriptions.values()) {
      subscription.wireId = undefined;
      subscription.activationPromise = undefined;
    }
    this.rejectAllPending(disconnectedError(code, reason));

    if (this.connectedAt !== undefined && Date.now() - this.connectedAt >= 30_000) {
      this.reconnectAttempt = 0;
    }
    this.connectedAt = undefined;
    if (this.maintainConnection && !this.closing && this.authenticationError === undefined) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.closing || !this.maintainConnection) return;
    const exponential = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectMinDelayMs * 2 ** Math.min(this.reconnectAttempt, 20),
    );
    this.reconnectAttempt += 1;
    const delay = Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        this.reportError(error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private allocateId(): number {
    for (
      let attempts = 0;
      attempts <= this.maxPendingCommands + this.maxSubscriptions;
      attempts += 1
    ) {
      const id = this.nextId;
      this.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
      if (!this.pending.has(id) && !this.wireSubscriptions.has(id)) return id;
    }
    throw new AppError("HA_WS_PENDING_LIMIT", "No WebSocket command identifier is available", {
      retryable: true,
    });
  }

  private reportError(error: unknown): void {
    if (this.onError === undefined) return;
    try {
      this.onError(error);
    } catch {
      // Error reporting must not destabilize the connection.
    }
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    this.maintainConnection = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.subscriptions.clear();
    this.wireSubscriptions.clear();
    this.rejectAllPending(
      new AppError("HA_WS_CLOSED", "Home Assistant WebSocket client was closed"),
    );

    const socket = this.socket;
    this.ready = false;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      this.socket = undefined;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          socket.terminate();
          finish();
        },
        Math.min(this.timeoutMs, 2_000),
      );
      timer.unref();
      socket.once("close", finish);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "Client closing");
    });
    if (this.socket === socket) this.socket = undefined;
  }
}

function websocketUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL is invalid", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("HA_INVALID_URL", "Home Assistant URL must not contain credentials");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/websocket";
  url.search = "";
  url.hash = "";
  return url;
}

function parseMessage(data: RawData): Record<string, unknown> {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8")) as unknown;
  } catch (error) {
    throw new AppError("HA_WS_PROTOCOL_ERROR", "Home Assistant sent malformed WebSocket JSON", {
      retryable: true,
      cause: error,
    });
  }
  if (!isObject(value)) {
    throw new AppError(
      "HA_WS_PROTOCOL_ERROR",
      "Home Assistant sent a non-object WebSocket message",
      {
        retryable: true,
      },
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateCommand(command: WebSocketCommand): void {
  if (typeof command.type !== "string" || command.type.length === 0) {
    throw new AppError("HA_WS_INVALID_COMMAND", "WebSocket command type is required");
  }
  if (Object.hasOwn(command, "id")) {
    throw new AppError(
      "HA_WS_INVALID_COMMAND",
      "WebSocket command identifiers are managed by the client",
    );
  }
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError("HA_INVALID_CONFIGURATION", `${label} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("HA_INVALID_CONFIGURATION", `${label} must be a positive integer`);
  }
  return value;
}

function mapSocketError(error: unknown, url: URL): AppError {
  if (error instanceof AppError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const details: Record<string, JsonValue> = {
    endpoint: `${url.protocol}//${url.host}${url.pathname}`,
    network_code: code ?? null,
  };
  if (code !== undefined && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return new AppError(
      "HA_WS_TLS_ERROR",
      "TLS validation failed for the Home Assistant WebSocket",
      {
        details,
        cause: error,
      },
    );
  }
  return new AppError(
    "HA_WS_CONNECTION_FAILED",
    "Could not connect to the Home Assistant WebSocket",
    {
      details,
      retryable: true,
      cause: error,
    },
  );
}

function disconnectedError(code: number, reason: string): AppError {
  return new AppError("HA_WS_DISCONNECTED", "Home Assistant WebSocket connection was lost", {
    details: { close_code: code, close_reason: reason },
    retryable: true,
  });
}

function commandAbortedError(commandType: string): AppError {
  return new AppError("HA_WS_COMMAND_ABORTED", `WebSocket command ${commandType} was aborted`, {
    details: { command_type: commandType },
  });
}

function collectionAbortedError(): AppError {
  return new AppError("HA_WS_COLLECTION_ABORTED", "WebSocket event collection was aborted");
}

function commandError(commandType: string | undefined, value: unknown): AppError {
  const error = isObject(value) ? value : {};
  const serverCode = typeof error.code === "string" ? error.code : "unknown_error";
  const serverMessage = typeof error.message === "string" ? error.message : "Command failed";
  const code =
    serverCode === "unauthorized"
      ? "HA_PERMISSION_DENIED"
      : serverCode === "not_found"
        ? "HA_NOT_FOUND"
        : serverCode === "unknown_command"
          ? "HA_WS_UNSUPPORTED"
          : "HA_WS_COMMAND_FAILED";
  return new AppError(code, `Home Assistant WebSocket command failed: ${serverMessage}`, {
    details: {
      command_type: commandType ?? null,
      server_error: toJsonValue(value),
    },
  });
}

function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
