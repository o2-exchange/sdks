/**
 * WebSocket client for O2 Exchange real-time data.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - AsyncGenerator streams for each subscription type
 * - Heartbeat/ping-pong handling
 * - Proper subscription/unsubscription management
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

export interface O2WebSocketOptions {
  config: NetworkConfig;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
}

type MessageHandler = (data: Record<string, unknown>) => void;

export class O2WebSocket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly reconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly pingIntervalMs: number;
  private reconnectAttempts = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private connected = false;
  private closing = false;
  private pendingSubscriptions: Array<Record<string, unknown>> = [];

  constructor(options: O2WebSocketOptions) {
    this.url = options.config.wsUrl;
    this.reconnect = options.reconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
  }

  /** Connect to the WebSocket server. */
  async connect(): Promise<void> {
    this.closing = false;
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
        } catch {
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
        // Pong received, connection is alive
      });
    });
  }

  /** Disconnect from the WebSocket server. */
  disconnect(): void {
    this.closing = true;
    this.stopPingInterval();
    this.pendingSubscriptions = [];
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

  unsubscribeDepth(marketId: string): void {
    this.send({ action: "unsubscribe_depth", market_id: marketId });
    this.removePendingSub("subscribe_depth", marketId);
  }

  unsubscribeOrders(): void {
    this.send({ action: "unsubscribe_orders" });
    this.removePendingSub("subscribe_orders");
  }

  unsubscribeTrades(marketId: string): void {
    this.send({ action: "unsubscribe_trades", market_id: marketId });
    this.removePendingSub("subscribe_trades", marketId);
  }

  unsubscribeBalances(identities: Identity[]): void {
    this.send({ action: "unsubscribe_balances", identities });
    this.removePendingSub("subscribe_balances");
  }

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
    // Track for reconnection
    this.pendingSubscriptions.push(subscription);

    // Send subscription message
    this.send(subscription);

    // Create a queue-based async generator
    const queue: T[] = [];
    let resolve: (() => void) | null = null;
    const done = false;

    const handler = (msg: Record<string, unknown>) => {
      queue.push(msg as T);
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
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.connected) {
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
