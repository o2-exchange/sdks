/**
 * Internal encoding and crypto utilities for advanced O2 SDK users.
 *
 * These are low-level primitives used by the SDK internally. Import from
 * `@o2exchange/sdk/internals` only if you need direct access to Fuel ABI
 * encoding, signing helpers, or contract call construction.
 *
 * @module
 */

// ── Crypto ────────────────────────────────────────────────────────
export {
  evmPersonalSign,
  evmPersonalSignDigest,
  evmWalletFromPrivateKey,
  fuelCompactSign,
  fuelPersonalSignDigest,
  generateEvmWallet,
  generateWallet,
  personalSign,
  rawSign,
  toFuelCompactSignature,
  walletFromPrivateKey,
} from "./crypto.js";
// ── Encoding ──────────────────────────────────────────────────────
export {
  type ActionJSON,
  actionToCall,
  adjustQuantityForFractionalPrice,
  buildActionsSigningBytes,
  buildSessionSigningBytes,
  buildWithdrawSigningBytes,
  bytesToHex,
  type CancelOrderAction,
  type CancelTriggerOrderAction,
  type ContractCall,
  type CreateOrderAction,
  type CreateOrderWithTriggersAction,
  type CreateTriggerOrderAction,
  type CreateTriggerOrdersAction,
  concat,
  encodeIdentity,
  encodeOptionCallData,
  encodeOptionNone,
  encodeOptionSome,
  encodeOrderArgs,
  encodeTriggerOrderArgs,
  formatDecimal,
  functionSelector,
  GAS_MAX,
  hexToBytes,
  type MarketInfo,
  type OrderTypeJSON,
  type OrderTypeVariant,
  type RegisterRefererAction,
  type SettleBalanceAction,
  scaleDecimalString,
  scalePrice,
  scalePriceString,
  scaleQuantity,
  scaleQuantityString,
  type TriggerOrderArgsJSON,
  type TriggerOrderTypeJSON,
  type TriggerQuantityJSON,
  u64BE,
  validateFractionalPrice,
  validateMinOrder,
} from "./encoding.js";
