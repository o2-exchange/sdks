/**
 * TypeScript interfaces for all O2 Exchange API types.
 *
 * These types represent the data structures used throughout the O2 SDK,
 * including market data, order management, account operations, and
 * real-time WebSocket messages.
 *
 * @module
 */

import type { Signer } from "./crypto.js";

// ── Identity ────────────────────────────────────────────────────────

/**
 * A Fuel Identity with the Address variant.
 *
 * @example
 * ```ts
 * const identity: IdentityAddress = { Address: "0xabcd...1234" };
 * ```
 */
export interface IdentityAddress {
  /** The 0x-prefixed, 64-character hex address. */
  Address: string;
}

/**
 * A Fuel Identity with the ContractId variant.
 *
 * @example
 * ```ts
 * const identity: IdentityContractId = { ContractId: "0xabcd...1234" };
 * ```
 */
export interface IdentityContractId {
  /** The 0x-prefixed, 64-character hex contract ID. */
  ContractId: string;
}

/**
 * A Fuel blockchain identity — either an {@link IdentityAddress} or an
 * {@link IdentityContractId}.
 *
 * Use the {@link isAddress} and {@link isContractId} type guards to narrow.
 *
 * @example
 * ```ts
 * const id: Identity = { Address: "0xabcd...1234" };
 * if (isAddress(id)) {
 *   console.log(id.Address);
 * }
 * ```
 */
export type Identity = IdentityAddress | IdentityContractId;

/**
 * Type guard: returns `true` if the identity is an {@link IdentityAddress}.
 *
 * @param id - The identity to check.
 */
export function isAddress(id: Identity): id is IdentityAddress {
  return "Address" in id;
}

/**
 * Type guard: returns `true` if the identity is an {@link IdentityContractId}.
 *
 * @param id - The identity to check.
 */
export function isContractId(id: Identity): id is IdentityContractId {
  return "ContractId" in id;
}

/**
 * Extract the raw hex string from an {@link Identity}, regardless of variant.
 *
 * @param id - The identity to extract from.
 * @returns The 0x-prefixed hex address or contract ID string.
 */
export function identityValue(id: Identity): string {
  return isAddress(id) ? id.Address : id.ContractId;
}

// ── Signature ───────────────────────────────────────────────────────

/**
 * A secp256k1 signature in Fuel compact format.
 *
 * The signature is a 0x-prefixed, 128-character hex string (64 bytes)
 * with the recovery ID embedded in the MSB of byte 32.
 */
export interface Secp256k1Signature {
  /** 0x-prefixed 128-char hex signature. */
  Secp256k1: string;
}

/**
 * Signature type used throughout the SDK.
 * Currently always {@link Secp256k1Signature}.
 */
export type Signature = Secp256k1Signature;

// ── Market ──────────────────────────────────────────────────────────

/**
 * Describes an asset within a {@link Market} (base or quote).
 */
export interface MarketAsset {
  /** The token symbol (e.g., `"fFUEL"`, `"fUSDC"`). */
  symbol: string;
  /** The 0x-prefixed hex asset ID on the Fuel blockchain. */
  asset: string;
  /** Number of decimal places for the asset (e.g., `9` for Fuel). */
  decimals: number;
  /** Maximum allowed price/quantity precision digits. */
  max_precision: number;
}

/**
 * Full market configuration as returned by the O2 Exchange API.
 *
 * Contains contract addresses, fee schedule, trading constraints,
 * and the base/quote asset definitions.
 *
 * @example
 * ```ts
 * const market = await client.getMarket("fFUEL/fUSDC");
 * console.log(market.market_id);      // "0x..."
 * console.log(market.base.symbol);    // "fFUEL"
 * console.log(market.quote.symbol);   // "fUSDC"
 * ```
 */
export interface Market {
  /** On-chain contract ID for this order book. */
  contract_id: string;
  /** Unique market identifier (0x-prefixed hex). */
  market_id: string;
  /** Maker fee rate as a decimal string (e.g., `"0.001"`). */
  maker_fee: string;
  /** Taker fee rate as a decimal string (e.g., `"0.002"`). */
  taker_fee: string;
  /** Minimum order value in quote asset units (chain integer string). */
  min_order: string;
  /** Dust threshold — orders below this are cancelled (chain integer string). */
  dust: string;
  /** Maximum price deviation window. */
  price_window: number;
  /** Base asset (the asset being bought/sold). */
  base: MarketAsset;
  /** Quote asset (the asset used for pricing). */
  quote: MarketAsset;
}

/**
 * Response from the `GET /v1/markets` endpoint.
 *
 * Contains global registry IDs and the list of all available markets.
 */
export interface MarketsResponse {
  /** Books registry contract ID. */
  books_registry_id: string;
  /** Accounts registry contract ID. */
  accounts_registry_id: string;
  /** Trade account oracle contract ID. */
  trade_account_oracle_id: string;
  /** The Fuel chain ID (may be hex or decimal string). */
  chain_id: string;
  /** The native base asset ID (e.g., ETH on Fuel). */
  base_asset_id: string;
  /** All available markets. */
  markets: Market[];
}

/**
 * Summary statistics for a market over the last 24 hours.
 */
export interface MarketSummary {
  /** Market identifier. */
  market_id: string;
  /** Current price. */
  price: string;
  /** 24-hour price change as a percentage string. */
  price_change_percent_24h: string;
  /** 24-hour high price. */
  highest_price_24h: string;
  /** 24-hour low price. */
  lowest_price_24h: string;
  /** 24-hour base asset volume. */
  base_volume: string;
  /** 24-hour quote asset volume. */
  quote_volume: string;
}

/**
 * Real-time ticker data for a market.
 */
export interface MarketTicker {
  /** Market identifier. */
  market_id: string;
  /** Last traded price. */
  last_price: string;
  /** 24-hour base asset volume. */
  base_volume: string;
  /** 24-hour quote asset volume. */
  quote_volume: string;
  /** Best ask (lowest sell) price. */
  best_ask: string;
  /** Best bid (highest buy) price. */
  best_bid: string;
}

// ── Depth ───────────────────────────────────────────────────────────

/**
 * A single price level in the order book depth.
 */
export interface DepthLevel {
  /** Price at this level (chain integer string). */
  price: string;
  /** Total quantity at this level (chain integer string). */
  quantity: string;
}

/**
 * A full snapshot of the order book depth.
 *
 * @example
 * ```ts
 * const depth = await client.getDepth("fFUEL/fUSDC");
 * console.log(`Best bid: ${depth.buys[0]?.price}`);
 * console.log(`Best ask: ${depth.sells[0]?.price}`);
 * ```
 */
export interface DepthSnapshot {
  /** Buy (bid) side of the order book, sorted by price descending. */
  buys: DepthLevel[];
  /** Sell (ask) side of the order book, sorted by price ascending. */
  sells: DepthLevel[];
}

/**
 * A WebSocket depth update message.
 *
 * Can be either a full snapshot (`action: "subscribe_depth"`)
 * or an incremental update (`action: "subscribe_depth_update"`).
 */
export interface DepthUpdate {
  /** The action type (`"subscribe_depth"` or `"subscribe_depth_update"`). */
  action: string;
  /** Incremental changes (present on updates). */
  changes?: { buys: DepthLevel[]; sells: DepthLevel[] };
  /** Full order book view (present on snapshots). */
  view?: { buys: DepthLevel[]; sells: DepthLevel[] };
  /** Market identifier. */
  market_id: string;
  /** On-chain timestamp. */
  onchain_timestamp?: string;
  /** Server-observed timestamp. */
  seen_timestamp?: string;
}

// ── Account ─────────────────────────────────────────────────────────

/**
 * On-chain trading account state.
 */
export interface TradeAccount {
  /** Last block number at which the account was modified. */
  last_modification: number;
  /** Current nonce (increments with each on-chain action). */
  nonce: string;
  /** The account owner's identity. */
  owner: Identity;
  /** Whether the account state is synced with the network. */
  synced_with_network?: boolean;
  /** Internal sync state details. */
  sync_state?: unknown;
}

/**
 * Account information returned by the API.
 */
export interface AccountInfo {
  /** The trade account contract ID, or `null` if no account exists. */
  trade_account_id: string | null;
  /** The on-chain trade account state, or `null` if not found. */
  trade_account: TradeAccount | null;
  /** Active session info, if any. */
  session?: SessionInfo | null;
}

/**
 * Response from creating a new trading account.
 */
export interface CreateAccountResponse {
  /** The newly created trade account contract ID. */
  trade_account_id: string;
  /** Initial nonce value. */
  nonce: string;
}

// ── Session ─────────────────────────────────────────────────────────

/**
 * Information about an active trading session.
 */
export interface SessionInfo {
  /** The session key identity. */
  session_id: Identity;
  /** Contract IDs the session is authorized to interact with. */
  contract_ids: string[];
  /** Session expiry timestamp (Unix seconds as string). */
  expiry: string;
}

/**
 * Request body for creating a new trading session.
 */
export interface SessionRequest {
  /** The trade account contract ID. */
  contract_id: string;
  /** The session key identity. */
  session_id: Identity;
  /** The owner's signature authorizing the session. */
  signature: Signature;
  /** Contract IDs the session should be authorized for. */
  contract_ids: string[];
  /** Current nonce (as string). */
  nonce: string;
  /** Expiry timestamp (Unix seconds as string). */
  expiry: string;
}

/**
 * Response from a successful session creation.
 */
export interface SessionResponse {
  /** On-chain transaction ID. */
  tx_id: string;
  /** The trade account contract ID. */
  trade_account_id: string;
  /** Authorized contract IDs. */
  contract_ids: string[];
  /** The session key identity. */
  session_id: Identity;
  /** Session expiry timestamp. */
  session_expiry: string;
}

// ── Orders ──────────────────────────────────────────────────────────

/**
 * Order side: `"Buy"` or `"Sell"`.
 */
export type Side = "Buy" | "Sell";

/**
 * Order type variants.
 *
 * - `"Spot"` — Standard limit order (default)
 * - `"FillOrKill"` — Must fill entirely or be rejected
 * - `"PostOnly"` — Guaranteed maker; rejected if it would match
 * - `"Market"` — Executes at best available price
 * - `{ Limit: [price, timestamp] }` — Limit with time-in-force
 * - `{ BoundedMarket: { max_price, min_price } }` — Market with price bounds
 */
export type OrderType =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: [string, string] }
  | { BoundedMarket: { max_price: string; min_price: string } };

/**
 * An order on the O2 Exchange.
 *
 * @example
 * ```ts
 * const orders = await client.getOrders(tradeAccountId, "fFUEL/fUSDC", true);
 * for (const order of orders) {
 *   console.log(`${order.side} ${order.quantity} @ ${order.price}`);
 * }
 * ```
 */
export interface Order {
  /** Unique order identifier (0x-prefixed hex). */
  order_id: string;
  /** Order side. */
  side: Side;
  /** Order type. */
  order_type: OrderType;
  /** Total quantity (chain integer string). */
  quantity: string;
  /** Filled quantity (chain integer string). */
  quantity_fill?: string;
  /** Originally desired quantity. */
  desired_quantity?: string;
  /** Order price (chain integer string). */
  price: string;
  /** Volume-weighted fill price. */
  price_fill?: string;
  /** Order creation timestamp. */
  timestamp: string | number;
  /** Whether the order is closed (fully filled or cancelled). */
  close: boolean;
  /** Whether the order has been partially filled. */
  partially_filled?: boolean;
  /** Whether the order has been cancelled. */
  cancel?: boolean;
  /** Base asset decimals (for formatting). */
  base_decimals?: number;
  /** The account identity that placed the order. */
  account?: Identity;
  /** Fill information. */
  fill?: unknown;
  /** Transaction history for this order. */
  order_tx_history?: unknown[];
  /** Order event history. */
  history?: unknown[];
  /** Individual fill records. */
  fills?: unknown[];
  /** The market this order belongs to. */
  market_id?: string;
  /** The owner identity. */
  owner?: Identity;
}

/**
 * Response from the orders endpoint.
 */
export interface OrdersResponse {
  /** The account identity. */
  identity: Identity;
  /** The market identifier. */
  market_id: string;
  /** List of orders. */
  orders: Order[];
}

// ── Trades ──────────────────────────────────────────────────────────

/**
 * A completed trade on the exchange.
 *
 * @example
 * ```ts
 * const trades = await client.getTrades("fFUEL/fUSDC", 10);
 * for (const trade of trades) {
 *   console.log(`${trade.side} ${trade.quantity} @ ${trade.price}`);
 * }
 * ```
 */
export interface Trade {
  /** Unique trade identifier. */
  trade_id: string;
  /** Taker side of the trade. */
  side: Side;
  /** Total trade value in quote asset (chain integer string). */
  total: string;
  /** Trade quantity in base asset (chain integer string). */
  quantity: string;
  /** Trade price (chain integer string). */
  price: string;
  /** Trade execution timestamp. */
  timestamp: string;
  /** Maker account identity. */
  maker?: Identity;
  /** Taker account identity. */
  taker?: Identity;
}

// ── Balance ─────────────────────────────────────────────────────────

/**
 * Balance for a single order book (per-market balance breakdown).
 */
export interface OrderBookBalance {
  /** Amount locked in open orders (chain integer string). */
  locked: string;
  /** Amount available for new orders (chain integer string). */
  unlocked: string;
}

/**
 * Balance information for a trading account on a specific asset.
 *
 * @example
 * ```ts
 * const balances = await client.getBalances(tradeAccountId);
 * for (const [symbol, bal] of Object.entries(balances)) {
 *   console.log(`${symbol}: ${bal.trading_account_balance}`);
 * }
 * ```
 */
export interface BalanceResponse {
  /** Per-order-book balance breakdown, keyed by order book contract ID. */
  order_books: Record<string, OrderBookBalance>;
  /** Total locked across all order books (chain integer string). */
  total_locked: string;
  /** Total unlocked across all order books (chain integer string). */
  total_unlocked: string;
  /** Total balance in the trading account (chain integer string). */
  trading_account_balance: string;
}

// ── Bars / Candles ──────────────────────────────────────────────────

/**
 * An OHLCV candlestick bar.
 *
 * @example
 * ```ts
 * const bars = await client.getBars("fFUEL/fUSDC", "1h", fromTs, toTs);
 * for (const bar of bars) {
 *   console.log(`${new Date(bar.time * 1000).toISOString()}: O=${bar.open} C=${bar.close}`);
 * }
 * ```
 */
export interface Bar {
  /** Bar start time (Unix seconds). */
  time: number;
  /** Opening price. */
  open: string;
  /** Highest price during the bar. */
  high: string;
  /** Lowest price during the bar. */
  low: string;
  /** Closing price. */
  close: string;
  /** Volume during the bar. */
  volume: string;
}

// ── Session Actions ─────────────────────────────────────────────────

/**
 * A batch of actions targeting a specific market.
 */
export interface MarketActions {
  /** The target market identifier. */
  market_id: string;
  /** The actions to execute on this market. */
  actions: ActionPayload[];
}

/**
 * Payload for a CreateOrder action.
 */
export interface CreateOrderPayload {
  CreateOrder: {
    /** Order side. */
    side: Side;
    /** Order price (chain integer string). */
    price: string;
    /** Order quantity (chain integer string). */
    quantity: string;
    /** Order type. */
    order_type: OrderType;
  };
}

/**
 * Payload for a CancelOrder action.
 */
export interface CancelOrderPayload {
  CancelOrder: {
    /** The order ID to cancel (0x-prefixed hex). */
    order_id: string;
  };
}

/**
 * Payload for a SettleBalance action.
 *
 * Settles filled order proceeds back to the specified identity
 * (typically the trade account contract).
 */
export interface SettleBalancePayload {
  SettleBalance: {
    /** The destination identity. */
    to: Identity;
  };
}

/**
 * Payload for a RegisterReferer action.
 */
export interface RegisterRefererPayload {
  RegisterReferer: {
    /** The referrer identity. */
    to: Identity;
  };
}

/**
 * Union of all possible action payloads for session actions.
 *
 * @see {@link CreateOrderPayload}
 * @see {@link CancelOrderPayload}
 * @see {@link SettleBalancePayload}
 * @see {@link RegisterRefererPayload}
 */
export type ActionPayload =
  | CreateOrderPayload
  | CancelOrderPayload
  | SettleBalancePayload
  | RegisterRefererPayload;

/**
 * Request body for submitting session actions.
 *
 * @remarks
 * Actions are grouped by market via {@link MarketActions}. A maximum
 * of 5 actions can be submitted per request.
 */
export interface SessionActionsRequest {
  /** Grouped actions per market. */
  actions: MarketActions[];
  /** Session key signature over the action signing bytes. */
  signature: Signature;
  /** Current nonce (as string). Must match the on-chain nonce. */
  nonce: string;
  /** The trade account contract ID. */
  trade_account_id: string;
  /** The session key identity. */
  session_id: Identity;
  /** If `true`, return created/updated orders in the response. */
  collect_orders?: boolean;
  /** Number of variable outputs for the transaction. */
  variable_outputs?: number;
  /** Minimum gas limit override. */
  min_gas_limit?: string;
  /** If `true`, estimate gas usage without executing. */
  estimate_gas_usage?: boolean;
}

/**
 * Response from a successful session actions submission.
 */
export interface SessionActionsResponse {
  /** On-chain transaction ID. */
  tx_id: string;
  /** Created/updated orders (if `collect_orders` was `true`). */
  orders?: Order[];
}

// ── Withdraw ────────────────────────────────────────────────────────

/**
 * Request body for a withdrawal.
 *
 * @remarks
 * Withdrawals require the owner wallet signature (not the session key).
 */
export interface WithdrawRequest {
  /** The trade account contract ID. */
  trade_account_id: string;
  /** Owner wallet signature over the withdraw signing bytes. */
  signature: Signature;
  /** Current nonce (as string). */
  nonce: string;
  /** Destination identity for the withdrawn funds. */
  to: Identity;
  /** Asset ID to withdraw (0x-prefixed hex). */
  asset_id: string;
  /** Amount to withdraw (chain integer string). */
  amount: string;
}

/**
 * Response from a successful withdrawal.
 */
export interface WithdrawResponse {
  /** On-chain transaction ID. */
  tx_id: string;
}

// ── Whitelist ───────────────────────────────────────────────────────

/**
 * Request body for whitelisting a trading account.
 */
export interface WhitelistRequest {
  /** The trade account contract ID to whitelist. */
  tradeAccount: string;
}

/**
 * Response from the whitelist endpoint.
 */
export interface WhitelistResponse {
  /** Whether the whitelist operation succeeded. */
  success: boolean;
  /** The whitelisted trade account contract ID. */
  tradeAccount: string;
  /** `true` if the account was already whitelisted. */
  alreadyWhitelisted?: boolean;
}

// ── Referral ────────────────────────────────────────────────────────

/**
 * Information about a referral code.
 */
export interface ReferralInfo {
  /** Whether the referral code is valid. */
  valid: boolean;
  /** The address of the referral code owner. */
  ownerAddress: string;
  /** Whether the referral code is currently active. */
  isActive: boolean;
}

// ── Faucet ──────────────────────────────────────────────────────────

/**
 * Response from the testnet/devnet faucet.
 */
export interface FaucetResponse {
  /** Success message (present on success). */
  message?: string;
  /** Error message (present on failure, e.g., cooldown). */
  error?: string;
}

// ── Aggregated ──────────────────────────────────────────────────────

/**
 * An asset in the aggregated assets endpoint.
 */
export interface AggregatedAsset {
  /** Asset identifier. */
  id: string;
  /** Human-readable asset name. */
  name: string;
  /** Asset ticker symbol. */
  symbol: string;
}

/**
 * Aggregated order book data.
 */
export interface AggregatedOrderbook {
  /** Bid levels as `[price, quantity]` tuples. */
  bids: [string, string][];
  /** Ask levels as `[price, quantity]` tuples. */
  asks: [string, string][];
  /** Snapshot timestamp (Unix milliseconds). */
  timestamp: number;
}

/**
 * Summary for a trading pair (CoinGecko-compatible format).
 */
export interface PairSummary {
  /** Trading pair identifier (e.g., `"fFUEL_fUSDC"`). */
  trading_pairs: string;
  /** Last traded price. */
  last_price: string;
  /** Lowest ask price. */
  lowest_ask: string;
  /** Highest bid price. */
  highest_bid: string;
  /** 24-hour base volume. */
  base_volume: string;
  /** 24-hour quote volume. */
  quote_volume: string;
  /** 24-hour price change percentage. */
  price_change_percent_24h: string;
  /** 24-hour high price. */
  highest_price_24h: string;
  /** 24-hour low price. */
  lowest_price_24h: string;
}

/**
 * Ticker data for a trading pair (CoinGecko-compatible format).
 */
export interface PairTicker {
  /** Ticker identifier. */
  ticker_id: string;
  /** Base currency symbol. */
  base_currency: string;
  /** Target (quote) currency symbol. */
  target_currency: string;
  /** Last traded price. */
  last_price: string;
  /** 24-hour base volume. */
  base_volume: string;
  /** 24-hour target (quote) volume. */
  target_volume: string;
  /** Best bid price. */
  bid: string;
  /** Best ask price. */
  ask: string;
  /** 24-hour high price. */
  high: string;
  /** 24-hour low price. */
  low: string;
}

// ── WebSocket Messages ──────────────────────────────────────────────

/**
 * A WebSocket order update message.
 *
 * Received when orders are created, updated, or cancelled for
 * a subscribed account.
 */
export interface OrderUpdate {
  /** The action type. */
  action: string;
  /** Updated orders. */
  orders: Order[];
  /** On-chain timestamp. */
  onchain_timestamp?: string;
  /** Server-observed timestamp. */
  seen_timestamp?: string;
}

/**
 * A WebSocket trade update message.
 *
 * Received when trades occur in a subscribed market.
 */
export interface TradeUpdate {
  /** The action type. */
  action: string;
  /** New trades. */
  trades: Trade[];
  /** The market identifier. */
  market_id: string;
  /** On-chain timestamp. */
  onchain_timestamp?: string;
  /** Server-observed timestamp. */
  seen_timestamp?: string;
}

/**
 * A WebSocket balance update message.
 *
 * Received when balances change for a subscribed account.
 */
export interface BalanceUpdate {
  /** The action type. */
  action: string;
  /** Updated balance entries. */
  balance: Array<{
    /** The account identity. */
    identity: Identity;
    /** The asset ID. */
    asset_id: string;
    /** Total locked amount. */
    total_locked: string;
    /** Total unlocked amount. */
    total_unlocked: string;
    /** Trading account balance. */
    trading_account_balance: string;
    /** Per-order-book breakdown. */
    order_books: Record<string, OrderBookBalance>;
  }>;
  /** On-chain timestamp. */
  onchain_timestamp?: string;
  /** Server-observed timestamp. */
  seen_timestamp?: string;
}

/**
 * A WebSocket nonce update message.
 *
 * Received when the account nonce changes (after any on-chain action).
 */
export interface NonceUpdate {
  /** The action type. */
  action: string;
  /** The contract ID whose nonce changed. */
  contract_id: string;
  /** The new nonce value. */
  nonce: string;
  /** On-chain timestamp. */
  onchain_timestamp?: string;
  /** Server-observed timestamp. */
  seen_timestamp?: string;
}

// ── Error Response ──────────────────────────────────────────────────

/**
 * Raw error response from the O2 API.
 *
 * @remarks
 * Two formats exist:
 * - **Pre-flight errors**: Have a numeric `code` field.
 * - **On-chain reverts**: Have `message` + `reason` + `receipts`, but no `code`.
 */
export interface O2ErrorResponse {
  /** Error code (present for pre-flight validation errors). */
  code?: number;
  /** Human-readable error message. */
  message: string;
  /** On-chain revert reason (e.g., `"NotEnoughBalance"`). */
  reason?: string;
  /** Transaction receipts (present for on-chain reverts). */
  receipts?: unknown[];
}

// ── Session State (high-level client) ───────────────────────────────

/**
 * Internal session state managed by {@link O2Client}.
 *
 * Returned by {@link O2Client.createSession} and passed to trading methods.
 * Contains everything needed to sign and submit session actions.
 *
 * @example
 * ```ts
 * const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
 * console.log(session.sessionAddress);
 * console.log(session.nonce);
 * ```
 */
export interface SessionState {
  /** The owner wallet's b256 address. */
  ownerAddress: string;
  /** The trade account contract ID. */
  tradeAccountId: string;
  /** The session key's private key (32 bytes). */
  sessionPrivateKey: Uint8Array;
  /** The session key's b256 address. */
  sessionAddress: string;
  /** Contract IDs the session is authorized for. */
  contractIds: string[];
  /** Session expiry (Unix seconds). */
  expiry: number;
  /** Current nonce (auto-incremented after each action). */
  nonce: bigint;
}

/**
 * Internal wallet state managed by {@link O2Client}.
 *
 * Extends the {@link Signer} interface with the private key and wallet
 * metadata. Returned by wallet generation/loading methods and passed
 * to {@link O2Client.setupAccount} and {@link O2Client.createSession}.
 *
 * @example
 * ```ts
 * const wallet = client.generateWallet();
 * console.log(wallet.b256Address); // "0x..."
 * ```
 */
export interface WalletState extends Signer {
  /** The wallet's private key (32 bytes). */
  privateKey: Uint8Array;
  /** Whether this is an EVM-style wallet. */
  isEvm: boolean;
  /** The EVM address (only present for EVM wallets). */
  evmAddress?: string;
}

// ── Market helpers ──────────────────────────────────────────────────

/**
 * Format a chain-integer price to a human-readable number.
 *
 * @param market - The market configuration.
 * @param chainValue - The price as a chain integer (bigint).
 * @returns The human-readable price.
 *
 * @example
 * ```ts
 * const price = formatPrice(market, 20000000n); // e.g., 0.02
 * ```
 */
export function formatPrice(market: Market, chainValue: bigint): number {
  return Number(chainValue) / 10 ** market.quote.decimals;
}

/**
 * Scale a human-readable price to a chain integer.
 *
 * Truncates to the market's maximum precision using floor rounding.
 *
 * @param market - The market configuration.
 * @param humanPrice - The human-readable price (e.g., `0.02`).
 * @returns The chain integer price.
 *
 * @example
 * ```ts
 * const chainPrice = scalePriceForMarket(market, 0.02);
 * ```
 */
export function scalePriceForMarket(market: Market, humanPrice: number): bigint {
  const scaled = BigInt(Math.floor(humanPrice * 10 ** market.quote.decimals));
  const truncateFactor = BigInt(10 ** (market.quote.decimals - market.quote.max_precision));
  return (scaled / truncateFactor) * truncateFactor;
}

/**
 * Format a chain-integer quantity to a human-readable number.
 *
 * @param market - The market configuration.
 * @param chainValue - The quantity as a chain integer (bigint).
 * @returns The human-readable quantity.
 */
export function formatQuantity(market: Market, chainValue: bigint): number {
  return Number(chainValue) / 10 ** market.base.decimals;
}

/**
 * Scale a human-readable quantity to a chain integer.
 *
 * Rounds up to the nearest precision step using ceiling rounding.
 *
 * @param market - The market configuration.
 * @param humanQuantity - The human-readable quantity (e.g., `100.0`).
 * @returns The chain integer quantity.
 */
export function scaleQuantityForMarket(market: Market, humanQuantity: number): bigint {
  const scaled = BigInt(Math.ceil(humanQuantity * 10 ** market.base.decimals));
  const truncateFactor = BigInt(10 ** (market.base.decimals - market.base.max_precision));
  const remainder = scaled % truncateFactor;
  if (remainder === 0n) return scaled;
  return scaled + (truncateFactor - remainder);
}
