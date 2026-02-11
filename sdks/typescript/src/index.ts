/**
 * O2 Exchange TypeScript SDK
 *
 * Public API exports for the O2 Exchange SDK.
 */

// ── High-level client ─────────────────────────────────────────────
export { O2Client, type O2ClientOptions } from "./client.js";

// ── Config ────────────────────────────────────────────────────────
export {
  Network,
  getNetworkConfig,
  TESTNET,
  DEVNET,
  MAINNET,
  type NetworkConfig,
} from "./config.js";

// ── Crypto ────────────────────────────────────────────────────────
export {
  generateWallet,
  walletFromPrivateKey,
  generateEvmWallet,
  evmWalletFromPrivateKey,
  fuelCompactSign,
  personalSign,
  rawSign,
  evmPersonalSign,
  type Wallet,
  type EvmWallet,
} from "./crypto.js";

// ── Encoding ──────────────────────────────────────────────────────
export {
  u64BE,
  functionSelector,
  encodeIdentity,
  encodeOptionNone,
  encodeOptionSome,
  encodeOptionCallData,
  encodeOrderArgs,
  buildSessionSigningBytes,
  buildActionsSigningBytes,
  actionToCall,
  scalePrice,
  scaleQuantity,
  formatDecimal,
  validateFractionalPrice,
  validateMinOrder,
  concat,
  bytesToHex,
  hexToBytes,
  GAS_MAX,
  type OrderTypeVariant,
  type ContractCall,
  type MarketInfo,
  type ActionJSON,
  type OrderTypeJSON,
  type CreateOrderAction,
  type CancelOrderAction,
  type SettleBalanceAction,
  type RegisterRefererAction,
} from "./encoding.js";

// ── API ───────────────────────────────────────────────────────────
export { O2Api, type O2ApiOptions } from "./api.js";

// ── WebSocket ─────────────────────────────────────────────────────
export { O2WebSocket, type O2WebSocketOptions } from "./websocket.js";

// ── Models ────────────────────────────────────────────────────────
export type {
  Identity,
  IdentityAddress,
  IdentityContractId,
  Signature,
  Secp256k1Signature,
  Market,
  MarketAsset,
  MarketsResponse,
  MarketSummary,
  MarketTicker,
  DepthLevel,
  DepthSnapshot,
  DepthUpdate,
  TradeAccount,
  AccountInfo,
  CreateAccountResponse,
  SessionInfo,
  SessionRequest,
  SessionResponse,
  Side,
  OrderType,
  Order,
  OrdersResponse,
  Trade,
  OrderBookBalance,
  BalanceResponse,
  Bar,
  MarketActions,
  ActionPayload,
  CreateOrderPayload,
  CancelOrderPayload,
  SettleBalancePayload,
  RegisterRefererPayload,
  SessionActionsRequest,
  SessionActionsResponse,
  WithdrawRequest,
  WithdrawResponse,
  WhitelistRequest,
  WhitelistResponse,
  ReferralInfo,
  FaucetResponse,
  AggregatedAsset,
  AggregatedOrderbook,
  PairSummary,
  PairTicker,
  OrderUpdate,
  TradeUpdate,
  BalanceUpdate,
  NonceUpdate,
  O2ErrorResponse,
  SessionState,
  WalletState,
} from "./models.js";
export {
  isAddress,
  isContractId,
  identityValue,
  formatPrice,
  scalePriceForMarket,
  formatQuantity,
  scaleQuantityForMarket,
} from "./models.js";

// ── Errors ────────────────────────────────────────────────────────
export {
  O2Error,
  InternalError,
  InvalidRequest,
  ParseError,
  RateLimitExceeded,
  GeoRestricted,
  MarketNotFound,
  MarketPaused,
  MarketAlreadyExists,
  OrderNotFound,
  OrderNotActive,
  InvalidOrderParams,
  InvalidSignature,
  InvalidSession,
  AccountNotFound,
  WhitelistNotConfigured,
  TradeNotFound,
  InvalidTradeCount,
  AlreadySubscribed,
  TooManySubscriptions,
  SubscriptionError,
  InvalidAmount,
  InvalidTimeRange,
  InvalidPagination,
  NoActionsProvided,
  TooManyActions,
  BlockNotFound,
  EventsNotFound,
  OnChainRevertError,
  parseApiError,
  isActionsSuccess,
} from "./errors.js";
