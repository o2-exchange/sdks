/**
 * Decode Fuel VM on-chain revert errors into human-readable names.
 *
 * The backend wraps on-chain failures as `code: 1000` (InternalError) with the
 * Fuel VM receipt data embedded in the `reason` string.  This module extracts
 * the actual error variant from that text using two strategies:
 *
 * 1. **LogResult extraction** — The backend's fuels-rs SDK decodes the LOG receipt
 *    and includes the result in a `LogResult { results: [..., Ok("VariantName")] }`
 *    block.  We extract the last `Ok("...")` entry that matches a known variant.
 *
 * 2. **LogData receipt parsing** — Each `LogData` receipt carries `rb` (the ABI
 *    log-ID that identifies the enum type) and `data` (the ABI-encoded value whose
 *    first 8 bytes are the 0-based variant discriminant).  We match `rb` against
 *    the ABI's `loggedTypes` and index into the variant list.
 *
 * Sway's `require()` and `revert_with_log()` both emit a LOG receipt with the
 * typed error value, then revert with a **fixed signal constant** (not the variant
 * ordinal).  The signal constants are:
 *
 * - `0xffffffffffff0000` — `FAILED_REQUIRE`
 * - `0xffffffffffff0001` — `FAILED_TRANSFER_TO_ADDRESS`
 * - `0xffffffffffff0003` — `FAILED_ASSERT_EQ`
 * - `0xffffffffffff0004` — `FAILED_ASSERT`
 * - `0xffffffffffff0005` — `FAILED_ASSERT_NE`
 * - `0xffffffffffff0006` — `REVERT_WITH_LOG`
 *
 * @module
 */

// ---------------------------------------------------------------------------
// ABI error enums — variant lists keyed by logId
//
// Source of truth: abi/mainnet/*.json  (loggedTypes + concreteTypes).
// Validate with:  python scripts/validate_abi_enums.py
// ---------------------------------------------------------------------------

// logId (u64 from LogData receipt rb register) → [fully-qualified enum name, [[variant, description], ...]]
// Variant index = 0-based discriminant found in LogData.data first 8 bytes.
const ABI_ERROR_ENUMS: Map<bigint, [string, [string, string][]]> = new Map([
  [
    537125673719950211n,
    [
      "upgradability::errors::SetProxyOwnerError",
      [["CannotUninitialize", "Cannot uninitialize proxy owner"]],
    ],
  ],
  [
    821289540733930261n,
    [
      "contract_schema::trade_account::CallerError",
      [["InvalidCaller", "Caller is not authorized for this operation"]],
    ],
  ],
  [
    1043998670105365804n,
    [
      "contract_schema::order_book::OrderCancelError",
      [
        ["NotOrderOwner", "You can only cancel your own orders"],
        ["TraderNotBlacklisted", "Trader is not blacklisted"],
        ["NoBlacklist", "No blacklist configured for this market"],
      ],
    ],
  ],
  [
    2735857006735158246n,
    [
      "contract_schema::trade_account::SessionError",
      [
        ["SessionInThePast", "Session expiry is in the past. Create a new session."],
        ["NoApprovedContractIdsProvided", "Session must include at least one approved contract"],
      ],
    ],
  ],
  [
    4755763688038835574n,
    ["contract_schema::order_book::FeeError", [["NoFeesAvailable", "No fees to collect"]]],
  ],
  [
    4997665884103701952n,
    [
      "pausable::errors::PauseError",
      [
        ["Paused", "Market is paused"],
        ["NotPaused", "Market is not paused"],
      ],
    ],
  ],
  [
    5347491661573165298n,
    [
      "contract_schema::whitelist::WhitelistError",
      [
        ["TraderAlreadyWhitelisted", "Account is already whitelisted"],
        ["TraderNotWhitelisted", "Account is not whitelisted"],
      ],
    ],
  ],
  [
    8930260739195532515n,
    [
      "contract_schema::order_book::OrderBookInitializationError",
      [
        ["InvalidAsset", "Invalid asset configuration (admin)"],
        ["InvalidDecimals", "Invalid decimals configuration (admin)"],
        ["InvalidPriceWindow", "Invalid price window (admin)"],
        ["InvalidPricePrecision", "Invalid price precision (admin)"],
        ["OwnerNotSet", "Owner not set (admin)"],
        ["InvalidMinOrder", "Invalid minimum order (admin)"],
      ],
    ],
  ],
  [
    9305944841695250538n,
    [
      "contract_schema::register::TradeAccountRegistryError",
      [
        ["OwnerAlreadyHasTradeAccount", "This wallet already has a trade account"],
        ["TradeAccountNotRegistered", "Trade account not found. Call setup_account() first."],
        ["TradeAccountAlreadyHasReferer", "Referral code already set for this account"],
      ],
    ],
  ],
  [
    11035215306127844569n,
    [
      "contract_schema::trade_account::SignerError",
      [
        ["InvalidSigner", "Signature doesn't match the session signer"],
        ["ProxyOwnerIsContract", "Contract IDs cannot be used as proxy owners"],
      ],
    ],
  ],
  [
    12033795032676640771n,
    [
      "contract_schema::order_book::OrderCreationError",
      [
        ["InvalidOrderArgs", "Order arguments are invalid"],
        [
          "InvalidInputAmount",
          "Input amount doesn't match price \u00d7 quantity. Check your balance.",
        ],
        ["InvalidAsset", "Wrong asset for this market"],
        ["PriceExceedsRange", "Price is outside the allowed range for this market"],
        [
          "PricePrecision",
          "Price doesn't align with the market's tick size. Use Market.scale_price().",
        ],
        ["InvalidHeapPrices", "Internal order book state error. Retry the order."],
        [
          "FractionalPrice",
          "price \u00d7 quantity must be divisible by 10^base_decimals. Use Market.adjust_quantity().",
        ],
        [
          "OrderNotFilled",
          "FillOrKill order could not be fully filled. Try a smaller quantity or use Spot.",
        ],
        [
          "OrderPartiallyFilled",
          "PostOnly order would cross the spread. Use a lower buy price or higher sell price.",
        ],
        ["TraderNotWhiteListed", "Account not whitelisted. Call whitelist_account() first."],
        ["TraderBlackListed", "Account is blacklisted and cannot trade on this market"],
        ["InvalidMarketOrder", "Market orders are not supported on this order book"],
        ["InvalidMarketOrderArgs", "Invalid arguments for bounded market order"],
      ],
    ],
  ],
  [
    12825652816513834595n,
    [
      "ownership::errors::InitializationError",
      [["CannotReinitialized", "Contract already initialized"]],
    ],
  ],
  [
    13517258236389385817n,
    [
      "contract_schema::blacklist::BlacklistError",
      [
        ["TraderAlreadyBlacklisted", "Account is already blacklisted"],
        ["TraderNotBlacklisted", "Account is not blacklisted"],
      ],
    ],
  ],
  [
    14509209538366790003n,
    [
      "std::crypto::signature_error::SignatureError",
      [
        ["UnrecoverablePublicKey", "Could not recover public key from signature"],
        ["InvalidPublicKey", "Public key is invalid"],
        ["InvalidSignature", "Signature verification failed"],
        ["InvalidOperation", "Invalid cryptographic operation"],
      ],
    ],
  ],
  [
    14888260448086063780n,
    [
      "contract_schema::trade_account::WithdrawError",
      [
        ["AmountIsZero", "Withdrawal amount must be greater than zero"],
        ["NotEnoughBalance", "Insufficient balance for withdrawal"],
      ],
    ],
  ],
  [
    17376141311665587813n,
    ["src5::AccessError", [["NotOwner", "Caller is not the contract owner"]]],
  ],
  [
    17909535172322737929n,
    [
      "contract_schema::trade_account::NonceError",
      [["InvalidNonce", "Nonce is stale or out of sequence. Refresh the nonce and retry."]],
    ],
  ],
]);

// Reverse lookup: variant name → [fully qualified "EnumName::VariantName", description]
const VARIANT_TO_QUALIFIED: Map<string, [string, string]> = new Map();
for (const [enumName, variants] of ABI_ERROR_ENUMS.values()) {
  for (const [v, desc] of variants) {
    // If a variant name appears in multiple enums, keep the first (most specific).
    if (!VARIANT_TO_QUALIFIED.has(v)) {
      VARIANT_TO_QUALIFIED.set(v, [`${enumName}::${v}`, desc]);
    }
  }
}

// Fuel VM signal constants (from sway-lib-std/src/error_signals.sw).
// These are the REVERT receipt ra values — they identify the *type* of failure,
// NOT the specific error variant.
const SIGNAL_CONSTANTS: Map<bigint, string> = new Map([
  [0xffff_ffff_ffff_0000n, "FAILED_REQUIRE"],
  [0xffff_ffff_ffff_0001n, "FAILED_TRANSFER_TO_ADDRESS"],
  [0xffff_ffff_ffff_0003n, "FAILED_ASSERT_EQ"],
  [0xffff_ffff_ffff_0004n, "FAILED_ASSERT"],
  [0xffff_ffff_ffff_0005n, "FAILED_ASSERT_NE"],
  [0xffff_ffff_ffff_0006n, "REVERT_WITH_LOG"],
]);

const REVERT_RE = /Revert\((\d+)\)/g;
// Matches both Ok(\"...\") (JSON-escaped) and Ok("...") (raw)
const OK_RE = /Ok\(\\"([^"\\]+)\\"\)|Ok\("([^"]+)"\)/g;

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

/**
 * Format a decoded error into the standard output string.
 *
 * Output: `EnumShortName::Variant \u2014 description`
 *
 * The short name is the last segment of the fully-qualified enum name
 * (e.g. `contract_schema::order_book::OrderCreationError` -> `OrderCreationError`).
 */
function formatError(enumName: string, variant: string, description: string): string {
  const shortName = enumName.split("::").pop() ?? enumName;
  return `${shortName}::${variant} \u2014 ${description}`;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the last decoded error name from a `LogResult { results: [...] }` block.
 *
 * The backend formats failed transaction logs as:
 *     LogResult { results: [Ok("Event1"), Ok("Event2"), Ok("ErrorName")] }
 *
 * The last `Ok("...")` entry that matches a known error variant is the error.
 */
function extractLogResultError(text: string): string | undefined {
  let result: string | undefined;
  OK_RE.lastIndex = 0;
  for (let m = OK_RE.exec(text); m !== null; m = OK_RE.exec(text)) {
    const name = m[1] ?? m[2];
    if (name && VARIANT_TO_QUALIFIED.has(name)) {
      result = name;
    }
  }
  if (result !== undefined) {
    const entry = VARIANT_TO_QUALIFIED.get(result);
    if (entry !== undefined) {
      const [qualified, desc] = entry;
      // Extract enum name (everything before the last ::variant)
      const lastColons = qualified.lastIndexOf("::");
      const enumName = qualified.slice(0, lastColons);
      return formatError(enumName, result, desc);
    }
  }
  return undefined;
}

/**
 * Parse the LogData receipt before a Revert receipt for logId + discriminant.
 *
 * In the embedded receipt text, the LogData immediately before the Revert has:
 *     LogData { ..., rb: <logId>, ..., data: Some(Bytes(<hex>)) }
 *
 * `rb` identifies the enum type (via ABI loggedTypes).
 * First 8 bytes of `data` (16 hex chars) is the 0-based variant discriminant.
 */
function extractLogdataError(text: string): string | undefined {
  // Find the last "Revert {", then find the LogData before it.
  const revertIdx = text.lastIndexOf("Revert {");
  if (revertIdx === -1) return undefined;

  const logdataIdx = text.lastIndexOf("LogData {", revertIdx);
  if (logdataIdx === -1) return undefined;

  const logdataBlock = text.slice(logdataIdx, revertIdx);

  // Extract rb: <digits>
  const rbIdx = logdataBlock.indexOf("rb:");
  if (rbIdx === -1) return undefined;
  let start = rbIdx + 3;
  while (start < logdataBlock.length && logdataBlock[start] === " ") start++;
  let end = start;
  while (end < logdataBlock.length && logdataBlock[end] >= "0" && logdataBlock[end] <= "9") end++;
  if (end === start) return undefined;
  const logId = BigInt(logdataBlock.slice(start, end));

  const entry = ABI_ERROR_ENUMS.get(logId);
  if (entry === undefined) return undefined;
  const [enumName, variants] = entry;

  // Extract data: Some(Bytes(<hex>))
  const dataMarker = "Bytes(";
  const dataIdx = logdataBlock.indexOf(dataMarker);
  if (dataIdx === -1) return undefined;
  const hexStart = dataIdx + dataMarker.length;
  const hexEnd = logdataBlock.indexOf(")", hexStart);
  if (hexEnd === -1) return undefined;
  const hexStr = logdataBlock.slice(hexStart, hexEnd);

  // First 8 bytes = 16 hex chars = u64 big-endian discriminant
  if (hexStr.length < 16) return undefined;
  const discriminant = Number.parseInt(hexStr.slice(0, 16), 16);

  if (discriminant < variants.length) {
    const [variantName, desc] = variants[discriminant];
    return formatError(enumName, variantName, desc);
  }
  return `${enumName}::unknown(discriminant=${discriminant})`;
}

/** Extract a Fuel VM panic reason from `PanicInstruction { reason: ... }`. */
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

/**
 * Extract all revert codes from `Revert(DIGITS)` and `Revert { ra: DIGITS }` patterns.
 */
function extractRevertCodes(text: string): bigint[] {
  const codes: bigint[] = [];
  // Revert(DIGITS) — from structured receipts
  REVERT_RE.lastIndex = 0;
  for (let match = REVERT_RE.exec(text); match !== null; match = REVERT_RE.exec(text)) {
    codes.push(BigInt(match[1]));
  }
  // Revert { ... ra: DIGITS ... } — Rust Debug format embedded in reason strings.
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

/** Identify Fuel VM signal constants from revert codes in text. */
function recognizeSignal(text: string): string | undefined {
  for (const code of extractRevertCodes(text)) {
    const name = SIGNAL_CONSTANTS.get(code);
    if (name !== undefined) return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a human-readable error name decoded from the backend's error response.
 *
 * Tries multiple strategies in priority order:
 *
 * 1. Extract the error variant from the backend's decoded `LogResult`
 * 2. Parse the `LogData` receipt (logId + discriminant) from embedded receipts
 * 3. Recognize Fuel VM signal constants
 * 4. Extract `PanicInstruction` reason
 * 5. Extract `and error:` summary
 * 6. Truncate raw reason as last resort
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

  let receiptsText = "";
  if (receipts != null) {
    try {
      receiptsText = JSON.stringify(receipts);
    } catch {
      receiptsText = String(receipts);
    }
  }

  const context = `${message}\n${reasonStr}\n${receiptsText}`;

  // 1. Extract from backend-decoded LogResult (most reliable)
  const logResult = extractLogResultError(context);
  if (logResult !== undefined) return logResult;

  // 2. Parse LogData receipt before Revert (fallback)
  const logdata = extractLogdataError(context);
  if (logdata !== undefined) return logdata;

  // 3. Recognize signal constant (tells what KIND of failure, not which variant)
  const signal = recognizeSignal(context);

  // 4. Check for PanicInstruction
  const panic = extractPanicReason(context);
  if (panic) return panic;

  // 5. Extract "and error:" summary
  const errIdx = context.indexOf("and error:");
  if (errIdx !== -1) {
    const after = context.slice(errIdx + "and error:".length).trim();
    const receiptsIdx = after.indexOf(", receipts:");
    const summary = receiptsIdx !== -1 ? after.slice(0, receiptsIdx).trim() : after.slice(0, 200);
    if (summary) return summary;
  }

  // 6. If we recognized a signal, return it as context
  if (signal !== undefined) {
    return `${signal} (specific error unknown \u2014 check .receipts)`;
  }

  // 7. Truncate raw reason
  if (reasonStr.length > 200) {
    return `${reasonStr.slice(0, 200)}... (truncated, full receipts on .receipts)`;
  }
  return reasonStr;
}
