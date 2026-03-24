/**
 * WebSocket client for O2 Exchange real-time data.
 *
 * Provides real-time streaming of order book depth, orders, trades,
 * balances, and nonce updates via `AsyncGenerator` streams.
 *
 * Features:
 * - Auto-reconnect with exponential backoff and jitter
 * - `AsyncGenerator` streams for each subscription type
 * - Heartbeat/ping-pong health monitoring (protocol-level, not data-based)
 * - Automatic re-subscription after reconnect
 * - Connection lifecycle events for state awareness
 * - Proper cleanup on disconnect with timeouts
 *
 * @module
 */

import WebSocket from "ws";
import type { NetworkConfig } from "./config.js";
import type {
  BalanceUpdate,
  DepthUpdate,
  Identity,
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
  /** Heartbeat ping interval in milliseconds (default: `30000`). */
  pingIntervalMs?: number;
  /** Pong timeout in milliseconds — triggers reconnect if no pong received (default: `60000`). */
  pongTimeoutMs?: number;
}

type MessageHandler = (data: Record<string, unknown>) => void;

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
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly shouldReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private reconnectAttempts = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private connected = false;
  private closing = false;
  private terminated = false;
  private pendingSubscriptions: Array<Record<string, unknown>> = [];

  constructor(options: O2WebSocketOptions) {
    this.url = options.config.wsUrl;
    this.shouldReconnect = options.reconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 60000;
  }

  /** Connect to the WebSocket server. */
  async connect(): Promise<void> {
    this.closing = false;
    this.terminated = false;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.startPingInterval();
        // Re-subscribe after reconnect
        for (const sub of this.pendingSubscriptions) {
          this.send(sub);
        }
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          const action = msg.action as string | undefined;
          if (action) {
            const actionHandlers = this.handlers.get(action);
            if (actionHandlers) {
              for (const handler of actionHandlers) handler(msg);
            }
            // Also dispatch to wildcard handlers
            const wildcardHandlers = this.handlers.get("*");
            if (wildcardHandlers) {
              for (const handler of wildcardHandlers) handler(msg);
            }
          }
        } catch (_e: unknown) {
          // Ignore non-JSON messages (pong, etc.)
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.stopPingInterval();
        if (!this.closing && this.shouldReconnect) {
          this.emitLifecycle("disconnected", 0, "Connection lost");
          this.attemptReconnect();
        }
      });

      this.ws.on("error", (err: Error) => {
        if (!this.connected) {
          reject(err);
        }
      });

      // Protocol-level pong — the ONLY signal used for liveness detection.
      // Application data arrival is NOT used because subscriptions may
      // legitimately receive no data for long periods (e.g. depth at
      // precision 0 on a quiet market).
      this.ws.on("pong", () => {
        // Pong received — connection is alive.  The ping interval check
        // uses ws.ping() which returns a pong; we just need to know it
        // arrived.  Node ws fires this event on protocol-level pong.
      });
    });
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
    this.stopPingInterval();
    this.pendingSubscriptions = [];

    // Signal all active generators to stop FIRST — consumers should
    // unblock before we attempt the (potentially slow) WS close.
    this.emitLifecycle("closed", 0, "Disconnected by client");
    const closeHandlers = this.handlers.get("__close__");
    if (closeHandlers) {
      for (const handler of closeHandlers) handler({});
    }
    this.handlers.clear();

    if (this.ws) {
      // Close with a timeout — a half-open TCP socket can hang for
      // minutes waiting for the server's close frame.
      const ws = this.ws;
      this.ws = null;
      this.connected = false;

      const closeTimeout = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // Already closed
        }
      }, 5000);

      ws.once("close", () => clearTimeout(closeTimeout));
      ws.close();
    } else {
      this.connected = false;
    }
  }

  /** Check if connected. */
  isConnected(): boolean {
    return this.connected;
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
  async *streamLifecycle(): AsyncGenerator<ConnectionEvent> {
    const queue: ConnectionEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const handler = (msg: Record<string, unknown>) => {
      queue.push(msg as unknown as ConnectionEvent);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const closeHandler = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    // Register on the __lifecycle__ action
    let lifecycleHandlers = this.handlers.get("__lifecycle__");
    if (!lifecycleHandlers) {
      lifecycleHandlers = new Set();
      this.handlers.set("__lifecycle__", lifecycleHandlers);
    }
    lifecycleHandlers.add(handler);

    let closeHandlers = this.handlers.get("__close__");
    if (!closeHandlers) {
      closeHandlers = new Set();
      this.handlers.set("__close__", closeHandlers);
    }
    closeHandlers.add(closeHandler);

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
    } finally {
      const lh = this.handlers.get("__lifecycle__");
      if (lh) {
        lh.delete(handler);
        if (lh.size === 0) this.handlers.delete("__lifecycle__");
      }
      const ch = this.handlers.get("__close__");
      if (ch) {
        ch.delete(closeHandler);
        if (ch.size === 0) this.handlers.delete("__close__");
      }
    }
  }

  // ── Subscription streams ────────────────────────────────────────

  /**
   * Subscribe to order book depth updates.
   *
   * @param marketId - The market ID (hex string).
   * @param precision - Depth aggregation level index (default: `"1"` = finest).
   *   Valid range: **1--18**. The SDK sends `10^precision` on the wire, matching
   *   the internal backend convention. All levels support live delta streaming.
   * @returns An async generator yielding {@link DepthUpdate} messages.
   * @throws {Error} If `precision` is outside the valid range 1--18.
   */
  async *streamDepth(
    marketId: string,
    precision: string | number = "1",
  ): AsyncGenerator<DepthUpdate> {
    const p = typeof precision === "string" ? Number.parseInt(precision, 10) : precision;
    if (!Number.isFinite(p) || p < 1 || p > 18) {
      throw new Error(
        `Invalid depth precision ${precision}. Valid range: 1-18 (powers of 10). ` +
          "Precision 0 is not supported — use getDepth() via REST for exact prices.",
      );
    }
    const sub = {
      action: "subscribe_depth",
      market_id: marketId,
      precision: String(10 ** p), // precision is an index; wire value = 10^precision
    };
    yield* this.subscribe<DepthUpdate>(
      sub,
      ["subscribe_depth", "subscribe_depth_update"],
      parseDepthUpdate,
    );
  }

  /**
   * Subscribe to order updates.
   * Returns an AsyncGenerator yielding OrderUpdate messages.
   */
  async *streamOrders(identities: Identity[]): AsyncGenerator<OrderUpdate> {
    const sub = { action: "subscribe_orders", identities };
    yield* this.subscribe<OrderUpdate>(sub, ["subscribe_orders"], parseOrderUpdate);
  }

  /**
   * Subscribe to trade updates.
   * Returns an AsyncGenerator yielding TradeUpdate messages.
   */
  async *streamTrades(marketId: string): AsyncGenerator<TradeUpdate> {
    const sub = { action: "subscribe_trades", market_id: marketId };
    yield* this.subscribe<TradeUpdate>(sub, ["subscribe_trades", "trades"], parseTradeUpdate);
  }

  /**
   * Subscribe to balance updates.
   * Returns an AsyncGenerator yielding BalanceUpdate messages.
   */
  async *streamBalances(identities: Identity[]): AsyncGenerator<BalanceUpdate> {
    const sub = { action: "subscribe_balances", identities };
    yield* this.subscribe<BalanceUpdate>(sub, ["subscribe_balances"], parseBalanceUpdate);
  }

  /**
   * Subscribe to nonce updates.
   * Returns an AsyncGenerator yielding NonceUpdate messages.
   */
  async *streamNonce(identities: Identity[]): AsyncGenerator<NonceUpdate> {
    const sub = { action: "subscribe_nonce", identities };
    yield* this.subscribe<NonceUpdate>(sub, ["subscribe_nonce", "nonce"], parseNonceUpdate);
  }

  // ── Unsubscribe ─────────────────────────────────────────────────

  /** Unsubscribe from depth updates for a market. */
  unsubscribeDepth(marketId: string): void {
    this.send({ action: "unsubscribe_depth", market_id: marketId });
    this.removePendingSub("subscribe_depth", marketId);
  }

  /** Unsubscribe from order updates. */
  unsubscribeOrders(): void {
    this.send({ action: "unsubscribe_orders" });
    this.removePendingSub("subscribe_orders");
  }

  /** Unsubscribe from trade updates for a market. */
  unsubscribeTrades(marketId: string): void {
    this.send({ action: "unsubscribe_trades", market_id: marketId });
    this.removePendingSub("subscribe_trades", marketId);
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

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private emitLifecycle(state: ConnectionState, attempt: number, message: string): void {
    const event: ConnectionEvent = { state, attempt, message };
    const handlers = this.handlers.get("__lifecycle__");
    if (handlers) {
      for (const handler of handlers) handler(event as unknown as Record<string, unknown>);
    }
  }

  private async *subscribe<T>(
    subscription: Record<string, unknown>,
    actions: string[],
    transform?: (raw: Record<string, unknown>) => T,
  ): AsyncGenerator<T> {
    // Track for reconnection (deduplicate by content)
    const subKey = JSON.stringify(subscription);
    if (!this.pendingSubscriptions.some((s) => JSON.stringify(s) === subKey)) {
      this.pendingSubscriptions.push(subscription);
    }

    // Send subscription message
    this.send(subscription);

    // Create a queue-based async generator
    const queue: T[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const handler = (msg: Record<string, unknown>) => {
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

    // When the WebSocket disconnects or is cleaned up, signal the generator to stop
    const closeHandler = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    // Register handlers for all matching actions
    for (const action of actions) {
      let handlers = this.handlers.get(action);
      if (!handlers) {
        handlers = new Set();
        this.handlers.set(action, handlers);
      }
      handlers.add(handler);
    }

    // Register a close handler to break the loop on disconnect
    let closeHandlers = this.handlers.get("__close__");
    if (!closeHandlers) {
      closeHandlers = new Set();
      this.handlers.set("__close__", closeHandlers);
    }
    closeHandlers.add(closeHandler);

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
    } finally {
      // Clean up handlers
      for (const action of actions) {
        const handlers = this.handlers.get(action);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) this.handlers.delete(action);
        }
      }
      const cHandlers = this.handlers.get("__close__");
      if (cHandlers) {
        cHandlers.delete(closeHandler);
        if (cHandlers.size === 0) this.handlers.delete("__close__");
      }
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (!this.ws || !this.connected) return;

      // Use protocol-level ping/pong for liveness detection.
      // Do NOT use application data arrival — subscriptions may
      // legitimately receive no data for long periods.
      try {
        let pongReceived = false;
        const pongHandler = () => {
          pongReceived = true;
        };
        this.ws.once("pong", pongHandler);
        this.ws.ping();

        // Check after pongTimeoutMs if pong arrived
        setTimeout(() => {
          this.ws?.removeListener("pong", pongHandler);
          if (!pongReceived && this.connected && !this.closing) {
            // No pong — connection is dead
            this.ws?.close();
          }
        }, this.pongTimeoutMs);
      } catch {
        // Connection error during ping
        this.ws?.close();
      }
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Max attempts exhausted — signal all generators to terminate
      this.terminated = true;
      this.emitLifecycle(
        "closed",
        this.reconnectAttempts,
        `Max reconnect attempts (${this.maxReconnectAttempts}) exhausted`,
      );
      const closeHandlers = this.handlers.get("__close__");
      if (closeHandlers) {
        for (const handler of closeHandlers) handler({});
      }
      return;
    }

    const delay = this.reconnectDelayMs * 2 ** this.reconnectAttempts * (0.5 + Math.random());
    this.reconnectAttempts++;
    this.emitLifecycle(
      "reconnecting",
      this.reconnectAttempts,
      `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      if (!this.closing) {
        this.connect()
          .then(() => {
            this.emitLifecycle(
              "reconnected",
              this.reconnectAttempts,
              "Reconnected — consumers should re-sync from REST",
            );
          })
          .catch(() => {
            // Reconnect failed, will try again via the close handler
          });
      }
    }, delay);
  }

  private removePendingSub(action: string, marketId?: string): void {
    this.pendingSubscriptions = this.pendingSubscriptions.filter((s) => {
      if (s.action !== action) return true;
      if (marketId && s.market_id !== marketId) return true;
      return false;
    });
  }
}
