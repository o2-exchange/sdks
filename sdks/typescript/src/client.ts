/**
 * High-level O2Client for the O2 Exchange.
 *
 * The {@link O2Client} is the main entry point for the O2 SDK. It orchestrates
 * wallet management, account lifecycle, session management, trading,
 * market data, and WebSocket streaming — handling all encoding, signing,
 * and nonce management automatically.
 *
 * @example
 * ```ts
 * import { O2Client, Network } from "@o2exchange/sdk";
 *
 * const client = new O2Client({ network: Network.TESTNET });
 * const wallet = O2Client.generateWallet();
 * await client.setupAccount(wallet);
 * await client.createSession(wallet, ["fFUEL/fUSDC"]);
 * const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
 * console.log(`Order TX: ${response.txId}`);
 * client.close();
 * ```
 *
 * @module
 */

import type { Action, MarketActionGroup, Numeric } from "./actions.js";
import { O2Api } from "./api.js";
import { getNetworkConfig, Network, type NetworkConfig } from "./config.js";
import {
  bytesToHex,
  evmPersonalSign,
  evmWalletFromPrivateKey,
  generateEvmWallet,
  generateWallet,
  hexToBytes,
  personalSign,
  rawSign,
  type Signer,
  walletFromPrivateKey,
} from "./crypto.js";
import {
  type ActionJSON,
  actionToCall,
  adjustQuantityForFractionalPrice,
  buildActionsSigningBytes,
  buildSessionSigningBytes,
  buildWithdrawSigningBytes,
  type ContractCall,
  type MarketInfo,
  scaleDecimalString,
  scalePriceString,
  validateFractionalPrice,
  validateMinOrder,
} from "./encoding.js";
import { O2Error, SessionExpired } from "./errors.js";
import type {
  ActionPayload,
  AssetId,
  BalanceResponse,
  BalanceUpdate,
  Bar,
  DepthSnapshot,
  DepthUpdate,
  FaucetResponse,
  Identity,
  Market,
  MarketActions,
  MarketRef,
  MarketsResponse,
  NonceUpdate,
  Order,
  OrderId,
  OrderType,
  OrderUpdate,
  SessionActionsResponse,
  SessionState,
  TradeAccountId,
  TradeUpdate,
  WalletState,
} from "./models.js";
import { depthPrecision, tradeAccountId } from "./models.js";
import {
  capitalizeSide,
  ensureNumeric,
  resolveAsset as resolveAssetFromMarkets,
  resolveMarket as resolveMarketFromMarkets,
  scaleOrderType,
} from "./utils.js";
import { type ConnectionEvent, O2WebSocket } from "./websocket.js";

const DEFAULT_MARKETS_CACHE_TTL_MS = 60_000;

/** Convert a wire-format Market to the MarketInfo used by encoding helpers. */
function toMarketInfo(market: Market): MarketInfo {
  return {
    contractId: market.contract_id,
    marketId: market.market_id,
    base: {
      asset: market.base.asset,
      decimals: market.base.decimals,
      maxPrecision: market.base.max_precision,
      symbol: market.base.symbol,
    },
    quote: {
      asset: market.quote.asset,
      decimals: market.quote.decimals,
      maxPrecision: market.quote.max_precision,
      symbol: market.quote.symbol,
    },
  };
}

/**
 * Options for constructing an {@link O2Client}.
 *
 * Provide either `network` (to use a pre-configured environment) or
 * `config` (for custom endpoint configuration). If neither is provided,
 * defaults to `Network.TESTNET`.
 */
export interface O2ClientOptions {
  /** The network environment to connect to (default: `Network.TESTNET`). */
  network?: Network;
  /** Custom network configuration (overrides `network`). */
  config?: NetworkConfig;
  /** Markets cache TTL in milliseconds (default: `60_000`). */
  marketsCacheTtlMs?: number;
  /**
   * Optional WebSocket factory for custom runtimes/tests.
   * Defaults to `globalThis.WebSocket`.
   */
  webSocketFactory?: (url: string) => WebSocket;
}

/**
 * Options for {@link O2Client.createOrder}.
 */
export interface CreateOrderOptions {
  /** Order type (default: `"Spot"`). */
  orderType?: OrderType;
  /** Whether to settle balance before ordering (default: `true`). */
  settleFirst?: boolean;
  /** Whether to return order details in response (default: `true`). */
  collectOrders?: boolean;
  /** Explicit session to use for this order. Defaults to the client's active session. */
  session?: SessionState;
}

/**
 * High-level client for the O2 Exchange.
 *
 * Orchestrates wallet management, account lifecycle, session creation,
 * trading (with automatic encoding and signing), market data retrieval,
 * and real-time WebSocket streaming.
 *
 * @example
 * ```ts
 * const client = new O2Client({ network: Network.TESTNET });
 * const wallet = O2Client.generateWallet();
 * await client.setupAccount(wallet);
 * ```
 */
/**
 * Validate that a REST depth precision value is within the supported range (1--18).
 * @throws {Error} If `precision` is outside the valid range.
 */
function validateDepthPrecision(precision: number | string): void {
  const p = typeof precision === "string" ? Number.parseInt(precision, 10) : precision;
  if (!Number.isFinite(p) || p < 1 || p > 18) {
    throw new Error(
      `Invalid depth precision ${precision}. Valid range: 1-18 (powers of 10). ` +
        "Precision 0 is not supported — use getDepth() via REST for exact prices.",
    );
  }
}

export class O2Client {
  /** The underlying low-level REST API client. */
  readonly api: O2Api;
  protected wsClient: O2WebSocket | null = null;
  /** Network endpoint and contract configuration used by this client. */
  public readonly config: NetworkConfig;
  protected marketsCache: MarketsResponse | null = null;
  protected marketsCacheTime = 0;
  protected marketsRefreshPromise: Promise<MarketsResponse> | null = null;
  protected readonly marketsCacheTtlMs: number;
  protected readonly webSocketFactory?: (url: string) => WebSocket;
  protected _session: SessionState | null = null;

  constructor(optionsOrNetwork: O2ClientOptions | Network = {}) {
    const options: O2ClientOptions =
      typeof optionsOrNetwork === "string" ? { network: optionsOrNetwork } : optionsOrNetwork;
    this.config = options.config ?? getNetworkConfig(options.network ?? Network.TESTNET);
    this.api = new O2Api({ config: this.config });
    this.marketsCacheTtlMs = options.marketsCacheTtlMs ?? DEFAULT_MARKETS_CACHE_TTL_MS;
    this.webSocketFactory = options.webSocketFactory;
  }

  /** The active trading session, or `null` if no session has been created. */
  get session(): SessionState | null {
    return this._session;
  }

  /** Restore a pre-existing session (e.g., from serialized state). */
  setSession(session: SessionState): void {
    this._session = session;
  }

  /** Clear the active session. */
  clearSession(): void {
    this._session = null;
  }

  /** Returns the stored session or throws if none exists. */
  protected ensureSession(): SessionState {
    if (!this._session) {
      throw new O2Error(
        "No active session. Call createSession() to create a new session, " +
          "or setSession() to restore an existing one.",
      );
    }
    return this._session;
  }

  // ── Wallet management (static) ────────────────────────────────────

  /**
   * Generate a new Fuel-native secp256k1 wallet.
   *
   * @returns A new wallet state with a random private key.
   *
   * @example
   * ```ts
   * const wallet = O2Client.generateWallet();
   * console.log(wallet.b256Address); // "0x..."
   * ```
   */
  static generateWallet(): WalletState {
    const w = generateWallet();
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: false,
      personalSign: (message: Uint8Array) => personalSign(w.privateKey, message),
    };
  }

  /**
   * Generate a new EVM-compatible secp256k1 wallet.
   *
   * @returns A new wallet state with EVM address and zero-padded b256 address.
   */
  static generateEvmWallet(): WalletState {
    const w = generateEvmWallet();
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: true,
      evmAddress: w.evmAddress,
      personalSign: (message: Uint8Array) => evmPersonalSign(w.privateKey, message),
    };
  }

  /**
   * Load a Fuel-native wallet from a private key hex string.
   *
   * @param privateKeyHex - The private key as a 0x-prefixed hex string.
   * @returns The loaded wallet state.
   */
  static loadWallet(privateKeyHex: string): WalletState {
    const w = walletFromPrivateKey(privateKeyHex);
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: false,
      personalSign: (message: Uint8Array) => personalSign(w.privateKey, message),
    };
  }

  /**
   * Load an EVM-compatible wallet from a private key hex string.
   *
   * @param privateKeyHex - The private key as a 0x-prefixed hex string.
   * @returns The loaded wallet state with EVM address.
   */
  static loadEvmWallet(privateKeyHex: string): WalletState {
    const w = evmWalletFromPrivateKey(privateKeyHex);
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: true,
      evmAddress: w.evmAddress,
      personalSign: (message: Uint8Array) => evmPersonalSign(w.privateKey, message),
    };
  }

  // ── Account lifecycle ───────────────────────────────────────────

  /**
   * Idempotent account setup. Safe to call on every bot startup.
   *
   * 1. Check if account exists
   * 2. Create if needed
   * 3. Mint via faucet (testnet/devnet) - non-fatal on cooldown
   * 4. Whitelist account
   * 5. Return trade_account_id and nonce
   */
  async setupAccount(wallet: Signer): Promise<{ tradeAccountId: TradeAccountId; nonce: bigint }> {
    // 1. Check if account already exists
    const existing = await this.api.getAccount({ owner: wallet.b256Address });

    let tradeAccountId: TradeAccountId;

    if (existing.trade_account_id) {
      tradeAccountId = existing.trade_account_id;
    } else {
      // 2. Create account
      const created = await this.api.createAccount({
        Address: wallet.b256Address,
      });
      tradeAccountId = created.trade_account_id;
    }

    // 3. Mint via faucet if available (non-fatal)
    if (this.config.faucetUrl) {
      try {
        await this.api.mintToContract(tradeAccountId);
      } catch (_e: unknown) {
        // Faucet cooldown or error — not fatal for idempotent setup
      }
    }

    // 4. Whitelist (idempotent — returns alreadyWhitelisted:true on repeat)
    try {
      await this.api.whitelistAccount(tradeAccountId);
    } catch (_e: unknown) {
      // Whitelist error — not fatal on repeat calls
    }

    // 5. Get current nonce
    const info = await this.api.getAccount({ tradeAccountId });
    const nonce = info.trade_account?.nonce ?? 0n;

    return { tradeAccountId, nonce };
  }

  /**
   * Mint test assets from faucet directly to the owner's trading account contract.
   *
   * This is useful for explicit testnet/devnet top-ups after account setup.
   *
   * @param wallet - The owner wallet.
   * @returns Faucet mint response.
   * @throws {@link O2Error} if no trade account exists or faucet is unavailable.
   */
  async topUpFromFaucet(wallet: Signer): Promise<FaucetResponse> {
    const accountInfo = await this.api.getAccount({ owner: wallet.b256Address });
    const tradeAccountId = accountInfo.trade_account_id;
    if (!tradeAccountId) {
      throw new O2Error("No trade account found for this wallet. Call setupAccount() first.");
    }
    return this.api.mintToContract(tradeAccountId);
  }

  // ── Session management ──────────────────────────────────────────

  /**
   * Create a trading session.
   *
   * The trade account ID is resolved automatically from the wallet address.
   *
   * @param wallet - The owner wallet.
   * @param markets - Market pairs or Market objects to authorize.
   * @param expiryDays - Session expiry in days (default: 30).
   */
  async createSession(
    wallet: Signer,
    markets: MarketRef[],
    expiryDays = 30,
  ): Promise<SessionState> {
    // Resolve trade account
    const accountInfo = await this.api.getAccount({ owner: wallet.b256Address });
    const tradeAccountId = accountInfo.trade_account_id;
    if (!tradeAccountId) {
      throw new O2Error("No trade account found for this wallet. Call setupAccount() first.");
    }

    // Resolve markets
    const marketsData = await this.fetchMarkets();
    const resolvedMarkets = markets.map((m) => {
      if (typeof m === "string") return this.resolveMarket(marketsData, m);
      return m;
    });
    const contractIds = resolvedMarkets.map((m) => m.contract_id);

    // Parse chain_id
    const chainId = BigInt(
      marketsData.chain_id.startsWith("0x")
        ? Number.parseInt(marketsData.chain_id, 16)
        : marketsData.chain_id,
    );

    // Generate session keypair
    const sessionWallet = generateWallet();

    // Fetch nonce by trade account ID (owner lookups may omit trade_account state)
    const nonce = await this.getNonce(tradeAccountId);

    // Calculate expiry
    const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryDays * 24 * 60 * 60);

    // Build signing bytes
    const contractIdBytes = contractIds.map((id) => hexToBytes(id));
    const signingBytes = buildSessionSigningBytes(
      nonce,
      chainId,
      hexToBytes(sessionWallet.b256Address),
      contractIdBytes,
      expiry,
    );

    // Sign with owner wallet
    const signature = await wallet.personalSign(signingBytes);

    // Submit
    await this.api.createSession(wallet.b256Address, {
      contract_id: tradeAccountId,
      session_id: { Address: sessionWallet.b256Address },
      signature: { Secp256k1: bytesToHex(signature) },
      contract_ids: contractIds,
      nonce: nonce.toString(),
      expiry: expiry.toString(),
    });

    const session: SessionState = {
      ownerAddress: wallet.b256Address,
      tradeAccountId,
      sessionPrivateKey: sessionWallet.privateKey,
      sessionAddress: sessionWallet.b256Address,
      contractIds,
      expiry: Number(expiry),
      nonce: nonce + 1n, // Nonce increments after session creation
    };

    this._session = session;
    return session;
  }

  // ── Trading ─────────────────────────────────────────────────────

  /**
   * Create an order with automatic encoding, signing, and nonce management.
   *
   * Price and quantity accept dual-mode {@link Numeric} values:
   * - `string` — human-readable decimal (e.g., `"0.02"`, `"100"`) — auto-scaled
   * - `bigint` — raw chain integer (e.g., `20000000n`) — pass-through
   *
   * @param market - Market pair string or Market object.
   * @param side - Order side (`"buy"` or `"sell"`).
   * @param price - Order price as decimal string or raw bigint.
   * @param quantity - Order quantity as decimal string or raw bigint.
   * @param options - Optional order parameters.
   */
  async createOrder(
    market: MarketRef,
    side: "buy" | "sell",
    price: Numeric,
    quantity: Numeric,
    options?: CreateOrderOptions,
  ): Promise<SessionActionsResponse> {
    const session = options?.session ?? this.ensureSession();
    const orderType = options?.orderType ?? "Spot";
    const settleFirst = options?.settleFirst ?? true;
    const collectOrders = options?.collectOrders ?? true;

    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;
    const { scaledPrice, scaledQuantity } = this.normalizeCreateOrderValues(
      resolved,
      price,
      quantity,
      "price",
      "quantity",
    );

    // Build actions
    const actions: ActionPayload[] = [];

    if (settleFirst) {
      actions.push({
        SettleBalance: {
          to: { ContractId: session.tradeAccountId },
        },
      });
    }

    actions.push({
      CreateOrder: {
        side: capitalizeSide(side),
        price: scaledPrice.toString(),
        quantity: scaledQuantity.toString(),
        order_type: scaleOrderType(orderType, resolved),
      },
    });

    return this.submitBatch([{ market_id: resolved.market_id, actions }], collectOrders, session);
  }

  /** Cancel an order. The session nonce is updated in-place. */
  async cancelOrder(
    orderId: OrderId,
    market: MarketRef,
    session?: SessionState,
  ): Promise<SessionActionsResponse> {
    const activeSession = session ?? this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.submitBatch(
      [
        {
          market_id: resolved.market_id,
          actions: [{ CancelOrder: { order_id: orderId } }],
        },
      ],
      false,
      activeSession,
    );
  }

  /**
   * Cancel all open orders for a market. Returns one result per chunk, or null if no orders.
   */
  async cancelAllOrders(
    market: MarketRef,
    session?: SessionState,
  ): Promise<SessionActionsResponse[] | null> {
    const activeSession = session ?? this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    const orders = await this.api.getOrders(
      resolved.market_id,
      activeSession.tradeAccountId,
      "desc",
      200,
      true,
    );

    if (orders.orders.length === 0) return null;

    const results: SessionActionsResponse[] = [];

    // Process in chunks of 5 (max actions per batch)
    for (let i = 0; i < orders.orders.length; i += 5) {
      const chunk = orders.orders.slice(i, i + 5);
      const cancelActions: ActionPayload[] = chunk.map((o) => ({
        CancelOrder: { order_id: o.order_id },
      }));

      const result = await this.submitBatch(
        [{ market_id: resolved.market_id, actions: cancelActions }],
        false,
        activeSession,
      );
      results.push(result);
    }

    return results;
  }

  /** Settle balance for a market. The session nonce is updated in-place. */
  async settleBalance(market: MarketRef, session?: SessionState): Promise<SessionActionsResponse> {
    const activeSession = session ?? this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.submitBatch(
      [
        {
          market_id: resolved.market_id,
          actions: [
            {
              SettleBalance: {
                to: { ContractId: activeSession.tradeAccountId },
              },
            },
          ],
        },
      ],
      false,
      activeSession,
    );
  }

  /**
   * Submit a batch of type-safe actions grouped by market.
   *
   * This is the primary batch interface. Actions use the {@link Action} union
   * with dual-mode {@link Numeric} values — string decimals are auto-scaled,
   * bigint values pass through directly.
   *
   * Market resolution, price/quantity scaling, FractionalPrice adjustment,
   * min_order validation, and accounts registry lookup are all handled internally.
   *
   * @param marketActions - Groups of actions per market.
   * @param collectOrders - Whether to return order details in response (default: `false`).
   * @param session - Explicit session to use. Defaults to the client's active session.
   *
   * @example
   * ```ts
   * await client.batchActions([
   *   { market: "fFUEL/fUSDC", actions: [
   *     settleBalanceAction(),
   *     createOrderAction("buy", "0.02", "100"),
   *     createOrderAction("sell", "0.05", "50", "PostOnly"),
   *   ]}
   * ], true);
   * ```
   */
  async batchActions(
    marketActions: MarketActionGroup[],
    collectOrders = false,
    session?: SessionState,
  ): Promise<SessionActionsResponse> {
    const activeSession = session ?? this.ensureSession();
    const marketsData = await this.fetchMarkets();

    // Convert type-safe actions to wire format
    const wireGroups: MarketActions[] = [];

    for (const group of marketActions) {
      const resolved =
        typeof group.market === "string"
          ? this.resolveMarket(marketsData, group.market)
          : group.market;

      const wireActions: ActionPayload[] = [];
      for (const action of group.actions) {
        wireActions.push(this.actionToPayload(action, resolved, activeSession));
      }

      wireGroups.push({
        market_id: resolved.market_id,
        actions: wireActions,
      });
    }

    if (wireGroups.length === 0) {
      throw new O2Error("No market actions provided");
    }

    return this.submitBatch(wireGroups, collectOrders, activeSession);
  }

  // ── Market data ─────────────────────────────────────────────────

  /** Fetch all available markets. Results are cached with stale-while-revalidate. */
  async getMarkets(): Promise<Market[]> {
    const data = await this.fetchMarkets();
    return data.markets;
  }

  /**
   * Resolve a market by symbol pair (e.g., `"fFUEL/fUSDC"`) or hex market ID.
   *
   * @param symbolPair - The market pair or hex ID.
   * @throws {@link O2Error} if the market is not found.
   */
  async getMarket(symbolPair: string): Promise<Market> {
    const data = await this.fetchMarkets();
    return this.resolveMarket(data, symbolPair);
  }

  /**
   * Fetch the order book depth snapshot.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param precision - Price grouping level, from `1` (most precise) to `18`
   *   (most grouped). Default `1`. At level 1, prices are at or near their
   *   exact values. Higher levels round prices into larger buckets — useful
   *   for a visual depth chart but too coarse for trading. Same scale as
   *   {@link streamDepth}.
   * @param limit - Maximum number of price levels per side (bids/asks).
   *   `undefined` (default) returns the full order book.
   * @throws {Error} If `precision` is outside the valid range 1--18.
   */
  async getDepth(market: MarketRef, precision = 1, limit?: number): Promise<DepthSnapshot> {
    validateDepthPrecision(precision);
    const wirePrecision = 10 ** precision;
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getDepth(marketId, wirePrecision, limit);
  }

  /**
   * Fetch recent trades for a market.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param count - Number of trades to return (default: 50, max 50).
   * @param account - Optional trade account ID to filter trades for a specific account.
   * @param cursor - Optional pagination cursor. Pass the `timestamp` and `trade_id`
   *   from the last trade of the previous page.
   */
  async getTrades(
    market: MarketRef,
    count = 50,
    account?: string | TradeAccountId,
    cursor?: { startTimestamp: number; startTradeId: string },
  ) {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    if (account) {
      const validAccount = tradeAccountId(account);
      return this.api.getTradesByAccount(
        marketId,
        validAccount,
        "desc",
        count,
        cursor?.startTimestamp,
        cursor?.startTradeId,
      );
    }
    return this.api.getTrades(
      marketId,
      "desc",
      count,
      cursor?.startTimestamp,
      cursor?.startTradeId,
    );
  }

  /**
   * Fetch OHLCV candlestick bars.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param resolution - Bar resolution (e.g., `"1m"`, `"1h"`, `"1d"`).
   * @param from - Start time in **milliseconds** (not seconds).
   * @param to - End time in **milliseconds** (not seconds).
   */
  async getBars(market: MarketRef, resolution: string, from: number, to: number): Promise<Bar[]> {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getBars(marketId, from, to, resolution);
  }

  /**
   * Fetch real-time ticker data for a market.
   *
   * @param market - Market pair string or {@link Market} object.
   */
  async getTicker(market: MarketRef) {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getMarketTicker(marketId);
  }

  // ── Account data ────────────────────────────────────────────────

  /**
   * Get balances for a trade account, keyed by symbol.
   */
  async getBalances(tradeAccountId: TradeAccountId): Promise<Record<string, BalanceResponse>> {
    const marketsData = await this.fetchMarkets();
    const result: Record<string, BalanceResponse> = {};

    // Collect unique assets
    const assets = new Map<AssetId, string>();
    for (const m of marketsData.markets) {
      assets.set(m.base.asset, m.base.symbol);
      assets.set(m.quote.asset, m.quote.symbol);
    }

    for (const [assetId, symbol] of assets) {
      try {
        const balance = await this.api.getBalance(assetId, {
          contract: tradeAccountId,
        });
        result[symbol] = balance;
      } catch (_e: unknown) {
        // Skip assets that fail (e.g. zero balance returns 404)
      }
    }

    return result;
  }

  /**
   * Fetch orders for an account on a market.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param tradeAccountId - The trade account contract ID.
   * @param isOpen - Filter by open/closed status.
   * @param count - Number of orders (default: 20, max 200).
   * @param cursor - Optional pagination cursor. Pass the `timestamp` and `order_id`
   *   from the last order of the previous page.
   */
  async getOrders(
    market: MarketRef,
    tradeAccountId: TradeAccountId,
    isOpen?: boolean,
    count = 20,
    cursor?: { startTimestamp: number; startOrderId: string },
  ): Promise<Order[]> {
    const resolved = typeof market === "string" ? await this.getMarket(market) : market;
    const resp = await this.api.getOrders(
      resolved.market_id,
      tradeAccountId,
      "desc",
      count,
      isOpen,
      cursor?.startTimestamp,
      cursor?.startOrderId as OrderId | undefined,
    );
    return resp.orders;
  }

  /**
   * Fetch a single order by ID.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param orderId - The order identifier.
   */
  async getOrder(market: MarketRef, orderId: OrderId): Promise<Order> {
    const resolved = typeof market === "string" ? await this.getMarket(market) : market;
    return this.api.getOrder(resolved.market_id, orderId);
  }

  // ── WebSocket streaming ─────────────────────────────────────────

  protected async ensureWs(): Promise<O2WebSocket> {
    if (this.wsClient?.isTerminated()) {
      this.wsClient = null;
    }
    if (!this.wsClient) {
      this.wsClient = new O2WebSocket({
        config: this.config,
        webSocketFactory: this.webSocketFactory,
      });
      await this.wsClient.connect();
    }
    return this.wsClient;
  }

  /**
   * Stream WebSocket connection lifecycle events.
   *
   * Yields {@link ConnectionEvent} objects whenever the connection state
   * changes (connected, disconnected, reconnecting, reconnected, closed).
   *
   * Use this to detect reconnects and re-sync critical state from the
   * REST API — messages during the disconnect window are lost.
   *
   * @example
   * ```ts
   * for await (const event of client.streamLifecycle()) {
   *   if (event.state === "reconnected") {
   *     const balances = await client.getBalances(account);
   *   } else if (event.state === "closed") {
   *     break;
   *   }
   * }
   * ```
   */
  async streamLifecycle(): Promise<AsyncGenerator<ConnectionEvent>> {
    const ws = await this.ensureWs();
    return ws.streamLifecycle();
  }

  /**
   * Stream real-time order book depth updates.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param precision - Price grouping level, from `1` (most precise) to `18`
   *   (most grouped). Default `1`. At level 1, prices are at or near their
   *   exact values. Higher levels round prices into larger buckets. Same
   *   scale as {@link getDepth}.
   * @returns An async generator yielding {@link DepthUpdate} messages.
   * @throws {Error} If `precision` is outside the valid range 1--18.
   */
  async streamDepth(market: MarketRef, precision = 1): Promise<AsyncGenerator<DepthUpdate>> {
    const dp = depthPrecision(precision);
    const ws = await this.ensureWs();
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return ws.streamDepth(marketId, dp);
  }

  /**
   * Stream real-time order updates for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   * @returns An async generator yielding {@link OrderUpdate} messages.
   */
  async streamOrders(tradeAccountId: TradeAccountId): Promise<AsyncGenerator<OrderUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamOrders([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time trades for a market.
   *
   * @param market - Market pair string or {@link Market} object.
   * @returns An async generator yielding {@link TradeUpdate} messages.
   */
  async streamTrades(market: MarketRef): Promise<AsyncGenerator<TradeUpdate>> {
    const ws = await this.ensureWs();
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return ws.streamTrades(marketId);
  }

  /**
   * Stream real-time balance updates for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   * @returns An async generator yielding {@link BalanceUpdate} messages.
   */
  async streamBalances(tradeAccountId: TradeAccountId): Promise<AsyncGenerator<BalanceUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamBalances([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time nonce updates for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   * @returns An async generator yielding {@link NonceUpdate} messages.
   */
  async streamNonce(tradeAccountId: TradeAccountId): Promise<AsyncGenerator<NonceUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamNonce([{ ContractId: tradeAccountId }]);
  }

  /** Disconnect WebSocket if connected. */
  disconnectWs(): void {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
  }

  /** Close all connections and release resources. */
  close(): void {
    this.disconnectWs();
    this.marketsCache = null;
    this.marketsRefreshPromise = null;
  }

  /** Enables `await using client = new O2Client(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  // ── Withdrawals ─────────────────────────────────────────────────

  /**
   * Withdraw funds from trading account to owner wallet.
   *
   * @param wallet - The owner wallet (not session key).
   * @param asset - Asset symbol (e.g., `"fUSDC"`) or hex asset ID.
   * @param amount - Amount as human-readable string or raw bigint.
   * @param to - Destination identity, or an address string (defaults to wallet address).
   */
  async withdraw(wallet: Signer, asset: string, amount: Numeric, to?: Identity | string) {
    // Resolve trade account from wallet
    const accountInfo = await this.api.getAccount({ owner: wallet.b256Address });
    const tradeAccountId = accountInfo.trade_account_id;
    if (!tradeAccountId) {
      throw new O2Error("No trade account found for this wallet. Call setupAccount() first.");
    }

    // Fetch nonce by trade account ID (owner lookups may omit trade_account state)
    const nonce = await this.getNonce(tradeAccountId);

    const marketsData = await this.fetchMarkets();
    const chainIdRaw = marketsData.chain_id;
    const chainId = BigInt(
      chainIdRaw.startsWith("0x") ? Number.parseInt(chainIdRaw, 16) : chainIdRaw,
    );

    // Resolve asset
    const { assetId, decimals } = this.resolveAsset(marketsData, asset);

    // Scale amount
    let scaledAmount: bigint;
    const normalizedAmount = ensureNumeric(amount, "amount");
    if (typeof normalizedAmount === "bigint") {
      scaledAmount = normalizedAmount;
    } else {
      if (decimals === undefined) {
        throw new O2Error(
          `Cannot scale string amount for unknown asset ${assetId}. Pass amount as a pre-scaled bigint, or use a known asset symbol.`,
        );
      }
      const { scaleDecimalString } = await import("./encoding.js");
      scaledAmount = scaleDecimalString(normalizedAmount, decimals);
    }

    const destination: Identity =
      typeof to === "string" ? { Address: to } : (to ?? { Address: wallet.b256Address });
    const toDiscriminant: 0 | 1 = "ContractId" in destination ? 1 : 0;
    const toAddressHex = (
      "ContractId" in destination ? destination.ContractId : destination.Address
    ) as string;

    // Build binary signing bytes matching Rust layout
    const signingBytes = buildWithdrawSigningBytes(
      nonce,
      chainId,
      toDiscriminant,
      hexToBytes(toAddressHex),
      hexToBytes(assetId),
      scaledAmount,
    );

    const signature = await wallet.personalSign(signingBytes);

    return this.api.withdraw(wallet.b256Address, {
      trade_account_id: tradeAccountId,
      signature: { Secp256k1: bytesToHex(signature) },
      nonce: nonce.toString(),
      to: destination,
      asset_id: assetId,
      amount: scaledAmount.toString(),
    });
  }

  // ── Nonce management ────────────────────────────────────────────

  /**
   * Fetch the current on-chain nonce for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   */
  async getNonce(tradeAccountId: TradeAccountId): Promise<bigint> {
    const info = await this.api.getAccount({ tradeAccountId });
    return info.trade_account?.nonce ?? 0n;
  }

  /**
   * Re-fetch the nonce from the API and update a session state.
   *
   * @remarks
   * Call this after errors to re-sync the nonce (it increments on-chain
   * even on reverts).
   *
   * @param session - Explicit session to refresh. Defaults to the client's active session.
   * @returns The fresh nonce value.
   */
  async refreshNonce(session?: SessionState): Promise<bigint> {
    const activeSession = session ?? this.ensureSession();
    const nonce = await this.getNonce(activeSession.tradeAccountId);
    activeSession.nonce = nonce;
    return nonce;
  }

  // ── Internal helpers ────────────────────────────────────────────

  protected async fetchMarkets(): Promise<MarketsResponse> {
    const now = Date.now();
    if (this.marketsCache && now - this.marketsCacheTime < this.marketsCacheTtlMs) {
      return this.marketsCache;
    }
    if (this.marketsCache) {
      // Stale — return immediately, refresh in background
      if (!this.marketsRefreshPromise) {
        this.marketsRefreshPromise = this.api.getMarkets().then(
          (data) => {
            this.marketsCache = data;
            this.marketsCacheTime = Date.now();
            this.marketsRefreshPromise = null;
            return data;
          },
          () => {
            this.marketsRefreshPromise = null;
            return this.marketsCache!;
          },
        );
      }
      return this.marketsCache;
    }
    // No cache — must block
    this.marketsCache = await this.api.getMarkets();
    this.marketsCacheTime = Date.now();
    return this.marketsCache;
  }

  protected resolveMarket(data: MarketsResponse, symbolPair: string): Market {
    return resolveMarketFromMarkets(data, symbolPair);
  }

  /** Resolve an asset by symbol name or hex asset ID. */
  protected resolveAsset(
    data: MarketsResponse,
    symbolOrId: string,
  ): { assetId: AssetId; decimals: number | undefined } {
    return resolveAssetFromMarkets(data, symbolOrId);
  }

  /**
   * Validate bigint prices against the market precision step.
   *
   * Bigint prices are treated as already-scaled chain integers.
   * They must still align to `max_precision` to avoid on-chain rejects.
   */
  protected ensureBigIntPricePrecision(price: bigint, market: Market): void {
    const precisionDelta = market.quote.decimals - market.quote.max_precision;
    const priceStep = precisionDelta <= 0 ? 1n : BigInt(10 ** precisionDelta);
    if (price % priceStep !== 0n) {
      throw new O2Error(
        `Invalid bigint price precision for ${market.base.symbol}/${market.quote.symbol}. ` +
          `Price must be a multiple of ${priceStep.toString()}. ` +
          `Pass price as a decimal string to auto-scale.`,
      );
    }
  }

  /**
   * Normalize order price/quantity inputs to chain integers.
   *
   * Bigint prices are validated against quote precision.
   * Bigint quantities are treated as already-scaled base units and pass through unchanged.
   * String quantities follow the SDK's decimal scaling rules.
   */
  public normalizeCreateOrderValues(
    market: Market,
    price: Numeric,
    quantity: Numeric,
    priceFieldName: string,
    quantityFieldName: string,
  ): { scaledPrice: bigint; scaledQuantity: bigint } {
    let scaledPrice: bigint;
    let scaledQuantity: bigint;

    const normalizedPrice = ensureNumeric(price, priceFieldName);
    if (typeof normalizedPrice === "bigint") {
      scaledPrice = normalizedPrice;
      this.ensureBigIntPricePrecision(scaledPrice, market);
    } else {
      scaledPrice = scalePriceString(
        normalizedPrice,
        market.quote.decimals,
        market.quote.max_precision,
      );
    }

    const normalizedQuantity = ensureNumeric(quantity, quantityFieldName);
    if (typeof normalizedQuantity === "bigint") {
      scaledQuantity = normalizedQuantity;
    } else {
      scaledQuantity = scaleDecimalString(normalizedQuantity, market.base.decimals);
    }

    if (!validateFractionalPrice(scaledPrice, scaledQuantity, market.base.decimals)) {
      scaledQuantity = adjustQuantityForFractionalPrice(
        scaledPrice,
        scaledQuantity,
        market.base.decimals,
      );
    }

    if (!validateMinOrder(scaledPrice, scaledQuantity, market.base.decimals, market.min_order)) {
      throw new O2Error(
        `Order value below min_order. ` +
          `(price * quantity) / 10^${market.base.decimals} must be >= ${market.min_order}`,
      );
    }

    return { scaledPrice, scaledQuantity };
  }

  /** Convert a type-safe Action to the wire-format ActionPayload. */
  protected actionToPayload(action: Action, market: Market, session?: SessionState): ActionPayload {
    const activeSession = session ?? this.ensureSession();
    switch (action.type) {
      case "createOrder": {
        const { scaledPrice, scaledQuantity } = this.normalizeCreateOrderValues(
          market,
          action.price,
          action.quantity,
          "action.price",
          "action.quantity",
        );

        return {
          CreateOrder: {
            side: capitalizeSide(action.side),
            price: scaledPrice.toString(),
            quantity: scaledQuantity.toString(),
            order_type: scaleOrderType(action.orderType ?? "Spot", market),
          },
        };
      }
      case "cancelOrder":
        return { CancelOrder: { order_id: action.orderId } };
      case "settleBalance":
        return {
          SettleBalance: {
            to: { ContractId: activeSession.tradeAccountId },
          },
        };
      case "registerReferer":
        return { RegisterReferer: { to: action.to } };
    }
  }

  /**
   * Internal batch submission. Handles encoding, signing, nonce management.
   * The selected session nonce is updated in-place after each call.
   */
  protected async submitBatch(
    marketActions: MarketActions[],
    collectOrders = false,
    session?: SessionState,
  ): Promise<SessionActionsResponse> {
    const activeSession = session ?? this.ensureSession();
    // Check session expiry before submitting on-chain
    if (activeSession.expiry > 0 && Math.floor(Date.now() / 1000) >= activeSession.expiry) {
      throw new SessionExpired();
    }

    // Look up market metadata per-group from the cache (always populated by callers).
    const cache = this.marketsCache!;
    const calls: ContractCall[] = [];
    for (const group of marketActions) {
      const market = cache.markets.find((m) => m.market_id === group.market_id);
      if (!market) throw new O2Error(`Market ${group.market_id} not found in cache`);
      const marketInfo = toMarketInfo(market);
      for (const action of group.actions) {
        calls.push(actionToCall(action as ActionJSON, marketInfo, cache.accounts_registry_id));
      }
    }

    // Build signing bytes and sign
    const signingBytes = buildActionsSigningBytes(activeSession.nonce, calls);
    const signature = rawSign(activeSession.sessionPrivateKey, signingBytes);

    try {
      const response = await this.api.submitActions(activeSession.ownerAddress, {
        actions: marketActions,
        signature: { Secp256k1: bytesToHex(signature) },
        nonce: activeSession.nonce.toString(),
        trade_account_id: activeSession.tradeAccountId,
        session_id: { Address: activeSession.sessionAddress },
        collect_orders: collectOrders,
      });

      // Increment nonce on success (preflight errors never reach the chain)
      if (!response.isPreflightError) {
        activeSession.nonce += 1n;
      }
      return response;
    } catch (error) {
      // Nonce increments on-chain even on revert
      activeSession.nonce += 1n;
      // Re-fetch nonce on error for resync
      try {
        const info = await this.api.getAccount({
          tradeAccountId: activeSession.tradeAccountId,
        });
        if (info.trade_account) {
          activeSession.nonce = info.trade_account.nonce;
        }
      } catch (_e: unknown) {
        // If re-fetch fails, keep incremented nonce
      }
      throw error;
    }
  }
}
