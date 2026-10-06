/**
 * WebSocket client for O2 Exchange real-time data.
 *
 * Provides real-time streaming of order book depth, orders, trades,
 * balances, and nonce updates via `AsyncGenerator` streams.
 *
 * Features:
 * - Auto-reconnect with exponential backoff and jitter
 * - `AsyncGenerator` streams for each subscription type
 * - Heartbeat/liveness monitoring
 * - Automatic re-subscription after reconnect
 * - Connection lifecycle events for state awareness
 * - Proper cleanup on disconnect with timeouts
 *
 * @module
 */

import type { NetworkConfig } from "./config.js";
import { StreamResyncRequired } from "./errors.js";
import { normaliseHex, sameHex } from "./hex.js";
import { selectionParams } from "./market-selection.js";
import type {
  BalanceUpdate,
  DepthPrecision,
  DepthUpdate,
  Identity,
  MarketSelection,
  NonceUpdate,
  OrderUpdate,
  TradeUpdate,
} from "./models.js";
import {
  parseBalanceUpdate,
  parseDepthUpdate,
  parseNonceUpdate,
  parseOrderUpdate,
  parseTradeUpdate,
} from "./models.js";

// ── Lifecycle events ─────────────────────────────────────────────

/**
 * WebSocket connection lifecycle states.
 */
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "reconnected"
  | "closed";

/**
 * Emitted on WebSocket lifecycle transitions.
 *
 * Subscribe via {@link O2WebSocket.streamLifecycle} to detect reconnects
 * and re-sync state from the REST API — messages during the disconnect
 * window are lost.
 */
export interface ConnectionEvent {
  /** The new connection state. */
  state: ConnectionState;
  /** Reconnect attempt number (0 when not reconnecting). */
  attempt: number;
  /** Human-readable description. */
  message: string;
}

// ── Options ──────────────────────────────────────────────────────

/**
 * Configuration options for {@link O2WebSocket}.
 */
export interface O2WebSocketOptions {
  /** Network endpoint configuration. */
  config: NetworkConfig;
  /** Enable auto-reconnect on disconnect (default: `true`). */
  reconnect?: boolean;
  /** Maximum reconnection attempts (default: `10`). */
  maxReconnectAttempts?: number;
  /** Base delay between reconnects in milliseconds (default: `1000`). */
  reconnectDelayMs?: number;
  /** Liveness check interval in milliseconds (default: `30000`). */
  pingIntervalMs?: number;
  /** Inactivity timeout in milliseconds — triggers reconnect if no message is received (default: `60000`). */
  pongTimeoutMs?: number;
  /**
   * Optional WebSocket factory for custom runtimes/tests.
   * Defaults to `globalThis.WebSocket`.
   */
  webSocketFactory?: (url: string) => WebSocket;
}

type MessageHandler = (data: Record<string, unknown>) => void;

interface SubscriptionConsumer {
  request: Record<string, unknown>;
}

/**
 * WebSocket client for O2 Exchange real-time data streams.
 *
 * Use via {@link O2Client.streamDepth}, {@link O2Client.streamOrders}, etc.
 * for the simplest interface, or create a standalone instance for advanced
 * use cases.
 *
 * @example
 * ```ts
 * import { O2WebSocket, TESTNET } from "@o2exchange/sdk";
 *
 * const ws = new O2WebSocket({ config: TESTNET });
 * await ws.connect();
 * for await (const update of ws.streamDepth(marketId, "10")) {
 *   console.log(update);
 * }
 * ws.disconnect();
 * ```
 */
export class O2WebSocket {
  protected ws: WebSocket | null = null;
  protected readonly url: string;
  protected readonly shouldReconnect: boolean;
  protected readonly maxReconnectAttempts: number;
  protected readonly reconnectDelayMs: number;
  protected readonly pingIntervalMs: number;
  protected readonly pongTimeoutMs: number;
  protected readonly webSocketFactory?: (url: string) => WebSocket;
  protected reconnectAttempts = 0;
  protected reconnecting = false;
  protected pingInterval: ReturnType<typeof setInterval> | null = null;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected connecting: Promise<void> | null = null;
  protected cancelConnect: (() => void) | null = null;
  protected handlers = new Map<string, Set<MessageHandler>>();
  protected connected = false;
  protected closing = false;
  protected terminated = false;
  protected lastMessage = 0;
  protected pendingSubscriptions: Array<Record<string, unknown>> = [];
  private subscriptionConsumers = new Map<string, Set<SubscriptionConsumer>>();

  constructor(options: O2WebSocketOptions) {
    this.url = options.config.wsUrl;
    this.shouldReconnect = options.reconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 60000;
    this.webSocketFactory = options.webSocketFactory;
  }

  /** Connect to the WebSocket server. */
  connect(): Promise<void> {
    this.cancelReconnect();
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.closing = false;
    this.terminated = false;
    let ws: WebSocket;
    try {
      ws = this.webSocketFactory?.(this.url) ?? createDefaultWebSocket(this.url);
    } catch (error) {
      if (this.reconnecting) this.attemptReconnect();
      return Promise.reject(error);
    }
    this.ws = ws;
    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const connection = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    this.connecting = connection;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      this.connecting = null;
      this.cancelConnect = null;
      if (error) {
        rejectConnection(error);
        if (this.reconnecting && !this.closing) this.attemptReconnect();
      } else resolveConnection();
    };
    this.cancelConnect = () => settle(new Error("WebSocket connection cancelled"));

    ws.addEventListener("open", () => {
      if (this.ws !== ws || this.closing) return;
      this.connected = true;
      this.lastMessage = Date.now();
      this.startPingInterval();
      // Re-subscribe after reconnect
      for (const sub of this.pendingSubscriptions) {
        this.send(sub);
      }
      if (this.reconnecting) {
        this.reconnecting = false;
        this.emitLifecycle(
          "reconnected",
          this.reconnectAttempts,
          "Reconnected — consumers should re-sync from REST",
        );
      }
      this.reconnectAttempts = 0;
      settle();
    });

    ws.addEventListener("message", async (event) => {
      if (this.ws !== ws || this.closing) return;
      this.lastMessage = Date.now();
      const text = await messageEventToText(event);
      if (!text || this.ws !== ws || this.closing) return;
      dispatchParsedMessage(text, this.handlers);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.stopPingInterval();
      if (!settled) {
        settle(new Error("WebSocket connection closed before open"));
        return;
      }
      if (!this.closing && this.shouldReconnect) {
        this.reconnecting = true;
        this.emitLifecycle("disconnected", 0, "Connection lost");
        this.attemptReconnect();
      } else if (!this.closing) {
        this.finishStreams("Connection closed");
      }
    });

    ws.addEventListener("error", (event) => {
      if (this.ws !== ws) return;
      if (!this.connected && !settled) {
        const error =
          typeof ErrorEvent !== "undefined" &&
          event instanceof ErrorEvent &&
          event.error instanceof Error
            ? event.error
            : new Error("WebSocket connection failed");
        settle(error);
        this.ws = null;
        ws.close();
      }
    });
    return connection;
  }

  /**
   * Disconnect from the WebSocket server.
   *
   * Signals all active generators to stop before closing the connection,
   * so consumers are unblocked immediately even if the close handshake
   * is slow.
   */
  disconnect(): void {
    this.closing = true;
    this.terminated = true;
    this.cancelReconnect();
    this.cancelConnect?.();
    this.stopPingInterval();
    this.finishStreams("Disconnected by client");

    if (this.ws) {
      // Close with a timeout — a half-open TCP socket can hang for
      // minutes waiting for the server's close frame.
      const ws = this.ws;
      this.ws = null;
      this.connected = false;

      const closeTimeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Already closed
        }
      }, 5000);

      ws.addEventListener("close", () => clearTimeout(closeTimeout), { once: true });
      ws.close();
    } else {
      this.connected = false;
    }
  }

  /** Check if connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Check if automatic recovery from an established connection is in progress. */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /** Check if permanently terminated (max reconnect attempts exhausted or disconnected). */
  isTerminated(): boolean {
    return this.terminated;
  }

  // ── Lifecycle events ───────────────────────────────────────────

  /**
   * Stream WebSocket connection lifecycle events.
   *
   * Yields {@link ConnectionEvent} objects whenever the connection state
   * changes.  Use this to detect reconnects and re-sync state from the
   * REST API — messages received during the disconnect window are lost.
   *
   * @example
   * ```ts
   * for await (const event of ws.streamLifecycle()) {
   *   if (event.state === "reconnected") {
   *     const balances = await client.getBalances(account);
   *     // ... rebuild local state ...
   *   } else if (event.state === "closed") {
   *     break;
   *   }
   * }
   * ```
   */
  streamLifecycle(): AsyncGenerator<ConnectionEvent> {
    const queue: ConnectionEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let registered = false;

    const handler = (msg: Record<string, unknown>) => {
      queue.push(msg as unknown as ConnectionEvent);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const closeHandler = () => stop(true);
    const stop = (drain = false) => {
      done = true;
      if (!drain) queue.length = 0;
      if (registered) {
        registered = false;
        for (const [action, listener] of [
          ["__lifecycle__", handler],
          ["__close__", closeHandler],
        ] as const) {
          const handlers = this.handlers.get(action);
          handlers?.delete(listener);
          if (handlers?.size === 0) this.handlers.delete(action);
        }
      }
      resolve?.();
      resolve = null;
    };
    const start = () => {
      if (registered || done) return;
      if (this.terminated) {
        stop();
        return;
      }
      registered = true;
      for (const [action, listener] of [
        ["__lifecycle__", handler],
        ["__close__", closeHandler],
      ] as const) {
        let handlers = this.handlers.get(action);
        if (!handlers) {
          handlers = new Set();
          this.handlers.set(action, handlers);
        }
        handlers.add(listener);
      }
    };

    const iterator = (async function* (): AsyncGenerator<ConnectionEvent> {
      try {
        while (!done) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        }
        // Drain events queued before done was set. disconnect() emits
        // the "closed" lifecycle event synchronously before firing close
        // handlers that set done=true — so the event is in the queue but
        // the while-loop exits before yielding it. This ensures consumers
        // always receive the terminal "closed" event.
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      } finally {
        stop();
      }
    })();
    return cancellableIterator(iterator, start, stop);
  }

  // ── Subscription streams ────────────────────────────────────────

  /**
   * Subscribe to order book depth updates.
   *
   * @param marketId - The market ID (hex string).
   * @param precision - A validated {@link DepthPrecision} created via
   *   {@link depthPrecision}`(level)` where level is 1–18. The high-level
   *   {@link O2Client.streamDepth} creates this automatically from a plain number.
   * @returns An async generator yielding {@link DepthUpdate} messages.
   */
  streamDepth(
    marketId: string,
    precision: DepthPrecision,
    selection: MarketSelection = {},
  ): AsyncGenerator<DepthUpdate> {
    const sub = {
      action: "subscribe_depth",
      ...selectionParams(selection),
      market_id: marketId,
      precision: precision as string,
    };
    return this.subscribe<DepthUpdate>(
      sub,
      ["subscribe_depth", "subscribe_depth_update"],
      parseDepthUpdate,
    );
  }

  /**
   * Subscribe to order updates.
   * Returns an AsyncGenerator yielding OrderUpdate messages.
   */
  streamOrders(
    identities: Identity[],
    selection: MarketSelection = {},
  ): AsyncGenerator<OrderUpdate> {
    const sub = { action: "subscribe_orders", identities, ...selectionParams(selection) };
    return this.subscribe<OrderUpdate>(sub, ["subscribe_orders"], parseOrderUpdate);
  }

  /**
   * Subscribe to trade updates.
   * Returns an AsyncGenerator yielding TradeUpdate messages.
   */
  streamTrades(marketId: string, selection: MarketSelection = {}): AsyncGenerator<TradeUpdate> {
    const sub = {
      action: "subscribe_trades",
      market_id: marketId,
      ...selectionParams(selection),
    };
    return this.subscribe<TradeUpdate>(sub, ["subscribe_trades", "trades"], parseTradeUpdate);
  }

  /**
   * Subscribe to balance updates.
   * Returns an AsyncGenerator yielding BalanceUpdate messages.
   */
  streamBalances(identities: Identity[]): AsyncGenerator<BalanceUpdate> {
    const sub = { action: "subscribe_balances", identities };
    return this.subscribe<BalanceUpdate>(sub, ["subscribe_balances"], parseBalanceUpdate);
  }

  /**
   * Subscribe to nonce updates.
   * Returns an AsyncGenerator yielding NonceUpdate messages.
   */
  streamNonce(identities: Identity[]): AsyncGenerator<NonceUpdate> {
    const sub = { action: "subscribe_nonce", identities };
    return this.subscribe<NonceUpdate>(sub, ["subscribe_nonce", "nonce"], parseNonceUpdate);
  }

  // ── Unsubscribe ─────────────────────────────────────────────────

  /** Unsubscribe from depth updates for a market. */
  unsubscribeDepth(marketId: string, selection: MarketSelection = {}): void {
    this.send({ action: "unsubscribe_depth", market_id: marketId, ...selectionParams(selection) });
    this.removePendingSub("subscribe_depth", marketId, selection);
  }

  /** Unsubscribe from order updates. */
  unsubscribeOrders(selection: MarketSelection = {}): void {
    this.send({ action: "unsubscribe_orders", ...selectionParams(selection) });
    this.removePendingSub("subscribe_orders", undefined, selection);
  }

  /** Unsubscribe from trade updates for a market. */
  unsubscribeTrades(marketId: string, selection: MarketSelection = {}): void {
    this.send({ action: "unsubscribe_trades", market_id: marketId, ...selectionParams(selection) });
    this.removePendingSub("subscribe_trades", marketId, selection);
  }

  /** Unsubscribe from balance updates. */
  unsubscribeBalances(identities: Identity[]): void {
    this.send({ action: "unsubscribe_balances", identities });
    this.removePendingSub("subscribe_balances");
  }

  /** Unsubscribe from nonce updates. */
  unsubscribeNonce(identities: Identity[]): void {
    this.send({ action: "unsubscribe_nonce", identities });
    this.removePendingSub("subscribe_nonce");
  }

  // ── Internal ────────────────────────────────────────────────────

  protected send(data: Record<string, unknown>): void {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  protected emitLifecycle(state: ConnectionState, attempt: number, message: string): void {
    const event: ConnectionEvent = { state, attempt, message };
    const handlers = this.handlers.get("__lifecycle__");
    if (handlers) {
      for (const handler of handlers) handler(event as unknown as Record<string, unknown>);
    }
  }

  protected subscribe<T>(
    subscription: Record<string, unknown>,
    actions: string[],
    transform?: (raw: Record<string, unknown>) => T,
  ): AsyncGenerator<T> {
    // Create a queue-based async generator
    const queue: T[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let registered = false;
    let consumers: Set<SubscriptionConsumer> | undefined;
    let consumer: SubscriptionConsumer | undefined;
    const key = this.subscriptionKey(subscription.action as string, subscription.market_id, {
      turbo: subscription.turbo === true,
    });

    let failure: StreamResyncRequired | null = null;
    const errorHandler = (msg: Record<string, unknown>) => {
      if (
        subscription.action !== "subscribe_trades" ||
        subscription.turbo !== true ||
        msg.turbo !== true ||
        msg.resync_required !== true ||
        typeof msg.market_id !== "string" ||
        typeof subscription.market_id !== "string" ||
        !sameHex(msg.market_id, subscription.market_id)
      )
        return;
      stop(false, new StreamResyncRequired());
    };

    const handler = (msg: Record<string, unknown>) => {
      if (done) return;
      if (subscription.market_id && !sameHex(String(msg.market_id), String(subscription.market_id)))
        return;
      const venueScoped =
        subscription.market_id !== undefined || subscription.action === "subscribe_orders";
      if (venueScoped && !!msg.turbo !== !!subscription.turbo) return;
      let parsed: T;
      try {
        parsed = transform ? transform(msg) : (msg as T);
      } catch {
        // Drop malformed payloads instead of letting parser exceptions
        // unwind through the WebSocket message event path.
        return;
      }
      queue.push(parsed);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const closeHandler = () => stop(true);
    const stop = (drain = false, error?: StreamResyncRequired) => {
      done = true;
      failure ??= error ?? null;
      if (!drain) queue.length = 0;
      if (registered) {
        registered = false;
        for (const [action, listener] of [
          ...actions.map((action) => [action, handler] as const),
          ["error", errorHandler] as const,
          ["__close__", closeHandler] as const,
        ]) {
          const handlers = this.handlers.get(action);
          handlers?.delete(listener);
          if (handlers?.size === 0) this.handlers.delete(action);
        }
        if (consumer && consumers) {
          consumers.delete(consumer);
          // Old iterators must not unsubscribe a topic replaced after explicit
          // unsubscribe or disconnect; queued-data behavior remains unchanged.
          if (this.subscriptionConsumers.get(key) === consumers) {
            const request = consumer.request;
            if (![...consumers].some((owner) => owner.request === request)) {
              this.pendingSubscriptions = this.pendingSubscriptions.filter(
                (sub) => sub !== request,
              );
            }
            if (consumers.size === 0) {
              this.subscriptionConsumers.delete(key);
              this.sendUnsubscribe(subscription);
            }
          }
        }
      }
      resolve?.();
      resolve = null;
    };
    const start = () => {
      if (registered || done) return;
      if (this.terminated) {
        stop();
        return;
      }
      // Preserve the request array's content deduplication and per-consumer sends.
      const subKey = JSON.stringify(subscription);
      const pending = this.pendingSubscriptions.find((sub) => JSON.stringify(sub) === subKey);
      consumers = this.subscriptionConsumers.get(key);
      if (!consumers) {
        consumers = new Set();
        this.subscriptionConsumers.set(key, consumers);
      }
      consumer = { request: pending ?? subscription };
      if (!pending) this.pendingSubscriptions.push(subscription);
      consumers.add(consumer);
      registered = true;
      for (const [action, listener] of [
        ...actions.map((action) => [action, handler] as const),
        ["error", errorHandler] as const,
        ["__close__", closeHandler] as const,
      ]) {
        let handlers = this.handlers.get(action);
        if (!handlers) {
          handlers = new Set();
          this.handlers.set(action, handlers);
        }
        handlers.add(listener);
      }
      this.send(subscription);
    };

    const iterator = (async function* (): AsyncGenerator<T> {
      try {
        while (!done) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        }
        if (failure) throw failure;
        // Drain data queued before close handler set done=true.
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      } finally {
        stop();
      }
    })();
    return cancellableIterator(iterator, start, stop);
  }

  protected startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (!this.ws || !this.connected) return;

      // Send an application-level PING. The server responds with PONG,
      // which flows through the message handler and updates lastMessage.
      // This works identically in Node.js and browsers — no feature
      // detection or protocol-level ping/pong needed.
      this.ws.send("PING");

      // If no message (including PONG) has arrived within pongTimeoutMs,
      // the connection is dead — close to trigger reconnect.
      if (this.lastMessage > 0 && Date.now() - this.lastMessage > this.pongTimeoutMs) {
        this.ws.close();
      }
    }, this.pingIntervalMs);
  }

  protected stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  protected attemptReconnect(): void {
    if (
      this.closing ||
      this.terminated ||
      this.connected ||
      this.connecting ||
      this.reconnectTimer
    ) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.finishStreams(`Max reconnect attempts (${this.maxReconnectAttempts}) exhausted`);
      return;
    }

    const delay = this.reconnectDelayMs * 2 ** this.reconnectAttempts * (0.5 + Math.random());
    const attempt = ++this.reconnectAttempts;
    this.emitLifecycle(
      "reconnecting",
      attempt,
      `Reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing || this.terminated) return;
      // connect() owns both recovery events and retries, even for manual opens.
      void this.connect().catch(() => {});
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private finishStreams(message: string): void {
    this.terminated = true;
    this.reconnecting = false;
    this.cancelReconnect();
    // Clear ownership before closing streams to avoid sending unsubscribes on teardown.
    this.pendingSubscriptions = [];
    this.subscriptionConsumers.clear();
    this.emitLifecycle("closed", this.reconnectAttempts, message);
    for (const handler of [...(this.handlers.get("__close__") ?? [])]) handler({});
    this.handlers.clear();
  }

  private subscriptionKey(
    action: string,
    marketId?: unknown,
    selection: MarketSelection = {},
  ): string {
    const market = typeof marketId === "string" ? normaliseHex(marketId) : null;
    return JSON.stringify([action, market, !!selection.turbo]);
  }

  private sendUnsubscribe(request: Record<string, unknown>): void {
    const { precision: _precision, identities, ...unsubscribe } = request;
    this.send({
      ...unsubscribe,
      ...(request.action === "subscribe_orders" ? {} : { identities }),
      action: (request.action as string).replace("subscribe_", "unsubscribe_"),
    });
  }

  protected removePendingSub(
    action: string,
    marketId?: string,
    selection: MarketSelection = {},
  ): void {
    this.pendingSubscriptions = this.pendingSubscriptions.filter((s) => {
      if (s.action !== action) return true;
      if (marketId && !sameHex(String(s.market_id), marketId)) return true;
      if (!!s.turbo !== !!selection.turbo) return true;
      this.subscriptionConsumers.delete(this.subscriptionKey(action, s.market_id, selection));
      return false;
    });
  }
}

// Native return()/throw() queue behind a pending next(). Release its resources
// and wake the read before delegating, without registering an unstarted iterator.
function cancellableIterator<T>(
  iterator: AsyncGenerator<T>,
  start: () => void,
  stop: () => void,
): AsyncGenerator<T> {
  const next = iterator.next.bind(iterator);
  iterator.next = (...args) => {
    try {
      start();
    } catch (error) {
      stop();
      return Promise.reject(error);
    }
    return next(...args);
  };
  const returnIterator = iterator.return.bind(iterator);
  iterator.return = (value) => {
    stop();
    return returnIterator(value);
  };
  const throwIterator = iterator.throw.bind(iterator);
  iterator.throw = (error) => {
    stop();
    return throwIterator(error);
  };
  return iterator;
}

function createDefaultWebSocket(url: string): WebSocket {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
      "WebSocket is not available in this runtime. Provide O2WebSocketOptions.webSocketFactory or use Node.js 22.4+.",
    );
  }
  return new globalThis.WebSocket(url);
}

async function messageEventToText(event: MessageEvent): Promise<string | null> {
  if (typeof event.data === "string") return event.data;
  if (event.data instanceof ArrayBuffer) return new TextDecoder().decode(event.data);
  if (ArrayBuffer.isView(event.data)) return new TextDecoder().decode(event.data);
  if (typeof Blob !== "undefined" && event.data instanceof Blob) return await event.data.text();
  return null;
}

function dispatchParsedMessage(
  rawMessage: string,
  handlers: Map<string, Set<MessageHandler>>,
): void {
  try {
    const msg = JSON.parse(rawMessage) as Record<string, unknown>;
    const action = msg.action as string | undefined;
    if (action) {
      const actionHandlers = handlers.get(action);
      if (actionHandlers) {
        for (const handler of actionHandlers) handler(msg);
      }
      const wildcardHandlers = handlers.get("*");
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) handler(msg);
      }
    }
  } catch {
    // Ignore non-JSON messages.
  }
}
