/**
 * WebSocket client for O2 Exchange real-time data.
 *
 * Provides real-time streaming of order book depth, orders, trades,
 * balances, and nonce updates via `AsyncGenerator` streams.
 *
 * Features:
 * - Auto-reconnect with exponential backoff and jitter
 * - `AsyncGenerator` streams for each subscription type
 * - Heartbeat/ping-pong health monitoring
 * - Automatic re-subscription after reconnect
 * - Proper cleanup on disconnect
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
  private readonly reconnect: boolean;
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
  private lastPong = 0;
  private pendingSubscriptions: Array<Record<string, unknown>> = [];

  constructor(options: O2WebSocketOptions) {
    this.url = options.config.wsUrl;
    this.reconnect = options.reconnect ?? true;
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
        this.lastPong = Date.now();
        this.startPingInterval();
        // Re-subscribe after reconnect
        for (const sub of this.pendingSubscriptions) {
          this.send(sub);
        }
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.lastPong = Date.now();
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
        if (!this.closing && this.reconnect) {
          this.attemptReconnect();
        }
      });

      this.ws.on("error", (err: Error) => {
        if (!this.connected) {
          reject(err);
        }
      });

      this.ws.on("pong", () => {
        this.lastPong = Date.now();
      });
    });
  }

  /** Disconnect from the WebSocket server. */
  disconnect(): void {
    this.closing = true;
    this.stopPingInterval();
    this.pendingSubscriptions = [];
    // Signal all active generators to stop before clearing handlers
    const closeHandlers = this.handlers.get("__close__");
    if (closeHandlers) {
      for (const handler of closeHandlers) handler({});
    }
    this.handlers.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /** Check if connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Check if permanently terminated (max reconnect attempts exhausted or disconnected). */
  isTerminated(): boolean {
    return this.terminated;
  }

  // ── Subscription streams ────────────────────────────────────────

  /**
   * Subscribe to order book depth updates.
   * Returns an AsyncGenerator yielding DepthUpdate messages.
   */
  async *streamDepth(
    marketId: string,
    precision: string | number = "10",
  ): AsyncGenerator<DepthUpdate> {
    const sub = {
      action: "subscribe_depth",
      market_id: marketId,
      precision: String(precision),
    };
    yield* this.subscribe<DepthUpdate>(sub, ["subscribe_depth", "subscribe_depth_update"]);
  }

  /**
   * Subscribe to order updates.
   * Returns an AsyncGenerator yielding OrderUpdate messages.
   */
  async *streamOrders(identities: Identity[]): AsyncGenerator<OrderUpdate> {
    const sub = { action: "subscribe_orders", identities };
    yield* this.subscribe<OrderUpdate>(sub, ["subscribe_orders"]);
  }

  /**
   * Subscribe to trade updates.
   * Returns an AsyncGenerator yielding TradeUpdate messages.
   */
  async *streamTrades(marketId: string): AsyncGenerator<TradeUpdate> {
    const sub = { action: "subscribe_trades", market_id: marketId };
    yield* this.subscribe<TradeUpdate>(sub, ["subscribe_trades", "trades"]);
  }

  /**
   * Subscribe to balance updates.
   * Returns an AsyncGenerator yielding BalanceUpdate messages.
   */
  async *streamBalances(identities: Identity[]): AsyncGenerator<BalanceUpdate> {
    const sub = { action: "subscribe_balances", identities };
    yield* this.subscribe<BalanceUpdate>(sub, ["subscribe_balances"]);
  }

  /**
   * Subscribe to nonce updates.
   * Returns an AsyncGenerator yielding NonceUpdate messages.
   */
  async *streamNonce(identities: Identity[]): AsyncGenerator<NonceUpdate> {
    const sub = { action: "subscribe_nonce", identities };
    yield* this.subscribe<NonceUpdate>(sub, ["subscribe_nonce", "nonce"]);
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

  private async *subscribe<T>(
    subscription: Record<string, unknown>,
    actions: string[],
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
      queue.push(msg as T);
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
      if (this.ws && this.connected) {
        // Check pong timeout
        if (this.lastPong > 0 && Date.now() - this.lastPong > this.pongTimeoutMs) {
          this.ws.close();
          return;
        }
        this.ws.ping();
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
      const closeHandlers = this.handlers.get("__close__");
      if (closeHandlers) {
        for (const handler of closeHandlers) handler({});
      }
      return;
    }

    const delay = this.reconnectDelayMs * 2 ** this.reconnectAttempts * (0.5 + Math.random());
    this.reconnectAttempts++;

    setTimeout(() => {
      if (!this.closing) {
        this.connect().catch(() => {
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
