/**
 * TypeScript interfaces for all O2 Exchange API types.
 */

// ── Identity ────────────────────────────────────────────────────────

export interface IdentityAddress {
  Address: string;
}

export interface IdentityContractId {
  ContractId: string;
}

export type Identity = IdentityAddress | IdentityContractId;

export function isAddress(id: Identity): id is IdentityAddress {
  return "Address" in id;
}

export function isContractId(id: Identity): id is IdentityContractId {
  return "ContractId" in id;
}

export function identityValue(id: Identity): string {
  return isAddress(id) ? id.Address : id.ContractId;
}

// ── Signature ───────────────────────────────────────────────────────

export interface Secp256k1Signature {
  Secp256k1: string; // 0x-prefixed 128-char hex
}

export type Signature = Secp256k1Signature;

// ── Market ──────────────────────────────────────────────────────────

export interface MarketAsset {
  symbol: string;
  asset: string;
  decimals: number;
  max_precision: number;
}

export interface Market {
  contract_id: string;
  market_id: string;
  maker_fee: string;
  taker_fee: string;
  min_order: string;
  dust: string;
  price_window: number;
  base: MarketAsset;
  quote: MarketAsset;
}

export interface MarketsResponse {
  books_registry_id: string;
  accounts_registry_id: string;
  trade_account_oracle_id: string;
  chain_id: string;
  base_asset_id: string;
  markets: Market[];
}

export interface MarketSummary {
  market_id: string;
  price: string;
  price_change_percent_24h: string;
  highest_price_24h: string;
  lowest_price_24h: string;
  base_volume: string;
  quote_volume: string;
}

export interface MarketTicker {
  market_id: string;
  last_price: string;
  base_volume: string;
  quote_volume: string;
  best_ask: string;
  best_bid: string;
}

// ── Depth ───────────────────────────────────────────────────────────

export interface DepthLevel {
  price: string;
  quantity: string;
}

export interface DepthSnapshot {
  buys: DepthLevel[];
  sells: DepthLevel[];
}

export interface DepthUpdate {
  action: string;
  changes?: { buys: DepthLevel[]; sells: DepthLevel[] };
  view?: { buys: DepthLevel[]; sells: DepthLevel[] };
  market_id: string;
  onchain_timestamp?: string;
  seen_timestamp?: string;
}

// ── Account ─────────────────────────────────────────────────────────

export interface TradeAccount {
  last_modification: number;
  nonce: string;
  owner: Identity;
  synced_with_network?: boolean;
  sync_state?: unknown;
}

export interface AccountInfo {
  trade_account_id: string | null;
  trade_account: TradeAccount | null;
  session?: SessionInfo | null;
}

export interface CreateAccountResponse {
  trade_account_id: string;
  nonce: string;
}

// ── Session ─────────────────────────────────────────────────────────

export interface SessionInfo {
  session_id: Identity;
  contract_ids: string[];
  expiry: string;
}

export interface SessionRequest {
  contract_id: string;
  session_id: Identity;
  signature: Signature;
  contract_ids: string[];
  nonce: string;
  expiry: string;
}

export interface SessionResponse {
  tx_id: string;
  trade_account_id: string;
  contract_ids: string[];
  session_id: Identity;
  session_expiry: string;
}

// ── Orders ──────────────────────────────────────────────────────────

export type Side = "Buy" | "Sell";

export type OrderType =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: [string, string] }
  | { BoundedMarket: { max_price: string; min_price: string } };

export interface Order {
  order_id: string;
  side: Side;
  order_type: OrderType;
  quantity: string;
  quantity_fill?: string;
  desired_quantity?: string;
  price: string;
  price_fill?: string;
  timestamp: string | number;
  close: boolean;
  partially_filled?: boolean;
  cancel?: boolean;
  base_decimals?: number;
  account?: Identity;
  fill?: unknown;
  order_tx_history?: unknown[];
  history?: unknown[];
  fills?: unknown[];
  market_id?: string;
  owner?: Identity;
}

export interface OrdersResponse {
  identity: Identity;
  market_id: string;
  orders: Order[];
}

// ── Trades ──────────────────────────────────────────────────────────

export interface Trade {
  trade_id: string;
  side: Side;
  total: string;
  quantity: string;
  price: string;
  timestamp: string;
  maker?: Identity;
  taker?: Identity;
}

// ── Balance ─────────────────────────────────────────────────────────

export interface OrderBookBalance {
  locked: string;
  unlocked: string;
}

export interface BalanceResponse {
  order_books: Record<string, OrderBookBalance>;
  total_locked: string;
  total_unlocked: string;
  trading_account_balance: string;
}

// ── Bars / Candles ──────────────────────────────────────────────────

export interface Bar {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── Session Actions ─────────────────────────────────────────────────

export interface MarketActions {
  market_id: string;
  actions: ActionPayload[];
}

export interface CreateOrderPayload {
  CreateOrder: {
    side: Side;
    price: string;
    quantity: string;
    order_type: OrderType;
  };
}

export interface CancelOrderPayload {
  CancelOrder: {
    order_id: string;
  };
}

export interface SettleBalancePayload {
  SettleBalance: {
    to: Identity;
  };
}

export interface RegisterRefererPayload {
  RegisterReferer: {
    to: Identity;
  };
}

export type ActionPayload =
  | CreateOrderPayload
  | CancelOrderPayload
  | SettleBalancePayload
  | RegisterRefererPayload;

export interface SessionActionsRequest {
  actions: MarketActions[];
  signature: Signature;
  nonce: string;
  trade_account_id: string;
  session_id: Identity;
  collect_orders?: boolean;
  variable_outputs?: number;
  min_gas_limit?: string;
  estimate_gas_usage?: boolean;
}

export interface SessionActionsResponse {
  tx_id: string;
  orders?: Order[];
}

// ── Withdraw ────────────────────────────────────────────────────────

export interface WithdrawRequest {
  trade_account_id: string;
  signature: Signature;
  nonce: string;
  to: Identity;
  asset_id: string;
  amount: string;
}

export interface WithdrawResponse {
  tx_id: string;
}

// ── Whitelist ───────────────────────────────────────────────────────

export interface WhitelistRequest {
  tradeAccount: string;
}

export interface WhitelistResponse {
  success: boolean;
  tradeAccount: string;
  alreadyWhitelisted?: boolean;
}

// ── Referral ────────────────────────────────────────────────────────

export interface ReferralInfo {
  valid: boolean;
  ownerAddress: string;
  isActive: boolean;
}

// ── Faucet ──────────────────────────────────────────────────────────

export interface FaucetResponse {
  message?: string;
  error?: string;
}

// ── Aggregated ──────────────────────────────────────────────────────

export interface AggregatedAsset {
  id: string;
  name: string;
  symbol: string;
}

export interface AggregatedOrderbook {
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

export interface PairSummary {
  trading_pairs: string;
  last_price: string;
  lowest_ask: string;
  highest_bid: string;
  base_volume: string;
  quote_volume: string;
  price_change_percent_24h: string;
  highest_price_24h: string;
  lowest_price_24h: string;
}

export interface PairTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
}

// ── WebSocket Messages ──────────────────────────────────────────────

export interface OrderUpdate {
  action: string;
  orders: Order[];
  onchain_timestamp?: string;
  seen_timestamp?: string;
}

export interface TradeUpdate {
  action: string;
  trades: Trade[];
  market_id: string;
  onchain_timestamp?: string;
  seen_timestamp?: string;
}

export interface BalanceUpdate {
  action: string;
  balance: Array<{
    identity: Identity;
    asset_id: string;
    total_locked: string;
    total_unlocked: string;
    trading_account_balance: string;
    order_books: Record<string, OrderBookBalance>;
  }>;
  onchain_timestamp?: string;
  seen_timestamp?: string;
}

export interface NonceUpdate {
  action: string;
  contract_id: string;
  nonce: string;
  onchain_timestamp?: string;
  seen_timestamp?: string;
}

// ── Error Response ──────────────────────────────────────────────────

export interface O2ErrorResponse {
  code?: number;
  message: string;
  reason?: string;
  receipts?: unknown[];
}

// ── Session State (high-level client) ───────────────────────────────

export interface SessionState {
  ownerAddress: string;
  tradeAccountId: string;
  sessionPrivateKey: Uint8Array;
  sessionAddress: string;
  contractIds: string[];
  expiry: number;
  nonce: bigint;
  isEvm: boolean;
}

export interface WalletState {
  privateKey: Uint8Array;
  b256Address: string;
  isEvm: boolean;
  evmAddress?: string;
}

// ── Market helpers ──────────────────────────────────────────────────

/** Format a chain-integer price to human-readable. */
export function formatPrice(market: Market, chainValue: bigint): number {
  return Number(chainValue) / 10 ** market.quote.decimals;
}

/** Scale a human-readable price to chain integer. */
export function scalePriceForMarket(market: Market, humanPrice: number): bigint {
  const scaled = BigInt(Math.floor(humanPrice * 10 ** market.quote.decimals));
  const truncateFactor = BigInt(
    10 ** (market.quote.decimals - market.quote.max_precision)
  );
  return (scaled / truncateFactor) * truncateFactor;
}

/** Format a chain-integer quantity to human-readable. */
export function formatQuantity(market: Market, chainValue: bigint): number {
  return Number(chainValue) / 10 ** market.base.decimals;
}

/** Scale a human-readable quantity to chain integer. */
export function scaleQuantityForMarket(
  market: Market,
  humanQuantity: number
): bigint {
  const scaled = BigInt(Math.ceil(humanQuantity * 10 ** market.base.decimals));
  const truncateFactor = BigInt(
    10 ** (market.base.decimals - market.base.max_precision)
  );
  const remainder = scaled % truncateFactor;
  if (remainder === 0n) return scaled;
  return scaled + (truncateFactor - remainder);
}
