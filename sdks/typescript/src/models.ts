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

// ── Branded Hex ID Types ─────────────────────────────────────────────

/**
 * A branded hex string type. Normalized to 0x-prefixed lowercase.
 * Different brands are compile-time incompatible despite being runtime strings.
 */
export type HexId<Brand extends string> = string & {
  readonly __brand: Brand;
};

/**
 * Create a normalized branded hex ID from a raw string.
 * Normalizes to 0x-prefixed lowercase.
 */
export function hexId<B extends string>(raw: string): HexId<B> {
  const stripped = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  return `0x${stripped.toLowerCase()}` as HexId<B>;
}

/** On-chain transaction ID. */
export type TxId = HexId<"TxId">;
/** Order identifier. */
export type OrderId = HexId<"OrderId">;
/** Market identifier. */
export type MarketId = HexId<"MarketId">;
/** Contract identifier. */
export type ContractId = HexId<"ContractId">;
/** Trade account identifier. */
export type TradeAccountId = HexId<"TradeAccountId">;
/** Asset identifier. */
export type AssetId = HexId<"AssetId">;

/** Create a {@link TxId} from a raw hex string. */
export const txId = (raw: string): TxId => hexId<"TxId">(raw);
/** Create an {@link OrderId} from a raw hex string. */
export const orderId = (raw: string): OrderId => hexId<"OrderId">(raw);
/** Create a {@link MarketId} from a raw hex string. */
export const marketId = (raw: string): MarketId => hexId<"MarketId">(raw);
/** Create a {@link ContractId} from a raw hex string. */
export const contractId = (raw: string): ContractId => hexId<"ContractId">(raw);
/** Create a {@link TradeAccountId} from a raw hex string. */
export const tradeAccountId = (raw: string): TradeAccountId => hexId<"TradeAccountId">(raw);
/** Create an {@link AssetId} from a raw hex string. */
export const assetId = (raw: string): AssetId => hexId<"AssetId">(raw);

// ── Nonce ────────────────────────────────────────────────────────────

/**
 * Normalized nonce wrapper. The API returns nonces inconsistently as
 * JSON numbers, decimal strings, or hex strings. This class normalizes
 * all formats to bigint.
 *
 * @example
 * ```ts
 * new Nonce("42").toBigInt()    // 42n
 * new Nonce("0x1a").toBigInt()  // 26n
 * new Nonce(7).toBigInt()       // 7n
 * ```
 */
export class Nonce {
  readonly value: bigint;

  constructor(raw: string | number | bigint) {
    if (typeof raw === "bigint") this.value = raw;
    else if (typeof raw === "number") this.value = BigInt(raw);
    else if (raw.startsWith("0x") || raw.startsWith("0X")) this.value = BigInt(raw);
    else this.value = BigInt(raw);
  }

  toString(): string {
    return this.value.toString();
  }

  toBigInt(): bigint {
    return this.value;
  }
}

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
  /** The asset ID on the Fuel blockchain. */
  asset: AssetId;
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
  contract_id: ContractId;
  /** Unique market identifier (0x-prefixed hex). */
  market_id: MarketId;
  /** Maker fee (chain integer). */
  maker_fee: bigint;
  /** Taker fee (chain integer). */
  taker_fee: bigint;
  /** Minimum order value in quote asset units (chain integer). */
  min_order: bigint;
  /** Dust threshold — orders below this are cancelled (chain integer). */
  dust: bigint;
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
  books_registry_id: ContractId;
  /** Accounts registry contract ID. */
  accounts_registry_id: ContractId;
  /** Trade account oracle contract ID. */
  trade_account_oracle_id: ContractId;
  /** The Fuel chain ID (may be hex or decimal string). */
  chain_id: string;
  /** The native base asset ID (e.g., ETH on Fuel). */
  base_asset_id: AssetId;
  /** All available markets. */
  markets: Market[];
}

/**
 * Summary statistics for a market over the last 24 hours.
 */
export interface MarketSummary {
  /** Market identifier. */
  market_id: MarketId;
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
  market_id: MarketId;
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
  /** Price at this level (chain integer). */
  price: bigint;
  /** Total quantity at this level (chain integer). */
  quantity: bigint;
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
  market_id: MarketId;
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
  nonce: bigint;
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
  trade_account_id: TradeAccountId | null;
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
  trade_account_id: TradeAccountId;
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
  contract_ids: ContractId[];
  /** Session expiry timestamp (Unix seconds as string). */
  expiry: string;
}

/**
 * Request body for creating a new trading session.
 */
export interface SessionRequest {
  /** The trade account contract ID. */
  contract_id: TradeAccountId;
  /** The session key identity. */
  session_id: Identity;
  /** The owner's signature authorizing the session. */
  signature: Signature;
  /** Contract IDs the session should be authorized for. */
  contract_ids: ContractId[];
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
  tx_id: TxId;
  /** The trade account contract ID. */
  trade_account_id: TradeAccountId;
  /** Authorized contract IDs. */
  contract_ids: ContractId[];
  /** The session key identity. */
  session_id: Identity;
  /** Session expiry timestamp. */
  session_expiry: string;
}

// ── Orders ──────────────────────────────────────────────────────────

/**
 * Order side: `"buy"` or `"sell"`.
 */
export type Side = "buy" | "sell";

/**
 * Dual-mode numeric type for prices and quantities.
 *
 * - `string` — Human-readable decimal (e.g., `"0.02"`, `"100.5"`). Auto-scaled
 *   using market decimals via precise string parsing (no float intermediary).
 * - `bigint` — Raw chain integer (e.g., `20000000n`). Passed through directly.
 */
export type Numeric = string | bigint;

/**
 * Wire-format order type — all price fields are chain integer strings.
 *
 * Used in {@link CreateOrderPayload} and the encoding layer.
 * Consumers should use {@link OrderType} (which accepts {@link Numeric})
 * and let the SDK scale prices automatically.
 */
export type WireOrderType =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: [string, string] }
  | { BoundedMarket: { max_price: string; min_price: string } };

/**
 * Order type variants.
 *
 * - `"Spot"` — Standard limit order (default)
 * - `"FillOrKill"` — Must fill entirely or be rejected
 * - `"PostOnly"` — Guaranteed maker; rejected if it would match
 * - `"Market"` — Executes at best available price
 * - `{ Limit: [price, timestamp] }` — Limit with time-in-force (price is {@link Numeric})
 * - `{ BoundedMarket: { max_price, min_price } }` — Market with price bounds (prices are {@link Numeric})
 */
export type OrderType =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: [Numeric, string] }
  | { BoundedMarket: { max_price: Numeric; min_price: Numeric } };

/**
 * Create a Limit order type with named parameters.
 *
 * @param price - Limit price as human-readable string (e.g., `"0.025"`) or raw bigint
 * @param timestamp - Time-in-force expiry (Unix seconds as string)
 *
 * @example
 * ```ts
 * const ot = limitOrder("0.025", String(Math.floor(Date.now() / 1000)));
 * ```
 */
export function limitOrder(price: Numeric, timestamp?: string): OrderType {
  return { Limit: [price, timestamp ?? "0"] };
}

/**
 * Create a BoundedMarket order type with named parameters.
 *
 * @param maxPrice - Maximum acceptable price as human-readable string or raw bigint
 * @param minPrice - Minimum acceptable price as human-readable string or raw bigint
 *
 * @example
 * ```ts
 * const ot = boundedMarketOrder("0.03", "0.01");
 * ```
 */
export function boundedMarketOrder(maxPrice: Numeric, minPrice: Numeric): OrderType {
  return { BoundedMarket: { max_price: maxPrice, min_price: minPrice } };
}

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
  /** Unique order identifier. */
  order_id: OrderId;
  /** Order side. */
  side: Side;
  /** Order type. */
  order_type: OrderType;
  /** Total quantity (chain integer). */
  quantity: bigint;
  /** Filled quantity (chain integer). */
  quantity_fill?: bigint;
  /** Originally desired quantity. */
  desired_quantity?: bigint;
  /** Order price (chain integer). */
  price: bigint;
  /** Volume-weighted fill price. */
  price_fill?: bigint;
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
  market_id?: MarketId;
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
  market_id: MarketId;
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
  /** Total trade value in quote asset (chain integer). */
  total: bigint;
  /** Trade quantity in base asset (chain integer). */
  quantity: bigint;
  /** Trade price (chain integer). */
  price: bigint;
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
  /** Amount locked in open orders (chain integer). */
  locked: bigint;
  /** Amount available for new orders (chain integer). */
  unlocked: bigint;
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
  /** Total locked across all order books (chain integer). */
  total_locked: bigint;
  /** Total unlocked across all order books (chain integer). */
  total_unlocked: bigint;
  /** Total balance in the trading account (chain integer). */
  trading_account_balance: bigint;
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
 * A batch of actions targeting a specific market (wire format).
 */
export interface MarketActions {
  /** The target market identifier. */
  market_id: MarketId;
  /** The actions to execute on this market. */
  actions: ActionPayload[];
}

/**
 * Payload for a CreateOrder action.
 */
export interface CreateOrderPayload {
  CreateOrder: {
    /** Order side (API wire format: "Buy" | "Sell"). */
    side: string;
    /** Order price (chain integer string). */
    price: string;
    /** Order quantity (chain integer string). */
    quantity: string;
    /** Order type (wire format with chain integer strings). */
    order_type: WireOrderType;
  };
}

/**
 * Payload for a CancelOrder action.
 */
export interface CancelOrderPayload {
  CancelOrder: {
    /** The order ID to cancel (0x-prefixed hex). */
    order_id: OrderId;
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
 * Union of all possible action payloads for session actions (wire format).
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
  trade_account_id: TradeAccountId;
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
 * Response from a session actions submission.
 *
 * Includes both success and error fields for accurate success checking.
 * A reverted tx can still have a `txId` — check `.success` to distinguish.
 *
 * @example
 * ```ts
 * const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "100");
 * if (response.success) {
 *   console.log(`TX: ${response.txId}`);
 *   console.log(`Orders: ${response.orders?.length}`);
 * } else {
 *   console.log(`Failed: ${response.reason ?? response.message}`);
 * }
 * ```
 */
export class SessionActionsResponse {
  /** On-chain transaction ID, or `null` if preflight error. */
  readonly txId: TxId | null;
  /** Created/updated orders (if `collect_orders` was `true`). */
  readonly orders: Order[] | null;
  /** On-chain revert reason (e.g., `"NotEnoughBalance"`). */
  readonly reason: string | null;
  /** Transaction receipts from on-chain reverts. */
  readonly receipts: unknown[] | null;
  /** Error code (present for pre-flight validation errors). */
  readonly code: number | null;
  /** Error message. */
  readonly message: string | null;

  constructor(
    txId: TxId | null,
    orders: Order[] | null,
    reason: string | null,
    receipts: unknown[] | null,
    code: number | null,
    message: string | null,
  ) {
    this.txId = txId;
    this.orders = orders;
    this.reason = reason;
    this.receipts = receipts;
    this.code = code;
    this.message = message;
  }

  /** `true` if the transaction succeeded without reverts or errors. */
  get success(): boolean {
    return this.txId != null && this.reason == null && this.code == null;
  }

  /** `true` if this is a pre-flight validation error. */
  get isPreflightError(): boolean {
    return this.code != null;
  }

  /** `true` if the transaction was submitted but reverted on-chain. */
  get isOnChainRevert(): boolean {
    return this.reason != null;
  }

  /**
   * Parse a raw API response body into a {@link SessionActionsResponse}.
   */
  static fromResponse(
    data: Record<string, unknown>,
    parseOrderFn: (raw: Record<string, unknown>) => Order,
  ): SessionActionsResponse {
    const rawTxId = typeof data.tx_id === "string" ? txId(data.tx_id) : null;
    const rawOrders = Array.isArray(data.orders)
      ? (data.orders as Record<string, unknown>[]).map(parseOrderFn)
      : null;
    const reason = typeof data.reason === "string" ? data.reason : null;
    const receipts = Array.isArray(data.receipts) ? data.receipts : null;
    const code = typeof data.code === "number" ? data.code : null;
    const message = typeof data.message === "string" ? data.message : null;

    return new SessionActionsResponse(rawTxId, rawOrders, reason, receipts, code, message);
  }
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
  trade_account_id: TradeAccountId;
  /** Owner wallet signature over the withdraw signing bytes. */
  signature: Signature;
  /** Current nonce (as string). */
  nonce: string;
  /** Destination identity for the withdrawn funds. */
  to: Identity;
  /** Asset ID to withdraw (0x-prefixed hex). */
  asset_id: AssetId;
  /** Amount to withdraw (chain integer string). */
  amount: string;
}

/**
 * Response from a successful withdrawal.
 */
export interface WithdrawResponse {
  /** On-chain transaction ID. */
  tx_id: TxId;
}

// ── Whitelist ───────────────────────────────────────────────────────

/**
 * Request body for whitelisting a trading account.
 */
export interface WhitelistRequest {
  /** The trade account contract ID to whitelist. */
  tradeAccount: TradeAccountId;
}

/**
 * Response from the whitelist endpoint.
 */
export interface WhitelistResponse {
  /** Whether the whitelist operation succeeded. */
  success: boolean;
  /** The whitelisted trade account contract ID. */
  tradeAccount: TradeAccountId;
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
  /** Unique asset identifier. */
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
  /** Bid levels as `[price, quantity]` pairs. */
  bids: [string, string][];
  /** Ask levels as `[price, quantity]` pairs. */
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
  /** Lowest ask (sell) price. */
  lowest_ask: string;
  /** Highest bid (buy) price. */
  highest_bid: string;
  /** 24-hour base asset volume. */
  base_volume: string;
  /** 24-hour quote asset volume. */
  quote_volume: string;
  /** 24-hour price change as a percentage string. */
  price_change_percent_24h: string;
  /** 24-hour highest price. */
  highest_price_24h: string;
  /** 24-hour lowest price. */
  lowest_price_24h: string;
}

/**
 * Ticker data for a trading pair (CoinGecko-compatible format).
 */
export interface PairTicker {
  /** Ticker identifier (e.g., `"fFUEL_fUSDC"`). */
  ticker_id: string;
  /** Base currency symbol. */
  base_currency: string;
  /** Target (quote) currency symbol. */
  target_currency: string;
  /** Last traded price. */
  last_price: string;
  /** 24-hour base currency volume. */
  base_volume: string;
  /** 24-hour target currency volume. */
  target_volume: string;
  /** Highest bid (buy) price. */
  bid: string;
  /** Lowest ask (sell) price. */
  ask: string;
  /** 24-hour highest price. */
  high: string;
  /** 24-hour lowest price. */
  low: string;
}

// ── WebSocket Messages ──────────────────────────────────────────────

/**
 * A WebSocket order update message.
 *
 * Received when orders are created, updated, or cancelled for a subscribed account.
 */
export interface OrderUpdate {
  /** The subscription action type. */
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
 * Received when new trades occur on a subscribed market.
 */
export interface TradeUpdate {
  /** The subscription action type. */
  action: string;
  /** New trades. */
  trades: Trade[];
  /** The market identifier. */
  market_id: MarketId;
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
  /** The subscription action type. */
  action: string;
  /** Updated balance entries (one per affected asset). */
  balance: Array<{
    /** The account identity. */
    identity: Identity;
    /** The asset identifier. */
    asset_id: AssetId;
    /** Total locked across all order books (chain integer). */
    total_locked: bigint;
    /** Total unlocked across all order books (chain integer). */
    total_unlocked: bigint;
    /** Total balance in the trading account (chain integer). */
    trading_account_balance: bigint;
    /** Per-order-book balance breakdown. */
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
 * Received when the nonce changes for a subscribed account.
 */
export interface NonceUpdate {
  /** The subscription action type. */
  action: string;
  /** The trade account contract ID. */
  contract_id: TradeAccountId;
  /** The new nonce value. */
  nonce: bigint;
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
 * Errors come in two formats:
 * - Pre-flight validation errors: `code` + `message` (no transaction submitted)
 * - On-chain reverts: `reason` + `receipts` (transaction submitted but reverted)
 */
export interface O2ErrorResponse {
  /** Error code (present for pre-flight validation errors). */
  code?: number;
  /** Error message. */
  message: string;
  /** On-chain revert reason (e.g., `"NotEnoughBalance"`). */
  reason?: string;
  /** Transaction receipts from on-chain reverts. */
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
 * const session = await client.createSession(wallet, ["fFUEL/fUSDC"]);
 * console.log(session.tradeAccountId); // "0x..."
 * console.log(session.expiry);         // Unix seconds
 * ```
 */
export interface SessionState {
  /** The owner wallet's b256 address. */
  ownerAddress: string;
  /** The trade account contract ID. */
  tradeAccountId: TradeAccountId;
  /** The session key's private key (32 bytes). */
  sessionPrivateKey: Uint8Array;
  /** The session key's b256 address. */
  sessionAddress: string;
  /** Contract IDs the session is authorized for. */
  contractIds: ContractId[];
  /** Session expiry (Unix seconds). */
  expiry: number;
  /** Current nonce (auto-incremented after each action). */
  nonce: bigint;
}

/**
 * Internal wallet state managed by {@link O2Client}.
 *
 * Extends the {@link Signer} interface with the private key and wallet
 * metadata. Returned by wallet generation/loading methods and passed to
 * {@link O2Client.setupAccount} and {@link O2Client.createSession}.
 *
 * @example
 * ```ts
 * const wallet = O2Client.generateWallet();
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
 * @param market - The market definition (provides quote decimals).
 * @param chainValue - The price as a chain integer (bigint).
 * @returns The human-readable price as a number.
 *
 * @example
 * ```ts
 * const price = formatPrice(market, 25000000000n); // e.g., 25.0
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
 * @param market - The market definition (provides quote decimals and precision).
 * @param humanPrice - The human-readable price as a number.
 * @returns The scaled price as a chain integer (bigint).
 *
 * @example
 * ```ts
 * const chainPrice = scalePriceForMarket(market, 0.025); // e.g., 25000000n
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
 * @param market - The market definition (provides base decimals).
 * @param chainValue - The quantity as a chain integer (bigint).
 * @returns The human-readable quantity as a number.
 */
export function formatQuantity(market: Market, chainValue: bigint): number {
  return Number(chainValue) / 10 ** market.base.decimals;
}

/**
 * Scale a human-readable quantity to a chain integer.
 *
 * Rounds up to the nearest precision step using ceiling rounding.
 *
 * @param market - The market definition (provides base decimals and precision).
 * @param humanQuantity - The human-readable quantity as a number.
 * @returns The scaled quantity as a chain integer (bigint).
 */
export function scaleQuantityForMarket(market: Market, humanQuantity: number): bigint {
  const scaled = BigInt(Math.ceil(humanQuantity * 10 ** market.base.decimals));
  const truncateFactor = BigInt(10 ** (market.base.decimals - market.base.max_precision));
  const remainder = scaled % truncateFactor;
  if (remainder === 0n) return scaled;
  return scaled + (truncateFactor - remainder);
}

// ── Parsing helpers (used by api.ts) ────────────────────────────────

/** Parse a value to bigint, handling string, number, and bigint inputs. */
export function parseBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

/** Parse a raw API order object into a typed {@link Order}. */
export function parseOrder(raw: Record<string, unknown>): Order {
  const side = raw.side as Side;

  // Normalize order_type: API returns BoundedMarket prices as numbers
  let orderType = raw.order_type as OrderType;
  if (typeof orderType === "object" && orderType !== null && "BoundedMarket" in orderType) {
    const bm = (orderType as { BoundedMarket: { max_price: unknown; min_price: unknown } })
      .BoundedMarket;
    orderType = {
      BoundedMarket: {
        max_price: String(bm.max_price),
        min_price: String(bm.min_price),
      },
    };
  }

  return {
    ...(raw as unknown as Order),
    order_id: orderId(raw.order_id as string),
    side,
    order_type: orderType,
    price: parseBigInt(raw.price),
    quantity: parseBigInt(raw.quantity),
    quantity_fill: raw.quantity_fill != null ? parseBigInt(raw.quantity_fill) : undefined,
    price_fill: raw.price_fill != null ? parseBigInt(raw.price_fill) : undefined,
    desired_quantity: raw.desired_quantity != null ? parseBigInt(raw.desired_quantity) : undefined,
    market_id: raw.market_id != null ? marketId(raw.market_id as string) : undefined,
  };
}

/** Parse a raw depth level into a typed {@link DepthLevel}. */
export function parseDepthLevel(raw: Record<string, unknown>): DepthLevel {
  return {
    price: parseBigInt(raw.price),
    quantity: parseBigInt(raw.quantity),
  };
}

/** Parse a raw trade into a typed {@link Trade}. */
export function parseTrade(raw: Record<string, unknown>): Trade {
  return {
    ...(raw as unknown as Trade),
    side: raw.side as Side,
    price: parseBigInt(raw.price),
    quantity: parseBigInt(raw.quantity),
    total: parseBigInt(raw.total),
  };
}

/** Parse a raw order book balance into a typed {@link OrderBookBalance}. */
export function parseOrderBookBalance(raw: Record<string, unknown>): OrderBookBalance {
  return {
    locked: parseBigInt(raw.locked),
    unlocked: parseBigInt(raw.unlocked),
  };
}

/** Parse a raw balance response into a typed {@link BalanceResponse}. */
export function parseBalanceResponse(raw: Record<string, unknown>): BalanceResponse {
  const rawBooks = (raw.order_books ?? {}) as Record<string, Record<string, unknown>>;
  const parsedBooks: Record<string, OrderBookBalance> = {};
  for (const [key, val] of Object.entries(rawBooks)) {
    parsedBooks[key] = parseOrderBookBalance(val);
  }
  return {
    order_books: parsedBooks,
    total_locked: parseBigInt(raw.total_locked),
    total_unlocked: parseBigInt(raw.total_unlocked),
    trading_account_balance: parseBigInt(raw.trading_account_balance),
  };
}

/** Parse a raw market into a typed {@link Market}. */
export function parseMarket(raw: Record<string, unknown>): Market {
  const base = raw.base as Record<string, unknown>;
  const quote = raw.quote as Record<string, unknown>;
  return {
    ...(raw as unknown as Market),
    contract_id: contractId(raw.contract_id as string),
    market_id: marketId(raw.market_id as string),
    maker_fee: parseBigInt(raw.maker_fee),
    taker_fee: parseBigInt(raw.taker_fee),
    min_order: parseBigInt(raw.min_order),
    dust: parseBigInt(raw.dust),
    base: {
      ...(base as unknown as MarketAsset),
      asset: assetId(base.asset as string),
    },
    quote: {
      ...(quote as unknown as MarketAsset),
      asset: assetId(quote.asset as string),
    },
  };
}

/** Parse a raw balance update (WebSocket) into a typed {@link BalanceUpdate}. */
export function parseBalanceUpdate(raw: Record<string, unknown>): BalanceUpdate {
  const rawBalance = (raw.balance ?? []) as Record<string, unknown>[];
  return {
    ...(raw as unknown as BalanceUpdate),
    balance: rawBalance.map((entry) => {
      const rawBooks = (entry.order_books ?? {}) as Record<string, Record<string, unknown>>;
      const parsedBooks: Record<string, OrderBookBalance> = {};
      for (const [key, val] of Object.entries(rawBooks)) {
        parsedBooks[key] = parseOrderBookBalance(val);
      }
      return {
        identity: entry.identity as Identity,
        asset_id: assetId(entry.asset_id as string),
        total_locked: parseBigInt(entry.total_locked),
        total_unlocked: parseBigInt(entry.total_unlocked),
        trading_account_balance: parseBigInt(entry.trading_account_balance),
        order_books: parsedBooks,
      };
    }),
  };
}

/** Parse a raw nonce update (WebSocket) into a typed {@link NonceUpdate}. */
export function parseNonceUpdate(raw: Record<string, unknown>): NonceUpdate {
  return {
    ...(raw as unknown as NonceUpdate),
    contract_id: tradeAccountId(raw.contract_id as string),
    nonce: parseBigInt(raw.nonce),
  };
}

/** Parse a raw depth update (WebSocket) into a typed {@link DepthUpdate}. */
export function parseDepthUpdate(raw: Record<string, unknown>): DepthUpdate {
  const result: DepthUpdate = {
    ...(raw as unknown as DepthUpdate),
    market_id: marketId(raw.market_id as string),
  };

  if (raw.changes) {
    const changes = raw.changes as Record<string, unknown>;
    result.changes = {
      buys: ((changes.buys ?? []) as Record<string, unknown>[]).map(parseDepthLevel),
      sells: ((changes.sells ?? []) as Record<string, unknown>[]).map(parseDepthLevel),
    };
  }

  if (raw.view) {
    const view = raw.view as Record<string, unknown>;
    result.view = {
      buys: ((view.buys ?? []) as Record<string, unknown>[]).map(parseDepthLevel),
      sells: ((view.sells ?? []) as Record<string, unknown>[]).map(parseDepthLevel),
    };
  }

  return result;
}

/** Parse a raw order update (WebSocket) into a typed {@link OrderUpdate}. */
export function parseOrderUpdate(raw: Record<string, unknown>): OrderUpdate {
  const rawOrders = (raw.orders ?? []) as Record<string, unknown>[];
  return {
    ...(raw as unknown as OrderUpdate),
    orders: rawOrders.map(parseOrder),
  };
}

/** Parse a raw trade update (WebSocket) into a typed {@link TradeUpdate}. */
export function parseTradeUpdate(raw: Record<string, unknown>): TradeUpdate {
  const rawTrades = (raw.trades ?? []) as Record<string, unknown>[];
  return {
    ...(raw as unknown as TradeUpdate),
    market_id: marketId(raw.market_id as string),
    trades: rawTrades.map(parseTrade),
  };
}

/** Parse a raw account info response, converting nonce to bigint. */
export function parseAccountInfo(raw: Record<string, unknown>): AccountInfo {
  const ta = raw.trade_account as Record<string, unknown> | null;
  const rawId = raw.trade_account_id as string | null;
  return {
    trade_account_id: rawId ? tradeAccountId(rawId) : null,
    trade_account: ta
      ? {
          ...(ta as unknown as TradeAccount),
          nonce: new Nonce((ta.nonce as string | number | bigint) ?? "0").toBigInt(),
        }
      : null,
    session: raw.session as SessionInfo | null | undefined,
  };
}
