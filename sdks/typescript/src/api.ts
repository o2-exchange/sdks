/**
 * REST API client for O2 Exchange.
 *
 * Provides typed wrappers for every REST endpoint. Returns typed response
 * objects with chain-integer fields parsed to `bigint`. Raises
 * {@link O2Error} subclasses with typed error codes. Includes automatic
 * retry logic for rate limits (error 1003) with exponential backoff.
 *
 * For most use cases, prefer the high-level {@link O2Client} which
 * orchestrates wallet, session, and encoding automatically. Use `O2Api`
 * directly when you need fine-grained control over individual API calls.
 *
 * @module
 */

import type { NetworkConfig } from "./config.js";
import { isActionsSuccess, O2Error, parseApiError, RateLimitExceeded } from "./errors.js";
import {
  type AccountInfo,
  type AggregatedAsset,
  type AggregatedOrderbook,
  type AssetId,
  assetId,
  type BalanceResponse,
  type Bar,
  type CreateAccountResponse,
  contractId,
  type DepthSnapshot,
  type FaucetResponse,
  type Identity,
  type MarketId,
  type MarketSummary,
  type MarketsResponse,
  type MarketTicker,
  type Order,
  type OrderId,
  type OrdersResponse,
  type PairSummary,
  type PairTicker,
  parseAccountInfo,
  parseBalanceResponse,
  parseDepthLevel,
  parseMarket,
  parseOrder,
  parseTrade,
  type ReferralInfo,
  type SessionActionsRequest,
  SessionActionsResponse,
  type SessionRequest,
  type SessionResponse,
  type Trade,
  type TradeAccountId,
  type WhitelistResponse,
  type WithdrawRequest,
  type WithdrawResponse,
} from "./models.js";

/**
 * Configuration options for {@link O2Api}.
 */
export interface O2ApiOptions {
  /** Network endpoint configuration. */
  config: NetworkConfig;
  /** Maximum number of retries for rate-limited requests (default: 3). */
  maxRetries?: number;
  /** Base delay between retries in milliseconds (default: 1000). */
  retryDelayMs?: number;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
}

/**
 * Low-level REST API client for the O2 Exchange.
 *
 * Provides typed methods for every REST endpoint. Automatically retries
 * on rate limit errors with exponential backoff and jitter.
 *
 * @example
 * ```ts
 * import { O2Api, TESTNET } from "@o2exchange/sdk";
 *
 * const api = new O2Api({ config: TESTNET });
 * const markets = await api.getMarkets();
 * console.log(markets.markets.length);
 * ```
 */
export class O2Api {
  private readonly baseUrl: string;
  private readonly faucetUrl: string | null;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: O2ApiOptions) {
    this.baseUrl = options.config.apiBase;
    this.faucetUrl = options.config.faucetUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  // ── Internal HTTP helpers ───────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined) params.set(key, String(val));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const body = (await resp.json()) as Record<string, unknown>;

        if (!resp.ok) {
          const err = parseApiError(body);
          if (err instanceof RateLimitExceeded && attempt < this.maxRetries) {
            const delay = this.retryDelayMs * 2 ** attempt * (0.5 + Math.random());
            await sleep(delay);
            lastError = err;
            continue;
          }
          throw err;
        }

        return body as T;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof O2Error) throw error;
        lastError = error as Error;
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** attempt * (0.5 + Math.random());
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>("GET", path, { query, headers });
  }

  private async post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, { body, headers });
  }

  private async put<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("PUT", path, { body, headers });
  }

  // ── Market Data ─────────────────────────────────────────────────

  /** Fetch all markets and global registry configuration. */
  async getMarkets(): Promise<MarketsResponse> {
    const raw = await this.get<Record<string, unknown>>("/v1/markets");
    const rawMarkets = raw.markets as Record<string, unknown>[];
    return {
      books_registry_id: contractId(raw.books_registry_id as string),
      accounts_registry_id: contractId(raw.accounts_registry_id as string),
      trade_account_oracle_id: contractId(raw.trade_account_oracle_id as string),
      chain_id: raw.chain_id as string,
      base_asset_id: assetId(raw.base_asset_id as string),
      markets: rawMarkets.map(parseMarket),
    };
  }

  /**
   * Fetch 24-hour market summary statistics.
   * @param marketId - The market identifier.
   */
  async getMarketSummary(marketId: MarketId): Promise<MarketSummary> {
    return this.get<MarketSummary>("/v1/markets/summary", {
      market_id: marketId,
    });
  }

  /**
   * Fetch real-time ticker data for a market.
   * @param marketId - The market identifier.
   */
  async getMarketTicker(marketId: MarketId): Promise<MarketTicker> {
    return this.get<MarketTicker>("/v1/markets/ticker", {
      market_id: marketId,
    });
  }

  /**
   * Fetch the order book depth snapshot.
   * @param marketId - The market identifier.
   * @param precision - Price aggregation precision (default: 10).
   */
  async getDepth(marketId: MarketId, precision = 10): Promise<DepthSnapshot> {
    const data = await this.get<Record<string, unknown>>("/v1/depth", {
      market_id: marketId,
      precision,
    });
    // API wraps depth in "orders" or "view" field; unwrap it
    const depth = (data.orders ?? data.view ?? data) as Record<string, unknown>;
    const buys = (depth.buys ?? []) as Record<string, unknown>[];
    const sells = (depth.sells ?? []) as Record<string, unknown>[];
    return {
      buys: buys.map(parseDepthLevel),
      sells: sells.map(parseDepthLevel),
    };
  }

  // ── Trading Data ────────────────────────────────────────────────

  /**
   * Fetch recent trades for a market.
   * @param marketId - The market identifier.
   * @param direction - Sort direction (default: `"desc"`).
   * @param count - Number of trades to return (default: 50).
   * @param startTimestamp - Optional starting timestamp for pagination.
   * @param startTradeId - Optional starting trade ID for pagination.
   */
  async getTrades(
    marketId: MarketId,
    direction: "asc" | "desc" = "desc",
    count = 50,
    startTimestamp?: number,
    startTradeId?: string,
  ): Promise<Trade[]> {
    const data = await this.get<unknown>("/v1/trades", {
      market_id: marketId,
      direction,
      count,
      start_timestamp: startTimestamp,
      start_trade_id: startTradeId,
    });
    const rawArr = Array.isArray(data) ? data : (data as { trades: unknown[] }).trades;
    return (rawArr as Record<string, unknown>[]).map(parseTrade);
  }

  /**
   * Fetch trades for a specific account.
   * @param marketId - The market identifier.
   * @param contract - The trade account contract ID.
   * @param direction - Sort direction (default: `"desc"`).
   * @param count - Number of trades to return (default: 50).
   */
  async getTradesByAccount(
    marketId: MarketId,
    contract: TradeAccountId,
    direction: "asc" | "desc" = "desc",
    count = 50,
    startTimestamp?: number,
    startTradeId?: string,
  ): Promise<Trade[]> {
    const raw = await this.get<Record<string, unknown>[]>("/v1/trades_by_account", {
      market_id: marketId,
      contract,
      direction,
      count,
      start_timestamp: startTimestamp,
      start_trade_id: startTradeId,
    });
    return raw.map(parseTrade);
  }

  /**
   * Fetch OHLCV candlestick bars.
   * @param marketId - The market identifier.
   * @param from - Start time (Unix seconds).
   * @param to - End time (Unix seconds).
   * @param resolution - Bar resolution (e.g., `"1m"`, `"1h"`, `"1d"`).
   */
  async getBars(marketId: MarketId, from: number, to: number, resolution: string): Promise<Bar[]> {
    return this.get<Bar[]>("/v1/bars", {
      market_id: marketId,
      from,
      to,
      resolution,
    });
  }

  // ── Account & Balance ───────────────────────────────────────────

  /**
   * Create a new trading account.
   * @param identity - The owner identity for the new account.
   */
  async createAccount(identity: Identity): Promise<CreateAccountResponse> {
    return this.post<CreateAccountResponse>("/v1/accounts", { identity });
  }

  /**
   * Fetch account information by owner address, contract, or trade account ID.
   * @param params - Lookup parameters (provide one of `owner`, `ownerContract`, or `tradeAccountId`).
   */
  async getAccount(params: {
    owner?: string;
    ownerContract?: string;
    tradeAccountId?: TradeAccountId;
  }): Promise<AccountInfo> {
    const raw = await this.get<Record<string, unknown>>("/v1/accounts", {
      owner: params.owner,
      owner_contract: params.ownerContract,
      trade_account_id: params.tradeAccountId,
    });
    return parseAccountInfo(raw);
  }

  /**
   * Fetch balance for a specific asset and account.
   * @param assetId - The asset ID.
   * @param params - Account lookup parameters.
   */
  async getBalance(
    assetId: AssetId,
    params: { address?: string; contract?: TradeAccountId },
  ): Promise<BalanceResponse> {
    const raw = await this.get<Record<string, unknown>>("/v1/balance", {
      asset_id: assetId,
      address: params.address,
      contract: params.contract,
    });
    return parseBalanceResponse(raw);
  }

  // ── Orders ──────────────────────────────────────────────────────

  /**
   * Fetch orders for an account on a specific market.
   * @param marketId - The market identifier.
   * @param contract - The trade account contract ID.
   * @param direction - Sort direction (default: `"desc"`).
   * @param count - Number of orders to return (default: 20).
   * @param isOpen - Filter by open/closed status.
   */
  async getOrders(
    marketId: MarketId,
    contract: TradeAccountId,
    direction: "asc" | "desc" = "desc",
    count = 20,
    isOpen?: boolean,
    startTimestamp?: number,
    startOrderId?: OrderId,
  ): Promise<OrdersResponse> {
    const raw = await this.get<Record<string, unknown>>("/v1/orders", {
      market_id: marketId,
      contract,
      direction,
      count,
      is_open: isOpen,
      start_timestamp: startTimestamp,
      start_order_id: startOrderId,
    });
    const rawOrders = (raw.orders ?? []) as Record<string, unknown>[];
    return {
      ...(raw as unknown as OrdersResponse),
      orders: rawOrders.map(parseOrder),
    };
  }

  /**
   * Fetch a single order by ID.
   * @param marketId - The market identifier.
   * @param orderId - The order identifier.
   */
  async getOrder(marketId: MarketId, orderId: OrderId): Promise<Order> {
    const data = await this.get<Record<string, unknown>>("/v1/order", {
      market_id: marketId,
      order_id: orderId,
    });
    // API wraps order in an "order" key
    const raw = (data.order ?? data) as Record<string, unknown>;
    return parseOrder(raw);
  }

  // ── Session Management ──────────────────────────────────────────

  /**
   * Create a new trading session.
   * @param ownerId - The owner's b256 address.
   * @param request - The session creation request.
   */
  async createSession(ownerId: string, request: SessionRequest): Promise<SessionResponse> {
    return this.put<SessionResponse>("/v1/session", request, {
      "O2-Owner-Id": ownerId,
    });
  }

  /**
   * Submit session actions (create/cancel orders, settle balances).
   * @param ownerId - The owner's b256 address.
   * @param request - The signed session actions request.
   *
   * Preflight validation errors (e.g., invalid nonce, insufficient balance)
   * are returned as a {@link SessionActionsResponse} with
   * `isPreflightError === true` rather than thrown.
   */
  async submitActions(
    ownerId: string,
    request: SessionActionsRequest,
  ): Promise<SessionActionsResponse> {
    try {
      const body = await this.request<Record<string, unknown>>("POST", "/v1/session/actions", {
        body: request,
        headers: { "O2-Owner-Id": ownerId },
      });

      if (isActionsSuccess(body)) {
        return SessionActionsResponse.fromResponse(body, parseOrder);
      }

      throw parseApiError(body);
    } catch (error) {
      // Convert preflight validation errors into SessionActionsResponse
      // so callers can use response.isPreflightError instead of catching
      if (error instanceof O2Error && error.code != null) {
        return new SessionActionsResponse(null, null, null, null, error.code, error.message);
      }
      throw error;
    }
  }

  // ── Account Operations ──────────────────────────────────────────

  /**
   * Withdraw funds from a trading account.
   * @param ownerId - The owner's b256 address.
   * @param request - The signed withdrawal request.
   */
  async withdraw(ownerId: string, request: WithdrawRequest): Promise<WithdrawResponse> {
    return this.post<WithdrawResponse>("/v1/accounts/withdraw", request, {
      "O2-Owner-Id": ownerId,
    });
  }

  // ── Analytics ───────────────────────────────────────────────────

  /**
   * Whitelist a trading account.
   * @param tradeAccountId - The trade account contract ID.
   */
  async whitelistAccount(tradeAccountId: TradeAccountId): Promise<WhitelistResponse> {
    return this.post<WhitelistResponse>("/analytics/v1/whitelist", {
      tradeAccount: tradeAccountId,
    });
  }

  /**
   * Fetch referral code information.
   * @param code - The referral code.
   */
  async getReferralInfo(code: string): Promise<ReferralInfo> {
    return this.get<ReferralInfo>("/analytics/v1/referral/code-info", { code });
  }

  // ── Aggregated ──────────────────────────────────────────────────

  /** Fetch all aggregated assets (CoinGecko-compatible). */
  async getAggregatedAssets(): Promise<AggregatedAsset[]> {
    return this.get<AggregatedAsset[]>("/v1/aggregated/assets");
  }

  /**
   * Fetch aggregated order book (CoinGecko-compatible).
   * @param marketPair - The market pair (e.g., `"fFUEL_fUSDC"`).
   * @param depth - Number of levels (default: 500).
   * @param level - Aggregation level (default: 2).
   */
  async getAggregatedOrderbook(
    marketPair: string,
    depth = 500,
    level = 2,
  ): Promise<AggregatedOrderbook> {
    return this.get<AggregatedOrderbook>("/v1/aggregated/orderbook", {
      market_pair: marketPair,
      depth,
      level,
    });
  }

  /** Fetch aggregated pair summaries (CoinGecko-compatible). */
  async getAggregatedSummary(): Promise<PairSummary[]> {
    return this.get<PairSummary[]>("/v1/aggregated/summary");
  }

  /** Fetch aggregated pair tickers (CoinGecko-compatible). */
  async getAggregatedTicker(): Promise<PairTicker[]> {
    return this.get<PairTicker[]>("/v1/aggregated/ticker");
  }

  /**
   * Fetch aggregated trades for a pair (CoinGecko-compatible).
   * @param marketPair - The market pair (e.g., `"fFUEL_fUSDC"`).
   */
  async getAggregatedTrades(marketPair: string): Promise<Trade[]> {
    const raw = await this.get<Record<string, unknown>[]>("/v1/aggregated/trades", {
      market_pair: marketPair,
    });
    return raw.map(parseTrade);
  }

  // ── Faucet ──────────────────────────────────────────────────────

  /**
   * Mint test tokens to an address (testnet/devnet only).
   * @param address - The destination address.
   * @throws {@link O2Error} if faucet is not available on this network.
   */
  async mintToAddress(address: string): Promise<FaucetResponse> {
    if (!this.faucetUrl) {
      throw new O2Error("Faucet is not available on this network");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.faucetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
        signal: controller.signal,
      });
      return (await resp.json()) as FaucetResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Mint test tokens to a contract (testnet/devnet only).
   * @param contractId - The destination contract ID.
   * @throws {@link O2Error} if faucet is not available on this network.
   */
  async mintToContract(contractId: TradeAccountId): Promise<FaucetResponse> {
    if (!this.faucetUrl) {
      throw new O2Error("Faucet is not available on this network");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.faucetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: contractId }),
        signal: controller.signal,
      });
      return (await resp.json()) as FaucetResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
