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
  buildActionsSigningBytes,
  buildSessionSigningBytes,
  buildWithdrawSigningBytes,
  type ContractCall,
  type MarketInfo,
  scalePriceString,
  scaleQuantityString,
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
  Market,
  MarketActions,
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
import { assetId as toAssetId } from "./models.js";
import { O2WebSocket } from "./websocket.js";

/** Capitalize side for the API wire format: "buy" → "Buy", "sell" → "Sell". */
function capitalizeSide(side: string): string {
  return side.charAt(0).toUpperCase() + side.slice(1);
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
export class O2Client {
  /** The underlying low-level REST API client. */
  readonly api: O2Api;
  private wsClient: O2WebSocket | null = null;
  private readonly config: NetworkConfig;
  private marketsCache: MarketsResponse | null = null;
  private marketsCacheTime = 0;
  private _session: SessionState | null = null;

  constructor(options: O2ClientOptions = {}) {
    this.config = options.config ?? getNetworkConfig(options.network ?? Network.TESTNET);
    this.api = new O2Api({ config: this.config });
  }

  /** The active trading session, or `null` if no session has been created. */
  get session(): SessionState | null {
    return this._session;
  }

  /** Restore a pre-existing session (e.g., from serialized state). */
  setSession(session: SessionState): void {
    this._session = session;
  }

  /** Returns the stored session or throws if none exists. */
  private ensureSession(): SessionState {
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
   * 5. Return trade_account_id
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
    markets: string[] | Market[],
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

    // Get current nonce
    const nonce = accountInfo.trade_account?.nonce ?? 0n;

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
    const signature = wallet.personalSign(signingBytes);

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
    market: string | Market,
    side: "buy" | "sell",
    price: Numeric,
    quantity: Numeric,
    options?: CreateOrderOptions,
  ): Promise<SessionActionsResponse> {
    const session = this.ensureSession();
    const orderType = options?.orderType ?? "Spot";
    const settleFirst = options?.settleFirst ?? true;
    const collectOrders = options?.collectOrders ?? true;

    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    // Scale price and quantity based on type
    let scaledPrice: bigint;
    let scaledQuantity: bigint;

    if (typeof price === "bigint") {
      scaledPrice = price;
    } else {
      scaledPrice = scalePriceString(price, resolved.quote.decimals, resolved.quote.max_precision);
    }

    if (typeof quantity === "bigint") {
      scaledQuantity = quantity;
    } else {
      scaledQuantity = scaleQuantityString(
        quantity,
        resolved.base.decimals,
        resolved.base.max_precision,
      );
    }

    // Auto-adjust quantity to satisfy FractionalPrice constraint
    if (!validateFractionalPrice(scaledPrice, scaledQuantity, resolved.base.decimals)) {
      const factor = BigInt(10 ** resolved.base.decimals);
      const product = scaledPrice * scaledQuantity;
      const remainder = product % factor;
      if (remainder !== 0n) {
        const adjustedProduct = product - remainder;
        scaledQuantity = adjustedProduct / scaledPrice;
      }
    }

    // Validate min_order
    if (
      !validateMinOrder(scaledPrice, scaledQuantity, resolved.base.decimals, resolved.min_order)
    ) {
      throw new O2Error(
        `Order value below min_order. ` +
          `(price * quantity) / 10^${resolved.base.decimals} must be >= ${resolved.min_order}`,
      );
    }

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
        order_type: orderType,
      },
    });

    return this.submitBatch(
      [{ market_id: resolved.market_id, actions }],
      resolved,
      marketsData.accounts_registry_id,
      collectOrders,
    );
  }

  /** Cancel an order. The session nonce is updated in-place. */
  async cancelOrder(orderId: OrderId, market: string | Market): Promise<SessionActionsResponse> {
    this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.submitBatch(
      [
        {
          market_id: resolved.market_id,
          actions: [{ CancelOrder: { order_id: orderId } }],
        },
      ],
      resolved,
      marketsData.accounts_registry_id,
    );
  }

  /**
   * Cancel all open orders for a market. Returns one result per chunk, or null if no orders.
   */
  async cancelAllOrders(market: string | Market): Promise<SessionActionsResponse[] | null> {
    const session = this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    const orders = await this.api.getOrders(
      resolved.market_id,
      session.tradeAccountId,
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
        resolved,
        marketsData.accounts_registry_id,
      );
      results.push(result);
    }

    return results;
  }

  /** Settle balance for a market. The session nonce is updated in-place. */
  async settleBalance(market: string | Market): Promise<SessionActionsResponse> {
    const session = this.ensureSession();
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.submitBatch(
      [
        {
          market_id: resolved.market_id,
          actions: [
            {
              SettleBalance: {
                to: { ContractId: session.tradeAccountId },
              },
            },
          ],
        },
      ],
      resolved,
      marketsData.accounts_registry_id,
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
  ): Promise<SessionActionsResponse> {
    this.ensureSession();
    const marketsData = await this.fetchMarkets();

    // Convert type-safe actions to wire format
    const wireGroups: MarketActions[] = [];
    let firstMarket: Market | null = null;

    for (const group of marketActions) {
      const resolved = this.resolveMarket(marketsData, group.market);
      if (!firstMarket) firstMarket = resolved;

      const wireActions: ActionPayload[] = [];
      for (const action of group.actions) {
        wireActions.push(this.actionToPayload(action, resolved));
      }

      wireGroups.push({
        market_id: resolved.market_id,
        actions: wireActions,
      });
    }

    if (!firstMarket) {
      throw new O2Error("No market actions provided");
    }

    return this.submitBatch(
      wireGroups,
      firstMarket,
      marketsData.accounts_registry_id,
      collectOrders,
    );
  }

  // ── Market data ─────────────────────────────────────────────────

  /** Fetch all available markets. Results are cached for 60 seconds. */
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
   */
  async getDepth(market: string | Market, precision = 10): Promise<DepthSnapshot> {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getDepth(marketId, precision);
  }

  /**
   * Fetch recent trades for a market.
   */
  async getTrades(market: string | Market, count = 50) {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getTrades(marketId, "desc", count);
  }

  /**
   * Fetch OHLCV candlestick bars.
   */
  async getBars(
    market: string | Market,
    resolution: string,
    from: number,
    to: number,
  ): Promise<Bar[]> {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getBars(marketId, from, to, resolution);
  }

  /**
   * Fetch real-time ticker data for a market.
   */
  async getTicker(market: string | Market) {
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
   */
  async getOrders(
    tradeAccountId: TradeAccountId,
    market: string | Market,
    isOpen?: boolean,
    count = 20,
  ): Promise<Order[]> {
    const resolved = typeof market === "string" ? await this.getMarket(market) : market;
    const resp = await this.api.getOrders(
      resolved.market_id,
      tradeAccountId,
      "desc",
      count,
      isOpen,
    );
    return resp.orders;
  }

  /**
   * Fetch a single order by ID.
   */
  async getOrder(market: string | Market, orderId: OrderId): Promise<Order> {
    const resolved = typeof market === "string" ? await this.getMarket(market) : market;
    return this.api.getOrder(resolved.market_id, orderId);
  }

  // ── WebSocket streaming ─────────────────────────────────────────

  private async ensureWs(): Promise<O2WebSocket> {
    if (this.wsClient?.isTerminated()) {
      this.wsClient = null;
    }
    if (!this.wsClient) {
      this.wsClient = new O2WebSocket({ config: this.config });
      await this.wsClient.connect();
    }
    return this.wsClient;
  }

  /**
   * Stream real-time order book depth updates.
   */
  async streamDepth(market: string | Market, precision = 10): Promise<AsyncGenerator<DepthUpdate>> {
    const ws = await this.ensureWs();
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return ws.streamDepth(marketId, precision);
  }

  /**
   * Stream real-time order updates for a trading account.
   */
  async streamOrders(tradeAccountId: TradeAccountId): Promise<AsyncGenerator<OrderUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamOrders([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time trades for a market.
   */
  async streamTrades(market: string | Market): Promise<AsyncGenerator<TradeUpdate>> {
    const ws = await this.ensureWs();
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return ws.streamTrades(marketId);
  }

  /**
   * Stream real-time balance updates for a trading account.
   */
  async streamBalances(tradeAccountId: TradeAccountId): Promise<AsyncGenerator<BalanceUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamBalances([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time nonce updates for a trading account.
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
   * @param to - Destination address (defaults to wallet address).
   */
  async withdraw(wallet: Signer, asset: string, amount: Numeric, to?: string) {
    // Resolve trade account from wallet
    const accountInfo = await this.api.getAccount({ owner: wallet.b256Address });
    const tradeAccountId = accountInfo.trade_account_id;
    if (!tradeAccountId) {
      throw new O2Error("No trade account found for this wallet. Call setupAccount() first.");
    }

    // Get current nonce and chain_id
    const nonce = accountInfo.trade_account?.nonce ?? 0n;

    const marketsData = await this.fetchMarkets();
    const chainIdRaw = marketsData.chain_id;
    const chainId = BigInt(
      chainIdRaw.startsWith("0x") ? Number.parseInt(chainIdRaw, 16) : chainIdRaw,
    );

    // Resolve asset
    const { assetId, decimals } = this.resolveAsset(marketsData, asset);

    // Scale amount
    let scaledAmount: bigint;
    if (typeof amount === "bigint") {
      scaledAmount = amount;
    } else {
      const { scaleDecimalString } = await import("./encoding.js");
      scaledAmount = scaleDecimalString(amount, decimals);
    }

    const destination = to ? { Address: to } : { Address: wallet.b256Address };
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

    const signature = wallet.personalSign(signingBytes);

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
   */
  async getNonce(tradeAccountId: TradeAccountId): Promise<bigint> {
    const info = await this.api.getAccount({ tradeAccountId });
    return info.trade_account?.nonce ?? 0n;
  }

  /**
   * Re-fetch the nonce from the API and update the stored session state.
   */
  async refreshNonce(): Promise<bigint> {
    const session = this.ensureSession();
    const nonce = await this.getNonce(session.tradeAccountId);
    session.nonce = nonce;
    return nonce;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async fetchMarkets(): Promise<MarketsResponse> {
    const now = Date.now();
    // Cache for 60 seconds
    if (this.marketsCache && now - this.marketsCacheTime < 60_000) {
      return this.marketsCache;
    }
    this.marketsCache = await this.api.getMarkets();
    this.marketsCacheTime = now;
    return this.marketsCache;
  }

  private resolveMarket(data: MarketsResponse, symbolPair: string): Market {
    // Accept hex market_id
    if (symbolPair.startsWith("0x")) {
      const found = data.markets.find((m) => m.market_id === symbolPair);
      if (found) return found;
      throw new O2Error(`Market not found: ${symbolPair}`);
    }

    // Accept "BASE/QUOTE" format
    const [baseSymbol, quoteSymbol] = symbolPair.split("/");
    const found = data.markets.find(
      (m) =>
        m.base.symbol.toLowerCase() === baseSymbol.toLowerCase() &&
        m.quote.symbol.toLowerCase() === quoteSymbol.toLowerCase(),
    );

    if (!found) {
      // Try case-insensitive with f-prefix variants
      const altFound = data.markets.find(
        (m) =>
          (m.base.symbol.toLowerCase() === baseSymbol.toLowerCase() ||
            m.base.symbol.toLowerCase() === `f${baseSymbol.toLowerCase()}`) &&
          (m.quote.symbol.toLowerCase() === quoteSymbol.toLowerCase() ||
            m.quote.symbol.toLowerCase() === `f${quoteSymbol.toLowerCase()}`),
      );
      if (altFound) return altFound;
      throw new O2Error(
        `Market not found: ${symbolPair}. Available: ${data.markets.map((m) => `${m.base.symbol}/${m.quote.symbol}`).join(", ")}`,
      );
    }

    return found;
  }

  /** Resolve an asset by symbol name or hex asset ID. */
  private resolveAsset(
    data: MarketsResponse,
    symbolOrId: string,
  ): { assetId: AssetId; decimals: number } {
    // If it looks like a hex ID, return directly
    if (symbolOrId.startsWith("0x")) {
      for (const m of data.markets) {
        if (m.base.asset === symbolOrId)
          return { assetId: m.base.asset, decimals: m.base.decimals };
        if (m.quote.asset === symbolOrId)
          return { assetId: m.quote.asset, decimals: m.quote.decimals };
      }
      // Return with default decimals if not found in markets
      return { assetId: toAssetId(symbolOrId), decimals: 9 };
    }

    // Search by symbol name (case-insensitive)
    for (const m of data.markets) {
      if (m.base.symbol.toLowerCase() === symbolOrId.toLowerCase()) {
        return { assetId: m.base.asset, decimals: m.base.decimals };
      }
      if (m.quote.symbol.toLowerCase() === symbolOrId.toLowerCase()) {
        return { assetId: m.quote.asset, decimals: m.quote.decimals };
      }
    }

    throw new O2Error(
      `Asset not found: ${symbolOrId}. Available: ${[...new Set(data.markets.flatMap((m) => [m.base.symbol, m.quote.symbol]))].join(", ")}`,
    );
  }

  /** Convert a type-safe Action to the wire-format ActionPayload. */
  private actionToPayload(action: Action, market: Market): ActionPayload {
    const session = this.ensureSession();
    switch (action.type) {
      case "createOrder": {
        let scaledPrice: bigint;
        let scaledQuantity: bigint;

        if (typeof action.price === "bigint") {
          scaledPrice = action.price;
        } else {
          scaledPrice = scalePriceString(
            action.price,
            market.quote.decimals,
            market.quote.max_precision,
          );
        }

        if (typeof action.quantity === "bigint") {
          scaledQuantity = action.quantity;
        } else {
          scaledQuantity = scaleQuantityString(
            action.quantity,
            market.base.decimals,
            market.base.max_precision,
          );
        }

        // Auto-adjust quantity for FractionalPrice
        if (!validateFractionalPrice(scaledPrice, scaledQuantity, market.base.decimals)) {
          const factor = BigInt(10 ** market.base.decimals);
          const product = scaledPrice * scaledQuantity;
          const remainder = product % factor;
          if (remainder !== 0n) {
            const adjustedProduct = product - remainder;
            scaledQuantity = adjustedProduct / scaledPrice;
          }
        }

        // Validate min_order
        if (
          !validateMinOrder(scaledPrice, scaledQuantity, market.base.decimals, market.min_order)
        ) {
          throw new O2Error(
            `Order value below min_order. ` +
              `(price * quantity) / 10^${market.base.decimals} must be >= ${market.min_order}`,
          );
        }

        return {
          CreateOrder: {
            side: capitalizeSide(action.side),
            price: scaledPrice.toString(),
            quantity: scaledQuantity.toString(),
            order_type: action.orderType ?? "Spot",
          },
        };
      }
      case "cancelOrder":
        return { CancelOrder: { order_id: action.orderId } };
      case "settleBalance":
        return {
          SettleBalance: {
            to: { ContractId: session.tradeAccountId },
          },
        };
      case "registerReferer":
        return { RegisterReferer: { to: action.to } };
    }
  }

  /**
   * Internal batch submission. Handles encoding, signing, nonce management.
   * The session nonce is updated in-place after each call.
   */
  private async submitBatch(
    marketActions: MarketActions[],
    market: Market,
    accountsRegistryId: string,
    collectOrders = false,
  ): Promise<SessionActionsResponse> {
    const session = this.ensureSession();
    // Check session expiry before submitting on-chain
    if (session.expiry > 0 && Math.floor(Date.now() / 1000) >= session.expiry) {
      throw new SessionExpired();
    }

    const marketInfo: MarketInfo = {
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

    // Convert high-level actions to low-level calls
    const calls: ContractCall[] = [];
    for (const group of marketActions) {
      for (const action of group.actions) {
        calls.push(actionToCall(action as ActionJSON, marketInfo, accountsRegistryId));
      }
    }

    // Build signing bytes and sign
    const signingBytes = buildActionsSigningBytes(session.nonce, calls);
    const signature = rawSign(session.sessionPrivateKey, signingBytes);

    try {
      const response = await this.api.submitActions(session.ownerAddress, {
        actions: marketActions,
        signature: { Secp256k1: bytesToHex(signature) },
        nonce: session.nonce.toString(),
        trade_account_id: session.tradeAccountId,
        session_id: { Address: session.sessionAddress },
        collect_orders: collectOrders,
      });

      // Increment nonce on success
      session.nonce += 1n;
      return response;
    } catch (error) {
      // Nonce increments on-chain even on revert
      session.nonce += 1n;
      // Re-fetch nonce on error for resync
      try {
        const info = await this.api.getAccount({
          tradeAccountId: session.tradeAccountId,
        });
        if (info.trade_account) {
          session.nonce = info.trade_account.nonce;
        }
      } catch (_e: unknown) {
        // If re-fetch fails, keep incremented nonce
      }
      throw error;
    }
  }
}
