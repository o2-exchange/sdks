/**
 * REST API client for O2 Exchange.
 *
 * Typed wrappers for every REST endpoint. Returns typed response objects.
 * Raises O2Error exceptions with error code from Section 8.
 * Includes retry logic for rate limits (error 1003).
 */

import type { NetworkConfig } from "./config.js";
import type {
  MarketsResponse,
  MarketSummary,
  MarketTicker,
  DepthSnapshot,
  Trade,
  Bar,
  AccountInfo,
  CreateAccountResponse,
  BalanceResponse,
  OrdersResponse,
  Order,
  SessionRequest,
  SessionResponse,
  SessionActionsRequest,
  SessionActionsResponse,
  WithdrawRequest,
  WithdrawResponse,
  WhitelistResponse,
  ReferralInfo,
  FaucetResponse,
  AggregatedAsset,
  AggregatedOrderbook,
  PairSummary,
  PairTicker,
  Identity,
} from "./models.js";
import {
  O2Error,
  RateLimitExceeded,
  parseApiError,
  isActionsSuccess,
} from "./errors.js";

export interface O2ApiOptions {
  config: NetworkConfig;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class O2Api {
  private readonly baseUrl: string;
  private readonly faucetUrl: string | null;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: O2ApiOptions) {
    this.baseUrl = options.config.apiBase;
    this.faucetUrl = options.config.faucetUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  // ── Internal HTTP helpers ───────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean | undefined>;
    } = {}
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
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        const body = (await resp.json()) as Record<string, unknown>;

        if (!resp.ok) {
          const err = parseApiError(body);
          if (err instanceof RateLimitExceeded && attempt < this.maxRetries) {
            const delay =
              this.retryDelayMs * Math.pow(2, attempt) * (0.5 + Math.random());
            await sleep(delay);
            lastError = err;
            continue;
          }
          throw err;
        }

        return body as T;
      } catch (error) {
        if (error instanceof O2Error) throw error;
        lastError = error as Error;
        if (attempt < this.maxRetries) {
          const delay =
            this.retryDelayMs * Math.pow(2, attempt) * (0.5 + Math.random());
          await sleep(delay);
          continue;
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("GET", path, { query, headers });
  }

  private async post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("POST", path, { body, headers });
  }

  private async put<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("PUT", path, { body, headers });
  }

  // ── Market Data ─────────────────────────────────────────────────

  async getMarkets(): Promise<MarketsResponse> {
    return this.get<MarketsResponse>("/v1/markets");
  }

  async getMarketSummary(marketId: string): Promise<MarketSummary> {
    return this.get<MarketSummary>("/v1/markets/summary", {
      market_id: marketId,
    });
  }

  async getMarketTicker(marketId: string): Promise<MarketTicker> {
    return this.get<MarketTicker>("/v1/markets/ticker", {
      market_id: marketId,
    });
  }

  async getDepth(marketId: string, precision = 10): Promise<DepthSnapshot> {
    const data = await this.get<Record<string, unknown>>("/v1/depth", {
      market_id: marketId,
      precision,
    });
    // API wraps depth in "orders" or "view" field; unwrap it
    const depth = (data.orders ?? data.view ?? data) as DepthSnapshot;
    return depth;
  }

  // ── Trading Data ────────────────────────────────────────────────

  async getTrades(
    marketId: string,
    direction: "asc" | "desc" = "desc",
    count = 50,
    startTimestamp?: number,
    startTradeId?: string
  ): Promise<Trade[]> {
    const data = await this.get<Trade[] | { trades: Trade[] }>("/v1/trades", {
      market_id: marketId,
      direction,
      count,
      start_timestamp: startTimestamp,
      start_trade_id: startTradeId,
    });
    return Array.isArray(data) ? data : data.trades;
  }

  async getTradesByAccount(
    marketId: string,
    contract: string,
    direction: "asc" | "desc" = "desc",
    count = 50,
    startTimestamp?: number,
    startTradeId?: string
  ): Promise<Trade[]> {
    return this.get<Trade[]>("/v1/trades_by_account", {
      market_id: marketId,
      contract,
      direction,
      count,
      start_timestamp: startTimestamp,
      start_trade_id: startTradeId,
    });
  }

  async getBars(
    marketId: string,
    from: number,
    to: number,
    resolution: string
  ): Promise<Bar[]> {
    return this.get<Bar[]>("/v1/bars", {
      market_id: marketId,
      from,
      to,
      resolution,
    });
  }

  // ── Account & Balance ───────────────────────────────────────────

  async createAccount(identity: Identity): Promise<CreateAccountResponse> {
    return this.post<CreateAccountResponse>("/v1/accounts", { identity });
  }

  async getAccount(params: {
    owner?: string;
    ownerContract?: string;
    tradeAccountId?: string;
  }): Promise<AccountInfo> {
    return this.get<AccountInfo>("/v1/accounts", {
      owner: params.owner,
      owner_contract: params.ownerContract,
      trade_account_id: params.tradeAccountId,
    });
  }

  async getBalance(
    assetId: string,
    params: { address?: string; contract?: string }
  ): Promise<BalanceResponse> {
    return this.get<BalanceResponse>("/v1/balance", {
      asset_id: assetId,
      address: params.address,
      contract: params.contract,
    });
  }

  // ── Orders ──────────────────────────────────────────────────────

  async getOrders(
    marketId: string,
    contract: string,
    direction: "asc" | "desc" = "desc",
    count = 20,
    isOpen?: boolean,
    startTimestamp?: number,
    startOrderId?: string
  ): Promise<OrdersResponse> {
    return this.get<OrdersResponse>("/v1/orders", {
      market_id: marketId,
      contract,
      direction,
      count,
      is_open: isOpen,
      start_timestamp: startTimestamp,
      start_order_id: startOrderId,
    });
  }

  async getOrder(marketId: string, orderId: string): Promise<Order> {
    const data = await this.get<{ order?: Order } & Order>("/v1/order", {
      market_id: marketId,
      order_id: orderId,
    });
    // API wraps order in an "order" key
    return (data as any).order ?? data;
  }

  // ── Session Management ──────────────────────────────────────────

  async createSession(
    ownerId: string,
    request: SessionRequest
  ): Promise<SessionResponse> {
    return this.put<SessionResponse>("/v1/session", request, {
      "O2-Owner-Id": ownerId,
    });
  }

  async submitActions(
    ownerId: string,
    request: SessionActionsRequest
  ): Promise<SessionActionsResponse> {
    const body = await this.request<Record<string, unknown>>(
      "POST",
      "/v1/session/actions",
      {
        body: request,
        headers: { "O2-Owner-Id": ownerId },
      }
    );

    if (isActionsSuccess(body)) {
      return body as unknown as SessionActionsResponse;
    }

    throw parseApiError(body);
  }

  // ── Account Operations ──────────────────────────────────────────

  async withdraw(
    ownerId: string,
    request: WithdrawRequest
  ): Promise<WithdrawResponse> {
    return this.post<WithdrawResponse>("/v1/accounts/withdraw", request, {
      "O2-Owner-Id": ownerId,
    });
  }

  // ── Analytics ───────────────────────────────────────────────────

  async whitelistAccount(tradeAccountId: string): Promise<WhitelistResponse> {
    return this.post<WhitelistResponse>("/analytics/v1/whitelist", {
      tradeAccount: tradeAccountId,
    });
  }

  async getReferralInfo(code: string): Promise<ReferralInfo> {
    return this.get<ReferralInfo>("/analytics/v1/referral/code-info", { code });
  }

  // ── Aggregated ──────────────────────────────────────────────────

  async getAggregatedAssets(): Promise<AggregatedAsset[]> {
    return this.get<AggregatedAsset[]>("/v1/aggregated/assets");
  }

  async getAggregatedOrderbook(
    marketPair: string,
    depth = 500,
    level = 2
  ): Promise<AggregatedOrderbook> {
    return this.get<AggregatedOrderbook>("/v1/aggregated/orderbook", {
      market_pair: marketPair,
      depth,
      level,
    });
  }

  async getAggregatedSummary(): Promise<PairSummary[]> {
    return this.get<PairSummary[]>("/v1/aggregated/summary");
  }

  async getAggregatedTicker(): Promise<PairTicker[]> {
    return this.get<PairTicker[]>("/v1/aggregated/ticker");
  }

  async getAggregatedTrades(marketPair: string): Promise<Trade[]> {
    return this.get<Trade[]>("/v1/aggregated/trades", {
      market_pair: marketPair,
    });
  }

  // ── Faucet ──────────────────────────────────────────────────────

  async mintToAddress(address: string): Promise<FaucetResponse> {
    if (!this.faucetUrl) {
      throw new O2Error("Faucet is not available on this network");
    }
    const resp = await fetch(this.faucetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    return (await resp.json()) as FaucetResponse;
  }

  async mintToContract(contractId: string): Promise<FaucetResponse> {
    if (!this.faucetUrl) {
      throw new O2Error("Faucet is not available on this network");
    }
    const resp = await fetch(this.faucetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract: contractId }),
    });
    return (await resp.json()) as FaucetResponse;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
