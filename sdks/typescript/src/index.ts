/**
 * O2 Exchange TypeScript SDK
 *
 * Public API exports for the O2 Exchange SDK.
 *
 * For internal encoding and crypto utilities, import from
 * `@o2exchange/sdk/internals`.
 */

// ── Actions ───────────────────────────────────────────────────────
export {
  type Action,
  cancelOrderAction,
  createOrderAction,
  type MarketActionGroup,
  type Numeric,
  registerRefererAction,
  settleBalanceAction,
} from "./actions.js";

// ── API ───────────────────────────────────────────────────────────
export { O2Api, type O2ApiOptions } from "./api.js";
// ── High-level client ─────────────────────────────────────────────
export { type CreateOrderOptions, O2Client, type O2ClientOptions } from "./client.js";
// ── Config ────────────────────────────────────────────────────────
export {
  DEVNET,
  getNetworkConfig,
  MAINNET,
  Network,
  type NetworkConfig,
  TESTNET,
} from "./config.js";

// ── Crypto (user-facing types) ────────────────────────────────────
export {
  type EvmWallet,
  ExternalEvmSigner,
  ExternalSigner,
  type SignDigestFn,
  type Signer,
  type Wallet,
} from "./crypto.js";

// ── Errors ────────────────────────────────────────────────────────
export {
  AccountNotFound,
  AlreadySubscribed,
  BlockNotFound,
  EventsNotFound,
  GeoRestricted,
  InternalError,
  InvalidAmount,
  InvalidOrderParams,
  InvalidPagination,
  InvalidRequest,
  InvalidSession,
  InvalidSignature,
  InvalidTimeRange,
  InvalidTradeCount,
  MarketAlreadyExists,
  MarketNotFound,
  MarketPaused,
  NoActionsProvided,
  O2Error,
  OnChainRevertError,
  OrderNotActive,
  OrderNotFound,
  ParseError,
  RateLimitExceeded,
  SessionExpired,
  SubscriptionError,
  TooManyActions,
  TooManySubscriptions,
  TradeNotFound,
  WhitelistNotConfigured,
} from "./errors.js";

// ── Models ────────────────────────────────────────────────────────
export type {
  AccountInfo,
  AggregatedAsset,
  AggregatedOrderbook,
  AssetId,
  BalanceResponse,
  BalanceUpdate,
  Bar,
  ContractId,
  CreateAccountResponse,
  DepthLevel,
  DepthSnapshot,
  DepthUpdate,
  FaucetResponse,
  HexId,
  Identity,
  IdentityAddress,
  IdentityContractId,
  Market,
  MarketAsset,
  MarketId,
  MarketSummary,
  MarketsResponse,
  MarketTicker,
  NonceUpdate,
  O2ErrorResponse,
  Order,
  OrderBookBalance,
  OrderId,
  OrdersResponse,
  OrderType,
  OrderUpdate,
  PairSummary,
  PairTicker,
  ReferralInfo,
  SessionInfo,
  SessionRequest,
  SessionResponse,
  SessionState,
  Side,
  Signature,
  Trade,
  TradeAccount,
  TradeAccountId,
  TradeUpdate,
  TxId,
  WalletState,
  WhitelistResponse,
  WithdrawRequest,
  WithdrawResponse,
} from "./models.js";
export {
  assetId,
  boundedMarketOrder,
  contractId,
  formatPrice,
  formatQuantity,
  hexId,
  identityValue,
  isAddress,
  isContractId,
  limitOrder,
  marketId,
  Nonce,
  orderId,
  SessionActionsResponse,
  scalePriceForMarket,
  scaleQuantityForMarket,
  tradeAccountId,
  txId,
} from "./models.js";

// ── WebSocket ─────────────────────────────────────────────────────
export { O2WebSocket, type O2WebSocketOptions } from "./websocket.js";
