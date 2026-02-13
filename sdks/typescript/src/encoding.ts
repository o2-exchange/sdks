/**
 * Fuel ABI encoding primitives for O2 Exchange.
 *
 * Implements the exact byte layouts specified in the instruction guide:
 * - u64 big-endian encoding
 * - Identity encoding (Address / ContractId discriminant + 32 bytes)
 * - Option encoding (None / Some)
 * - Vec encoding (length prefix + elements)
 * - Function selectors (NOT hash-based: u64(len) + utf8(name))
 * - OrderArgs struct encoding (tightly packed enum variants)
 * - Session signing bytes (set_session)
 * - Action signing bytes (session/actions)
 */

// ── Primitives ──────────────────────────────────────────────────────

/** Encode a number or bigint as 8 bytes big-endian (u64). */
export function u64BE(value: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const v = BigInt(value);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, v, false);
  return buf;
}

/** Encode a Fuel ABI function selector: u64_be(len(name)) + utf8(name). */
export function functionSelector(name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  return concat([u64BE(nameBytes.length), nameBytes]);
}

/**
 * Encode a Fuel Identity enum.
 * discriminant: 0 = Address, 1 = ContractId
 */
export function encodeIdentity(discriminant: 0 | 1, addressBytes: Uint8Array): Uint8Array {
  return concat([u64BE(discriminant), addressBytes]);
}

/** Encode Option::None: u64(0). */
export function encodeOptionNone(): Uint8Array {
  return u64BE(0);
}

/** Encode Option::Some(data): u64(1) + data. */
export function encodeOptionSome(data: Uint8Array): Uint8Array {
  return concat([u64BE(1), data]);
}

/**
 * Encode Option for call_data in action signing bytes.
 * null/undefined -> u64(0)
 * data           -> u64(1) + u64(len(data)) + data
 */
export function encodeOptionCallData(data: Uint8Array | null | undefined): Uint8Array {
  if (data == null) {
    return u64BE(0);
  }
  return concat([u64BE(1), u64BE(data.length), data]);
}

// ── OrderArgs Encoding ──────────────────────────────────────────────

export type OrderTypeVariant =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: { price: bigint; timestamp: bigint } }
  | { BoundedMarket: { maxPrice: bigint; minPrice: bigint } };

/**
 * Encode OrderArgs struct for CreateOrder call_data.
 * Layout: u64(price) + u64(quantity) + order_type_encoding
 *
 * OrderType variants are tightly packed (no padding):
 *   Limit(0):         u64(0) + u64(price) + u64(timestamp)    [24 bytes]
 *   Spot(1):          u64(1)                                   [8 bytes]
 *   FillOrKill(2):    u64(2)                                   [8 bytes]
 *   PostOnly(3):      u64(3)                                   [8 bytes]
 *   Market(4):        u64(4)                                   [8 bytes]
 *   BoundedMarket(5): u64(5) + u64(maxPrice) + u64(minPrice)  [24 bytes]
 */
export function encodeOrderArgs(
  price: bigint,
  quantity: bigint,
  orderType: OrderTypeVariant,
): Uint8Array {
  const parts: Uint8Array[] = [u64BE(price), u64BE(quantity)];

  if (orderType === "Spot") {
    parts.push(u64BE(1));
  } else if (orderType === "FillOrKill") {
    parts.push(u64BE(2));
  } else if (orderType === "PostOnly") {
    parts.push(u64BE(3));
  } else if (orderType === "Market") {
    parts.push(u64BE(4));
  } else if (typeof orderType === "object" && "Limit" in orderType) {
    parts.push(u64BE(0));
    parts.push(u64BE(orderType.Limit.price));
    parts.push(u64BE(orderType.Limit.timestamp));
  } else if (typeof orderType === "object" && "BoundedMarket" in orderType) {
    parts.push(u64BE(5));
    parts.push(u64BE(orderType.BoundedMarket.maxPrice));
    parts.push(u64BE(orderType.BoundedMarket.minPrice));
  }

  return concat(parts);
}

// ── Session Signing Bytes ───────────────────────────────────────────

/**
 * Build the signing bytes for set_session (Section 4.6 Step 3).
 *
 * Layout:
 *   u64(nonce)
 *   u64(chain_id)
 *   u64(len("set_session")) + "set_session"
 *   u64(1)                 // Option::Some
 *   u64(0)                 // Identity::Address
 *   session_address        // 32 bytes
 *   u64(expiry)
 *   u64(len(contract_ids))
 *   concat(contract_ids)   // 32 bytes each
 */
export function buildSessionSigningBytes(
  nonce: bigint,
  chainId: bigint,
  sessionAddress: Uint8Array,
  contractIds: Uint8Array[],
  expiry: bigint,
): Uint8Array {
  const funcName = new TextEncoder().encode("set_session");
  const parts: Uint8Array[] = [
    u64BE(nonce),
    u64BE(chainId),
    u64BE(funcName.length),
    funcName,
    u64BE(1), // Option::Some
    u64BE(0), // Identity::Address
    sessionAddress,
    u64BE(expiry),
    u64BE(contractIds.length),
    ...contractIds,
  ];
  return concat(parts);
}

// ── Withdraw Signing Bytes ──────────────────────────────────────────

/**
 * Build the signing bytes for a withdrawal.
 *
 * Layout:
 *   u64(nonce) + u64(chain_id) + u64(len("withdraw")) + "withdraw"
 *   + u64(to_discriminant) + to_address(32)
 *   + asset_id(32) + u64(amount)
 */
export function buildWithdrawSigningBytes(
  nonce: bigint,
  chainId: bigint,
  toDiscriminant: 0 | 1,
  toAddress: Uint8Array,
  assetId: Uint8Array,
  amount: bigint,
): Uint8Array {
  const funcName = new TextEncoder().encode("withdraw");
  const parts: Uint8Array[] = [
    u64BE(nonce),
    u64BE(chainId),
    u64BE(funcName.length),
    funcName,
    u64BE(toDiscriminant),
    toAddress,
    assetId,
    u64BE(amount),
  ];
  return concat(parts);
}

// ── Action Signing Bytes ────────────────────────────────────────────

/** Gas value: u64::MAX */
export const GAS_MAX = 18446744073709551615n;

export interface ContractCall {
  contractId: Uint8Array; // 32 bytes
  functionSelector: Uint8Array; // variable length
  amount: bigint;
  assetId: Uint8Array; // 32 bytes
  gas: bigint;
  callData: Uint8Array | null;
}

/**
 * Build action signing bytes (Section 4.7 Step 2).
 *
 * Layout:
 *   u64(nonce)
 *   u64(num_calls)
 *   for each call:
 *     contract_id             (32 bytes)
 *     u64(selector_len)       (8 bytes)
 *     function_selector       (variable)
 *     u64(amount)             (8 bytes)
 *     asset_id                (32 bytes)
 *     u64(gas)                (8 bytes)
 *     encode_option_call_data (8+ bytes)
 */
export function buildActionsSigningBytes(nonce: bigint, calls: ContractCall[]): Uint8Array {
  const parts: Uint8Array[] = [u64BE(nonce), u64BE(calls.length)];

  for (const call of calls) {
    const selector = call.functionSelector;
    parts.push(call.contractId);
    parts.push(u64BE(selector.length));
    parts.push(selector);
    parts.push(u64BE(call.amount));
    parts.push(call.assetId);
    parts.push(u64BE(call.gas));
    parts.push(encodeOptionCallData(call.callData));
  }

  return concat(parts);
}

// ── Action-to-Call Conversion ───────────────────────────────────────

export interface MarketInfo {
  contractId: string; // hex with 0x prefix
  marketId: string;
  base: { asset: string; decimals: number; maxPrecision: number; symbol: string };
  quote: { asset: string; decimals: number; maxPrecision: number; symbol: string };
}

export interface CreateOrderAction {
  CreateOrder: {
    side: "Buy" | "Sell";
    price: string;
    quantity: string;
    order_type: OrderTypeJSON;
  };
}

export type OrderTypeJSON =
  | "Spot"
  | "FillOrKill"
  | "PostOnly"
  | "Market"
  | { Limit: [string, string] }
  | { BoundedMarket: { max_price: string; min_price: string } };

export interface CancelOrderAction {
  CancelOrder: { order_id: string };
}

export interface SettleBalanceAction {
  SettleBalance: { to: { Address?: string; ContractId?: string } };
}

export interface RegisterRefererAction {
  RegisterReferer: { to: { Address?: string; ContractId?: string } };
}

export type ActionJSON =
  | CreateOrderAction
  | CancelOrderAction
  | SettleBalanceAction
  | RegisterRefererAction;

const ZERO_ASSET = new Uint8Array(32);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function parseOrderTypeJSON(ot: OrderTypeJSON): OrderTypeVariant {
  if (typeof ot === "string") {
    switch (ot) {
      case "Spot":
        return "Spot";
      case "FillOrKill":
        return "FillOrKill";
      case "PostOnly":
        return "PostOnly";
      case "Market":
        return "Market";
      default:
        throw new Error(`Unknown order type: ${ot}`);
    }
  }
  if ("Limit" in ot) {
    return {
      Limit: {
        price: BigInt(ot.Limit[0]),
        timestamp: BigInt(ot.Limit[1]),
      },
    };
  }
  if ("BoundedMarket" in ot) {
    return {
      BoundedMarket: {
        maxPrice: BigInt(ot.BoundedMarket.max_price),
        minPrice: BigInt(ot.BoundedMarket.min_price),
      },
    };
  }
  throw new Error(`Unknown order type: ${JSON.stringify(ot)}`);
}

/**
 * Convert a high-level action + market info to a low-level ContractCall.
 * For RegisterReferer, pass accountsRegistryId as the market's contractId.
 */
export function actionToCall(
  action: ActionJSON,
  market: MarketInfo,
  accountsRegistryId?: string,
): ContractCall {
  const contractIdBytes = hexToBytes(market.contractId);

  if ("CreateOrder" in action) {
    const data = action.CreateOrder;
    const price = BigInt(data.price);
    const quantity = BigInt(data.quantity);
    const baseDecimals = market.base.decimals;
    const otVariant = parseOrderTypeJSON(data.order_type);
    const callData = encodeOrderArgs(price, quantity, otVariant);

    let amount: bigint;
    let assetId: Uint8Array;

    if (data.side === "Buy") {
      amount = (price * quantity) / BigInt(10 ** baseDecimals);
      assetId = hexToBytes(market.quote.asset);
    } else {
      amount = quantity;
      assetId = hexToBytes(market.base.asset);
    }

    return {
      contractId: contractIdBytes,
      functionSelector: functionSelector("create_order"),
      amount,
      assetId,
      gas: GAS_MAX,
      callData,
    };
  }

  if ("CancelOrder" in action) {
    const orderId = hexToBytes(action.CancelOrder.order_id);
    return {
      contractId: contractIdBytes,
      functionSelector: functionSelector("cancel_order"),
      amount: 0n,
      assetId: ZERO_ASSET,
      gas: GAS_MAX,
      callData: orderId,
    };
  }

  if ("SettleBalance" in action) {
    const to = action.SettleBalance.to;
    const disc: 0 | 1 = "ContractId" in to ? 1 : 0;
    const addr = hexToBytes((to.ContractId ?? to.Address)!);
    return {
      contractId: contractIdBytes,
      functionSelector: functionSelector("settle_balance"),
      amount: 0n,
      assetId: ZERO_ASSET,
      gas: GAS_MAX,
      callData: encodeIdentity(disc, addr),
    };
  }

  if ("RegisterReferer" in action) {
    if (!accountsRegistryId) {
      throw new Error("accountsRegistryId required for RegisterReferer");
    }
    const to = action.RegisterReferer.to;
    const disc: 0 | 1 = "ContractId" in to ? 1 : 0;
    const addr = hexToBytes((to.ContractId ?? to.Address)!);
    return {
      contractId: hexToBytes(accountsRegistryId),
      functionSelector: functionSelector("register_referer"),
      amount: 0n,
      assetId: ZERO_ASSET,
      gas: GAS_MAX,
      callData: encodeIdentity(disc, addr),
    };
  }

  throw new Error(`Unknown action type: ${JSON.stringify(action)}`);
}

// ── Decimal Helpers ─────────────────────────────────────────────────

/**
 * Precisely scale a decimal string to a chain integer without float intermediaries.
 *
 * Algorithm:
 * 1. Split on `.` to get whole and fractional parts
 * 2. Pad/truncate fractional part to `decimals` digits
 * 3. Concatenate and parse as bigint
 *
 * @param value - Decimal string (e.g., `"0.02"`, `"100.5"`)
 * @param decimals - Number of decimal places to scale to
 * @returns The scaled bigint value
 *
 * @example
 * ```ts
 * scaleDecimalString("0.02", 9) // 20000000n
 * scaleDecimalString("100", 9)  // 100000000000n
 * ```
 */
export function scaleDecimalString(value: string, decimals: number): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const paddedFrac = frac.slice(0, decimals).padEnd(decimals, "0");
  return BigInt((whole || "0") + paddedFrac);
}

/**
 * Scale a decimal string price to a chain integer, truncated to max_precision.
 * Uses floor truncation for prices. No float intermediary.
 */
export function scalePriceString(value: string, decimals: number, maxPrecision: number): bigint {
  const scaled = scaleDecimalString(value, decimals);
  const truncateFactor = BigInt(10 ** (decimals - maxPrecision));
  return (scaled / truncateFactor) * truncateFactor;
}

/**
 * Scale a decimal string quantity to a chain integer, truncated to max_precision.
 * Uses ceil truncation for quantities to avoid rounding to zero. No float intermediary.
 */
export function scaleQuantityString(value: string, decimals: number, maxPrecision: number): bigint {
  const scaled = scaleDecimalString(value, decimals);
  const truncateFactor = BigInt(10 ** (decimals - maxPrecision));
  const remainder = scaled % truncateFactor;
  if (remainder === 0n) return scaled;
  return scaled + (truncateFactor - remainder);
}

/**
 * Scale a human-readable price to a chain integer, truncated to max_precision.
 * Uses floor truncation for prices.
 */
export function scalePrice(humanPrice: number, decimals: number, maxPrecision: number): bigint {
  const scaled = BigInt(Math.floor(humanPrice * 10 ** decimals));
  const truncateFactor = BigInt(10 ** (decimals - maxPrecision));
  return (scaled / truncateFactor) * truncateFactor;
}

/**
 * Scale a human-readable quantity to a chain integer, truncated to max_precision.
 * Uses ceil truncation for quantities to avoid rounding to zero.
 */
export function scaleQuantity(
  humanQuantity: number,
  decimals: number,
  maxPrecision: number,
): bigint {
  const scaled = BigInt(Math.ceil(humanQuantity * 10 ** decimals));
  const truncateFactor = BigInt(10 ** (decimals - maxPrecision));
  const remainder = scaled % truncateFactor;
  if (remainder === 0n) return scaled;
  return scaled + (truncateFactor - remainder);
}

/** Convert a chain integer back to a human-readable number. */
export function formatDecimal(chainValue: bigint, decimals: number): number {
  return Number(chainValue) / 10 ** decimals;
}

/**
 * Validate FractionalPrice: (price * quantity) % 10^base_decimals must be 0.
 */
export function validateFractionalPrice(
  price: bigint,
  quantity: bigint,
  baseDecimals: number,
): boolean {
  return (price * quantity) % BigInt(10 ** baseDecimals) === 0n;
}

/**
 * Validate min_order: (price * quantity) / 10^base_decimals >= min_order.
 */
export function validateMinOrder(
  price: bigint,
  quantity: bigint,
  baseDecimals: number,
  minOrder: bigint,
): boolean {
  return (price * quantity) / BigInt(10 ** baseDecimals) >= minOrder;
}

// ── Utilities ───────────────────────────────────────────────────────

/** Concatenate multiple Uint8Arrays. */
export function concat(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/** Convert bytes to 0x-prefixed hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export { hexToBytes };
