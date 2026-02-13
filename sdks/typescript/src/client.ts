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
 * const wallet = client.generateWallet();
 * const { tradeAccountId } = await client.setupAccount(wallet);
 * const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
 * const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
 * console.log(`Order TX: ${response.tx_id}`);
 * client.close();
 * ```
 *
 * @module
 */

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
  scalePrice,
  scaleQuantity,
  validateFractionalPrice,
  validateMinOrder,
} from "./encoding.js";
import { O2Error, SessionExpired } from "./errors.js";
import type {
  ActionPayload,
  BalanceResponse,
  BalanceUpdate,
  Bar,
  DepthSnapshot,
  DepthUpdate,
  Identity,
  Market,
  MarketActions,
  MarketsResponse,
  NonceUpdate,
  Order,
  OrderType,
  OrderUpdate,
  SessionActionsResponse,
  SessionState,
  Trade,
  TradeUpdate,
  WalletState,
} from "./models.js";
import { O2WebSocket } from "./websocket.js";

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
 * High-level client for the O2 Exchange.
 *
 * Orchestrates wallet management, account lifecycle, session creation,
 * trading (with automatic encoding and signing), market data retrieval,
 * and real-time WebSocket streaming.
 *
 * @example
 * ```ts
 * const client = new O2Client({ network: Network.TESTNET });
 * const wallet = client.generateWallet();
 * const { tradeAccountId } = await client.setupAccount(wallet);
 * ```
 */
export class O2Client {
  /** The underlying low-level REST API client. */
  readonly api: O2Api;
  private wsClient: O2WebSocket | null = null;
  private readonly config: NetworkConfig;
  private marketsCache: MarketsResponse | null = null;
  private marketsCacheTime = 0;

  constructor(options: O2ClientOptions = {}) {
    this.config = options.config ?? getNetworkConfig(options.network ?? Network.TESTNET);
    this.api = new O2Api({ config: this.config });
  }

  // ── Wallet management ───────────────────────────────────────────

  /**
   * Generate a new Fuel-native secp256k1 wallet.
   *
   * @returns A new wallet state with a random private key.
   *
   * @example
   * ```ts
   * const wallet = client.generateWallet();
   * console.log(wallet.b256Address); // "0x..."
   * ```
   */
  generateWallet(): WalletState {
    const w = generateWallet();
    return { privateKey: w.privateKey, b256Address: w.b256Address, isEvm: false };
  }

  /**
   * Generate a new EVM-compatible secp256k1 wallet.
   *
   * @returns A new wallet state with EVM address and zero-padded b256 address.
   */
  generateEvmWallet(): WalletState {
    const w = generateEvmWallet();
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: true,
      evmAddress: w.evmAddress,
    };
  }

  /**
   * Load a Fuel-native wallet from a private key hex string.
   *
   * @param privateKeyHex - The private key as a 0x-prefixed hex string.
   * @returns The loaded wallet state.
   */
  loadWallet(privateKeyHex: string): WalletState {
    const w = walletFromPrivateKey(privateKeyHex);
    return { privateKey: w.privateKey, b256Address: w.b256Address, isEvm: false };
  }

  /**
   * Load an EVM-compatible wallet from a private key hex string.
   *
   * @param privateKeyHex - The private key as a 0x-prefixed hex string.
   * @returns The loaded wallet state with EVM address.
   */
  loadEvmWallet(privateKeyHex: string): WalletState {
    const w = evmWalletFromPrivateKey(privateKeyHex);
    return {
      privateKey: w.privateKey,
      b256Address: w.b256Address,
      isEvm: true,
      evmAddress: w.evmAddress,
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
  async setupAccount(wallet: WalletState): Promise<{ tradeAccountId: string; nonce: bigint }> {
    // 1. Check if account already exists
    const existing = await this.api.getAccount({ owner: wallet.b256Address });

    let tradeAccountId: string;

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
    const nonce = BigInt(info.trade_account?.nonce ?? "0");

    return { tradeAccountId, nonce };
  }

  // ── Session management ──────────────────────────────────────────

  /**
   * Create a trading session.
   *
   * 1. Resolve market names to contract_ids
   * 2. Generate session keypair
   * 3. Build session signing bytes
   * 4. Sign with owner wallet
   * 5. Submit PUT /v1/session
   */
  async createSession(
    wallet: WalletState,
    tradeAccountId: string,
    markets: string[] | Market[],
    expiryDays = 30,
  ): Promise<SessionState> {
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
    const info = await this.api.getAccount({ tradeAccountId });
    const nonce = BigInt(info.trade_account?.nonce ?? "0");

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
    const signature = wallet.isEvm
      ? evmPersonalSign(wallet.privateKey, signingBytes)
      : personalSign(wallet.privateKey, signingBytes);

    // Submit
    const _resp = await this.api.createSession(wallet.b256Address, {
      contract_id: tradeAccountId,
      session_id: { Address: sessionWallet.b256Address },
      signature: { Secp256k1: bytesToHex(signature) },
      contract_ids: contractIds,
      nonce: nonce.toString(),
      expiry: expiry.toString(),
    });

    return {
      ownerAddress: wallet.b256Address,
      tradeAccountId,
      sessionPrivateKey: sessionWallet.privateKey,
      sessionAddress: sessionWallet.b256Address,
      contractIds,
      expiry: Number(expiry),
      nonce: nonce + 1n, // Nonce increments after session creation
      isEvm: wallet.isEvm,
    };
  }

  // ── Trading ─────────────────────────────────────────────────────

  /**
   * Create an order with automatic encoding, signing, and nonce management.
   * Optionally prepends SettleBalance and appends collect_orders.
   */
  async createOrder(
    session: SessionState,
    market: string | Market,
    side: "Buy" | "Sell",
    price: number,
    quantity: number,
    orderType: OrderType = "Spot",
    settleFirst = true,
    collectOrders = true,
  ): Promise<{ response: SessionActionsResponse; session: SessionState }> {
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    // Scale price and quantity
    const scaledPrice = scalePrice(price, resolved.quote.decimals, resolved.quote.max_precision);
    let scaledQuantity = scaleQuantity(
      quantity,
      resolved.base.decimals,
      resolved.base.max_precision,
    );

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
      !validateMinOrder(
        scaledPrice,
        scaledQuantity,
        resolved.base.decimals,
        BigInt(resolved.min_order),
      )
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
        side,
        price: scaledPrice.toString(),
        quantity: scaledQuantity.toString(),
        order_type: orderType,
      },
    });

    return this.batchActions(
      session,
      [{ market_id: resolved.market_id, actions }],
      resolved,
      marketsData.accounts_registry_id,
      collectOrders,
    );
  }

  /** Cancel an order. */
  async cancelOrder(
    session: SessionState,
    orderId: string,
    market: string | Market,
  ): Promise<{ response: SessionActionsResponse; session: SessionState }> {
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.batchActions(
      session,
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

  /** Cancel all open orders for a market. Returns one result per chunk, or null if no orders. */
  async cancelAllOrders(
    session: SessionState,
    market: string | Market,
  ): Promise<Array<{ response: SessionActionsResponse; session: SessionState }> | null> {
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

    const results: Array<{ response: SessionActionsResponse; session: SessionState }> = [];
    let currentSession = session;

    // Process in chunks of 5 (max actions per batch)
    for (let i = 0; i < orders.orders.length; i += 5) {
      const chunk = orders.orders.slice(i, i + 5);
      const cancelActions: ActionPayload[] = chunk.map((o) => ({
        CancelOrder: { order_id: o.order_id },
      }));

      const result = await this.batchActions(
        currentSession,
        [{ market_id: resolved.market_id, actions: cancelActions }],
        resolved,
        marketsData.accounts_registry_id,
      );
      currentSession = result.session;
      results.push(result);
    }

    return results;
  }

  /** Settle balance for a market. */
  async settleBalance(
    session: SessionState,
    market: string | Market,
  ): Promise<{ response: SessionActionsResponse; session: SessionState }> {
    const marketsData = await this.fetchMarkets();
    const resolved = typeof market === "string" ? this.resolveMarket(marketsData, market) : market;

    return this.batchActions(
      session,
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
   * Submit a batch of raw actions. Advanced interface.
   * Handles encoding, signing, nonce management.
   */
  async batchActions(
    session: SessionState,
    marketActions: MarketActions[],
    market: Market,
    accountsRegistryId: string,
    collectOrders = false,
  ): Promise<{ response: SessionActionsResponse; session: SessionState }> {
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
      return { response, session };
    } catch (error) {
      // Nonce increments on-chain even on revert
      session.nonce += 1n;
      // Re-fetch nonce on error for resync
      try {
        const info = await this.api.getAccount({
          tradeAccountId: session.tradeAccountId,
        });
        if (info.trade_account) {
          session.nonce = BigInt(info.trade_account.nonce);
        }
      } catch (_e: unknown) {
        // If re-fetch fails, keep incremented nonce
      }
      throw error;
    }
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
   *
   * @param market - Market pair string or {@link Market} object.
   * @param precision - Number of price levels (default: 10).
   */
  async getDepth(market: string | Market, precision = 10): Promise<DepthSnapshot> {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getDepth(marketId, precision);
  }

  /**
   * Fetch recent trades for a market.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param count - Number of trades to return (default: 50).
   */
  async getTrades(market: string | Market, count = 50): Promise<Trade[]> {
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return this.api.getTrades(marketId, "desc", count);
  }

  /**
   * Fetch OHLCV candlestick bars.
   *
   * @param market - Market pair string or {@link Market} object.
   * @param resolution - Bar resolution (e.g., `"1m"`, `"1h"`, `"1d"`).
   * @param from - Start time (Unix seconds).
   * @param to - End time (Unix seconds).
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
   *
   * @param market - Market pair string or {@link Market} object.
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
  async getBalances(tradeAccountId: string): Promise<Record<string, BalanceResponse>> {
    const marketsData = await this.fetchMarkets();
    const result: Record<string, BalanceResponse> = {};

    // Collect unique assets
    const assets = new Map<string, string>();
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
   * @param tradeAccountId - The trade account contract ID.
   * @param market - Market pair string or {@link Market} object.
   * @param isOpen - Filter by open/closed status.
   * @param count - Number of orders (default: 20).
   */
  async getOrders(
    tradeAccountId: string,
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
   *
   * @param market - Market pair string or {@link Market} object.
   * @param orderId - The order identifier.
   */
  async getOrder(market: string | Market, orderId: string): Promise<Order> {
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
   *
   * @param market - Market pair string or {@link Market} object.
   * @param precision - Number of price levels (default: 10).
   * @returns An async generator yielding {@link DepthUpdate} messages.
   */
  async streamDepth(market: string | Market, precision = 10): Promise<AsyncGenerator<DepthUpdate>> {
    const ws = await this.ensureWs();
    const marketId =
      typeof market === "string" ? (await this.getMarket(market)).market_id : market.market_id;
    return ws.streamDepth(marketId, precision);
  }

  /**
   * Stream real-time order updates for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   * @returns An async generator yielding {@link OrderUpdate} messages.
   */
  async streamOrders(tradeAccountId: string): Promise<AsyncGenerator<OrderUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamOrders([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time trades for a market.
   *
   * @param market - Market pair string or {@link Market} object.
   * @returns An async generator yielding {@link TradeUpdate} messages.
   */
  async streamTrades(market: string | Market): Promise<AsyncGenerator<TradeUpdate>> {
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
  async streamBalances(tradeAccountId: string): Promise<AsyncGenerator<BalanceUpdate>> {
    const ws = await this.ensureWs();
    return ws.streamBalances([{ ContractId: tradeAccountId }]);
  }

  /**
   * Stream real-time nonce updates for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   * @returns An async generator yielding {@link NonceUpdate} messages.
   */
  async streamNonce(tradeAccountId: string): Promise<AsyncGenerator<NonceUpdate>> {
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

  // ── Withdrawals ─────────────────────────────────────────────────

  /**
   * Withdraw funds from trading account to owner wallet.
   * Requires the owner wallet (not session).
   */
  async withdraw(
    wallet: WalletState,
    tradeAccountId: string,
    assetId: string,
    amount: string,
    to?: Identity,
  ) {
    // Get current nonce and chain_id
    const info = await this.api.getAccount({ tradeAccountId });
    const nonce = BigInt(info.trade_account?.nonce ?? "0");

    const marketsData = await this.fetchMarkets();
    const chainIdRaw = marketsData.chain_id;
    const chainId = BigInt(
      chainIdRaw.startsWith("0x") ? Number.parseInt(chainIdRaw, 16) : chainIdRaw,
    );

    const destination = to ?? { Address: wallet.b256Address };
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
      BigInt(amount),
    );

    const signature = wallet.isEvm
      ? evmPersonalSign(wallet.privateKey, signingBytes)
      : personalSign(wallet.privateKey, signingBytes);

    return this.api.withdraw(wallet.b256Address, {
      trade_account_id: tradeAccountId,
      signature: { Secp256k1: bytesToHex(signature) },
      nonce: nonce.toString(),
      to: destination,
      asset_id: assetId,
      amount,
    });
  }

  // ── Nonce management ────────────────────────────────────────────

  /**
   * Fetch the current on-chain nonce for a trading account.
   *
   * @param tradeAccountId - The trade account contract ID.
   */
  async getNonce(tradeAccountId: string): Promise<bigint> {
    const info = await this.api.getAccount({ tradeAccountId });
    return BigInt(info.trade_account?.nonce ?? "0");
  }

  /**
   * Re-fetch the nonce from the API and update the session state.
   *
   * Call this after errors to re-sync the nonce (it increments on-chain
   * even on reverts).
   *
   * @param session - The session state to update.
   * @returns The fresh nonce value.
   */
  async refreshNonce(session: SessionState): Promise<bigint> {
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
}
