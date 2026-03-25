/**
 * Decode Fuel VM revert codes into human-readable contract error names.
 *
 * Ports the Rust/Python implementation. Fuel's `revert_with_log` / `require`
 * uses the convention:
 *
 *     raw_code = 0xffffffffffff0000 | ordinal_1_based
 *
 * This module extracts `Revert(DIGITS)` patterns from error messages, decodes
 * the ordinal into a named enum variant, and augments the reason string so
 * users see e.g. `OrderCreationError::OrderPartiallyFilled` instead of a raw u64.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// ABI error enum mapping (1-based ordinals)
//
// Source of truth: abi/mainnet/*.json (metadataTypes → enum components).
// See CLAUDE.md "Maintaining On-Chain Revert Decoding" for update procedure.
// ---------------------------------------------------------------------------

const ABI_ERROR_ENUMS: readonly [string, readonly string[]][] = [
  [
    "contract_schema::blacklist::BlacklistError",
    ["TraderAlreadyBlacklisted", "TraderNotBlacklisted"],
  ],
  ["contract_schema::order_book::FeeError", ["NoFeesAvailable"]],
  [
    "contract_schema::order_book::OrderBookInitializationError",
    [
      "InvalidAsset",
      "InvalidDecimals",
      "InvalidPriceWindow",
      "InvalidPricePrecision",
      "OwnerNotSet",
      "InvalidMinOrder",
    ],
  ],
  [
    "contract_schema::order_book::OrderCancelError",
    ["NotOrderOwner", "TraderNotBlacklisted", "NoBlacklist"],
  ],
  [
    "contract_schema::order_book::OrderCreationError",
    [
      "InvalidOrderArgs",
      "InvalidInputAmount",
      "InvalidAsset",
      "PriceExceedsRange",
      "PricePrecision",
      "InvalidHeapPrices",
      "FractionalPrice",
      "OrderNotFilled",
      "OrderPartiallyFilled",
      "TraderNotWhiteListed",
      "TraderBlackListed",
      "InvalidMarketOrder",
      "InvalidMarketOrderArgs",
    ],
  ],
  [
    "contract_schema::register::OrderBookRegistryError",
    ["MarketAlreadyHasOrderBook", "InvalidPair"],
  ],
  [
    "contract_schema::register::TradeAccountRegistryError",
    ["OwnerAlreadyHasTradeAccount", "TradeAccountNotRegistered", "TradeAccountAlreadyHasReferer"],
  ],
  ["contract_schema::trade_account::CallerError", ["InvalidCaller"]],
  ["contract_schema::trade_account::NonceError", ["InvalidNonce"]],
  [
    "contract_schema::trade_account::SessionError",
    ["SessionInThePast", "NoApprovedContractIdsProvided"],
  ],
  ["contract_schema::trade_account::SignerError", ["InvalidSigner", "ProxyOwnerIsContract"]],
  ["contract_schema::trade_account::WithdrawError", ["AmountIsZero", "NotEnoughBalance"]],
  [
    "contract_schema::whitelist::WhitelistError",
    ["TraderAlreadyWhitelisted", "TraderNotWhitelisted"],
  ],
  ["ownership::errors::InitializationError", ["CannotReinitialized"]],
  ["pausable::errors::PauseError", ["Paused", "NotPaused"]],
  ["src5::AccessError", ["NotOwner"]],
  [
    "std::crypto::signature_error::SignatureError",
    ["UnrecoverablePublicKey", "InvalidPublicKey", "InvalidSignature", "InvalidOperation"],
  ],
  ["upgradability::errors::SetProxyOwnerError", ["CannotUninitialize"]],
];

const REVERT_RE = /Revert\((\d+)\)/g;

// Fuel VM uses the top 48 bits as a tag for ABI error codes.
const FUEL_MASK = 0xffff_ffff_ffff_0000n;
const FUEL_TAG = 0xffff_ffff_ffff_0000n;

// ---------------------------------------------------------------------------
// Context inference
// ---------------------------------------------------------------------------

function inferEnumFromContext(context: string): string | undefined {
  if (context.includes("CreateOrder")) return "contract_schema::order_book::OrderCreationError";
  if (context.includes("CancelOrder")) return "contract_schema::order_book::OrderCancelError";
  if (context.includes("SettleBalance") || context.includes("settle_balance"))
    return "contract_schema::order_book::OrderCreationError";
  if (context.includes("withdraw") || context.includes("Withdraw"))
    return "contract_schema::trade_account::WithdrawError";
  if (context.includes("register_referer"))
    return "contract_schema::register::TradeAccountRegistryError";
  if (context.includes("session") || context.includes("Session"))
    return "contract_schema::trade_account::SessionError";
  if (context.includes("nonce") || context.includes("Nonce"))
    return "contract_schema::trade_account::NonceError";
  return undefined;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function lookupVariant(enumName: string, ordinal: number): string | undefined {
  for (const [name, variants] of ABI_ERROR_ENUMS) {
    if (name === enumName) {
      if (ordinal < 1 || ordinal > variants.length) return undefined;
      return variants[ordinal - 1];
    }
  }
  return undefined;
}

function extractRevertCodes(text: string): bigint[] {
  const codes: bigint[] = [];
  // Revert(DIGITS) — from structured receipts
  REVERT_RE.lastIndex = 0;
  for (let match = REVERT_RE.exec(text); match !== null; match = REVERT_RE.exec(text)) {
    codes.push(BigInt(match[1]));
  }
  // Revert { ... ra: DIGITS ... } — Rust Debug format embedded in reason strings.
  // Uses string search instead of regex to avoid ReDoS on [^}]* patterns.
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf("Revert {", searchFrom);
    if (idx === -1) break;
    const raIdx = text.indexOf("ra:", idx);
    const braceEnd = text.indexOf("}", idx);
    if (raIdx !== -1 && (braceEnd === -1 || raIdx < braceEnd)) {
      let start = raIdx + 3;
      while (start < text.length && text[start] === " ") start++;
      let end = start;
      while (end < text.length && text[end] >= "0" && text[end] <= "9") end++;
      if (end > start) {
        codes.push(BigInt(text.slice(start, end)));
      }
    }
    searchFrom = idx + 8;
  }
  return codes;
}

/** Extract Fuel VM panic reason from embedded receipt text (string search, no regex). */
function extractPanicReason(text: string): string | undefined {
  const marker = "PanicInstruction {";
  const idx = text.indexOf(marker);
  if (idx === -1) return undefined;
  const reasonIdx = text.indexOf("reason:", idx + marker.length);
  if (reasonIdx === -1) return undefined;
  let start = reasonIdx + 7;
  while (start < text.length && text[start] === " ") start++;
  let end = start;
  while (end < text.length && /\w/.test(text[end])) end++;
  const name = text.slice(start, end);
  return name || undefined;
}

function hexPad16(n: bigint): string {
  return `0x${n.toString(16).padStart(16, "0")}`;
}

function decodeRevertCode(raw: bigint, context: string): string | undefined {
  if ((raw & FUEL_MASK) !== FUEL_TAG) return undefined;
  const ordinal = Number(raw & 0xffffn);
  if (ordinal === 0) return `on-chain require() failed (raw=${hexPad16(raw)})`;

  // Try context-based inference first.
  const inferred = inferEnumFromContext(context);
  if (inferred !== undefined) {
    const variant = lookupVariant(inferred, ordinal);
    if (variant !== undefined) {
      return `${inferred}::${variant} (ordinal=${ordinal}, raw=${hexPad16(raw)})`;
    }
  }

  // Fallback: try all enums.
  const candidates: string[] = [];
  for (const [name, variants] of ABI_ERROR_ENUMS) {
    if (ordinal <= variants.length) {
      candidates.push(`${name}::${variants[ordinal - 1]}`);
    }
  }

  if (candidates.length === 0) {
    return `unknown ABI error ordinal=${ordinal} (raw=${hexPad16(raw)})`;
  }

  if (candidates.length === 1) {
    return `${candidates[0]} (ordinal=${ordinal}, raw=${hexPad16(raw)})`;
  }

  return `ambiguous ABI error ordinal=${ordinal} (raw=${hexPad16(raw)}); candidates=[${candidates.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return an augmented reason string with decoded revert info.
 *
 * @param message - The full error `message` field from the API response.
 * @param reason - The `reason` field (may be undefined or empty).
 * @param receipts - The `receipts` field (array or undefined). Serialised to
 *   text for pattern matching.
 * @returns The decoded error name when a revert code is found, or the
 *   original reason (or `""`) when no code can be decoded.
 */
export function augmentRevertReason(
  message: string,
  reason: string | undefined,
  receipts: unknown[] | undefined,
): string {
  const reasonStr = reason ?? "";
  const receiptsText = receipts != null ? JSON.stringify(receipts) : "";
  const context = `${message}\n${reasonStr}\n${receiptsText}`;

  for (const raw of extractRevertCodes(context)) {
    const decoded = decodeRevertCode(raw, context);
    if (decoded !== undefined) {
      // Return just the decoded name - the raw reason/receipts dump can be
      // several KB and makes log lines unreadable.
      return decoded;
    }
  }

  // Check for Fuel VM Panic receipts embedded in the reason string
  // (e.g. PanicInstruction { reason: NotEnoughBalance }).
  const panic = extractPanicReason(context);
  if (panic) {
    return panic;
  }

  // No decodable revert code found. Try to extract the "and error: ..."
  // summary the backend embeds after the LogResult noise.
  const errIdx = context.indexOf("and error:");
  if (errIdx !== -1) {
    const after = context.slice(errIdx + "and error:".length).trim();
    const receiptsIdx = after.indexOf(", receipts:");
    const summary = receiptsIdx !== -1 ? after.slice(0, receiptsIdx).trim() : after.slice(0, 200);
    if (summary) return summary;
  }

  // Cap the raw reason to avoid dumping multi-KB receipt blobs.
  if (reasonStr.length > 200) {
    return `${reasonStr.slice(0, 200)}... (truncated, full receipts on .receipts)`;
  }
  return reasonStr;
}
