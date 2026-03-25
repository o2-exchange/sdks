use serde_json::Value;

// ---------------------------------------------------------------------------
// ABI error enums — variant lists keyed by logId
//
// Source of truth: abi/mainnet/*.json  (loggedTypes + concreteTypes).
// Validate with:  python scripts/validate_abi_enums.py
// ---------------------------------------------------------------------------

// (log_id from LogData receipt rb register, fully-qualified enum name, [variant names])
// Variant index = 0-based discriminant found in LogData.data first 8 bytes.
const ABI_ERROR_ENUMS: &[(u64, &str, &[&str])] = &[
    (
        537125673719950211,
        "upgradability::errors::SetProxyOwnerError",
        &["CannotUninitialize"],
    ),
    (
        821289540733930261,
        "contract_schema::trade_account::CallerError",
        &["InvalidCaller"],
    ),
    (
        1043998670105365804,
        "contract_schema::order_book::OrderCancelError",
        &["NotOrderOwner", "TraderNotBlacklisted", "NoBlacklist"],
    ),
    (
        2735857006735158246,
        "contract_schema::trade_account::SessionError",
        &["SessionInThePast", "NoApprovedContractIdsProvided"],
    ),
    (
        4755763688038835574,
        "contract_schema::order_book::FeeError",
        &["NoFeesAvailable"],
    ),
    (
        4997665884103701952,
        "pausable::errors::PauseError",
        &["Paused", "NotPaused"],
    ),
    (
        5347491661573165298,
        "contract_schema::whitelist::WhitelistError",
        &["TraderAlreadyWhitelisted", "TraderNotWhitelisted"],
    ),
    (
        8930260739195532515,
        "contract_schema::order_book::OrderBookInitializationError",
        &[
            "InvalidAsset",
            "InvalidDecimals",
            "InvalidPriceWindow",
            "InvalidPricePrecision",
            "OwnerNotSet",
            "InvalidMinOrder",
        ],
    ),
    (
        9305944841695250538,
        "contract_schema::register::TradeAccountRegistryError",
        &[
            "OwnerAlreadyHasTradeAccount",
            "TradeAccountNotRegistered",
            "TradeAccountAlreadyHasReferer",
        ],
    ),
    (
        11035215306127844569,
        "contract_schema::trade_account::SignerError",
        &["InvalidSigner", "ProxyOwnerIsContract"],
    ),
    (
        12033795032676640771,
        "contract_schema::order_book::OrderCreationError",
        &[
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
    ),
    (
        12825652816513834595,
        "ownership::errors::InitializationError",
        &["CannotReinitialized"],
    ),
    (
        13517258236389385817,
        "contract_schema::blacklist::BlacklistError",
        &["TraderAlreadyBlacklisted", "TraderNotBlacklisted"],
    ),
    (
        14509209538366790003,
        "std::crypto::signature_error::SignatureError",
        &[
            "UnrecoverablePublicKey",
            "InvalidPublicKey",
            "InvalidSignature",
            "InvalidOperation",
        ],
    ),
    (
        14888260448086063780,
        "contract_schema::trade_account::WithdrawError",
        &["AmountIsZero", "NotEnoughBalance"],
    ),
    (17376141311665587813, "src5::AccessError", &["NotOwner"]),
    (
        17909535172322737929,
        "contract_schema::trade_account::NonceError",
        &["InvalidNonce"],
    ),
];

// Fuel VM signal constants (from sway-lib-std/src/error_signals.sw).
// These are the REVERT receipt ra values — they identify the *type* of failure,
// NOT the specific error variant.
const SIGNAL_CONSTANTS: &[(u64, &str)] = &[
    (0xFFFF_FFFF_FFFF_0000, "FAILED_REQUIRE"),
    (0xFFFF_FFFF_FFFF_0001, "FAILED_TRANSFER_TO_ADDRESS"),
    (0xFFFF_FFFF_FFFF_0003, "FAILED_ASSERT_EQ"),
    (0xFFFF_FFFF_FFFF_0004, "FAILED_ASSERT"),
    (0xFFFF_FFFF_FFFF_0005, "FAILED_ASSERT_NE"),
    (0xFFFF_FFFF_FFFF_0006, "REVERT_WITH_LOG"),
];

/// Look up a variant name in ABI_ERROR_ENUMS and return "EnumName::VariantName".
/// Returns the first match (most specific).
fn variant_to_qualified(variant: &str) -> Option<String> {
    for &(_, enum_name, variants) in ABI_ERROR_ENUMS {
        for &v in variants {
            if v == variant {
                return Some(format!("{enum_name}::{v}"));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/// Extract the last decoded error name from a `LogResult { results: [...] }` block.
///
/// The backend formats failed transaction logs as:
///     LogResult { results: [Ok("Event1"), Ok("Event2"), Ok("ErrorName")] }
///
/// The last `Ok("...")` entry that matches a known error variant is the error.
fn extract_log_result_error(text: &str) -> Option<String> {
    let mut result: Option<&str> = None;

    // Match both Ok("...") and Ok(\"...\") forms
    let mut offset = 0;
    while offset < text.len() {
        // Try Ok(\"...\") first (escaped quotes from JSON)
        if let Some(pos) = text[offset..].find("Ok(\\\"") {
            let start = offset + pos + 5; // skip Ok(\"
            if let Some(end_rel) = text[start..].find("\\\"") {
                let name = &text[start..start + end_rel];
                // Check if it's a known variant (no spaces — variant names are single words)
                if !name.is_empty() && !name.contains(' ') && variant_to_qualified(name).is_some() {
                    result = Some(name);
                }
                offset = start + end_rel + 2;
                continue;
            }
        }

        // Try Ok("...") (unescaped quotes)
        if let Some(pos) = text[offset..].find("Ok(\"") {
            let start = offset + pos + 4; // skip Ok("
            if let Some(end_rel) = text[start..].find("\")") {
                let name = &text[start..start + end_rel];
                if !name.is_empty() && !name.contains(' ') && variant_to_qualified(name).is_some() {
                    result = Some(name);
                }
                offset = start + end_rel + 2;
                continue;
            }
        }

        // Neither pattern found from this offset — done
        break;
    }

    result.and_then(variant_to_qualified)
}

/// Parse the LogData receipt before a Revert receipt for logId + discriminant.
///
/// In the embedded receipt text, the LogData immediately before the Revert has:
///     LogData { ..., rb: <logId>, ..., data: Some(Bytes(<hex>)) }
///
/// `rb` identifies the enum type (via ABI loggedTypes).
/// First 8 bytes of `data` (16 hex chars) is the 0-based variant discriminant.
fn extract_logdata_error(text: &str) -> Option<String> {
    // Find the last "Revert {" then find the LogData before it
    let revert_idx = text.rfind("Revert {")?;
    let logdata_idx = text[..revert_idx].rfind("LogData {")?;
    let logdata_block = &text[logdata_idx..revert_idx];

    // Extract rb: <digits>
    let rb_idx = logdata_block.find("rb:")?;
    let after_rb = &logdata_block[rb_idx + 3..];
    let after_rb = after_rb.trim_start();
    let digits: String = after_rb
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let log_id: u64 = digits.parse().ok()?;

    // Find matching enum
    let (_, enum_name, variants) = ABI_ERROR_ENUMS.iter().find(|(id, _, _)| *id == log_id)?;

    // Extract data: Some(Bytes(<hex>))
    let bytes_marker = "Bytes(";
    let data_idx = logdata_block.find(bytes_marker)?;
    let hex_start = data_idx + bytes_marker.len();
    let hex_end = logdata_block[hex_start..].find(')')? + hex_start;
    let hex_str = &logdata_block[hex_start..hex_end];

    // First 8 bytes = 16 hex chars = u64 big-endian discriminant
    if hex_str.len() < 16 {
        return None;
    }
    let discriminant = u64::from_str_radix(&hex_str[..16], 16).ok()? as usize;

    if discriminant < variants.len() {
        Some(format!("{enum_name}::{}", variants[discriminant]))
    } else {
        Some(format!("{enum_name}::unknown(discriminant={discriminant})"))
    }
}

/// Extract a Fuel VM panic reason from `PanicInstruction { reason: ... }`.
fn extract_panic_reason(text: &str) -> Option<String> {
    let marker = "PanicInstruction {";
    let start = text.find(marker)?;
    let after = &text[start + marker.len()..];
    let reason_pos = after.find("reason:")?;
    let name_start = &after[reason_pos + "reason:".len()..];
    let name: String = name_start
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Extract all revert codes from `Revert(DIGITS)` and `Revert { ra: DIGITS }`.
fn extract_revert_codes(text: &str) -> Vec<u64> {
    let mut codes = Vec::new();

    // Match Revert(DIGITS)
    let mut offset = 0;
    while let Some(start_rel) = text[offset..].find("Revert(") {
        let start = offset + start_rel + "Revert(".len();
        let digits: String = text[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty()
            && text[start + digits.len()..]
                .chars()
                .next()
                .is_some_and(|c| c == ')')
        {
            if let Ok(v) = digits.parse::<u64>() {
                codes.push(v);
            }
        }
        offset = start;
    }

    // Match Revert { ... ra: DIGITS ... }
    offset = 0;
    while let Some(start_rel) = text[offset..].find("Revert {") {
        let block_start = offset + start_rel;
        let brace_end = text[block_start..].find('}');
        if let Some(ra_rel) = text[block_start..].find("ra:") {
            let brace_end_abs = brace_end.map(|e| block_start + e);
            let ra_abs = block_start + ra_rel;
            if brace_end_abs.is_none() || ra_abs < brace_end_abs.unwrap() {
                let after_ra = &text[ra_abs + 3..];
                let after_ra = after_ra.trim_start();
                let digits: String = after_ra
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(v) = digits.parse::<u64>() {
                    codes.push(v);
                }
            }
        }
        offset = block_start + "Revert {".len();
    }

    codes
}

/// Identify Fuel VM signal constants from revert codes in text.
fn recognize_signal(text: &str) -> Option<&'static str> {
    for code in extract_revert_codes(text) {
        for &(signal_val, signal_name) in SIGNAL_CONSTANTS {
            if code == signal_val {
                return Some(signal_name);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return a human-readable error name decoded from the backend's error response.
///
/// Tries multiple strategies in priority order:
///
/// 1. Extract the error variant from the backend's decoded `LogResult`
/// 2. Parse the `LogData` receipt (logId + discriminant) from embedded receipts
/// 3. Recognize Fuel VM signal constants
/// 4. Extract `PanicInstruction` reason
/// 5. Extract `and error:` summary
/// 6. Truncate raw reason as last resort
pub(crate) fn augment_revert_reason(
    message: &str,
    reason: &str,
    receipts: Option<&Value>,
) -> String {
    let receipts_text = match receipts {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| v.to_string()),
        None => String::new(),
    };

    let context = format!("{message}\n{reason}\n{receipts_text}");

    // 1. Extract from backend-decoded LogResult (most reliable)
    if let Some(decoded) = extract_log_result_error(&context) {
        return decoded;
    }

    // 2. Parse LogData receipt before Revert (fallback)
    if let Some(decoded) = extract_logdata_error(&context) {
        return decoded;
    }

    // 3. Recognize signal constant (tells what KIND of failure, not which variant)
    let signal = recognize_signal(&context);

    // 4. Check for PanicInstruction
    if let Some(panic) = extract_panic_reason(&context) {
        return panic;
    }

    // 5. Extract "and error:" summary
    if let Some(err_idx) = context.find("and error:") {
        let after = context[err_idx + "and error:".len()..].trim_start();
        let summary = if let Some(receipts_idx) = after.find(", receipts:") {
            after[..receipts_idx].trim()
        } else {
            &after[..after.len().min(200)]
        };
        if !summary.is_empty() {
            return summary.to_string();
        }
    }

    // 6. If we recognized a signal, return it as context
    if let Some(signal_name) = signal {
        return format!("{signal_name} (specific error unknown — check .receipts)");
    }

    // 7. Truncate raw reason
    if reason.len() > 200 {
        return format!(
            "{}... (truncated, full receipts on .receipts)",
            &reason[..200]
        );
    }
    reason.to_string()
}

#[cfg(test)]
mod tests {
    use super::augment_revert_reason;

    // Realistic reason string from a real backend error response.
    const REALISTIC_REASON: &str = concat!(
        "Failed to process SessionCallPayload { actions: [MarketActions { actions: ",
        "[SettleBalance, CreateOrder { side: Buy }] }] } with error: ",
        "Transaction abc123 failed with logs: LogResult { results: ",
        "[Ok(\"IncrementNonceEvent { nonce: 2752 }\"), ",
        "Ok(\"SessionContractCallEvent { nonce: 2751 }\"), ",
        "Ok(\"SessionContractCallEvent { nonce: 2751 }\"), ",
        "Ok(\"OrderCreatedEvent { quantity: 1000000, price: 2129980000000 }\"), ",
        "Ok(\"OrderMatchedEvent { quantity: 1000000, price: 2129320000000 }\"), ",
        "Ok(\"FeesCollectedEvent { base_fees: 100, quote_fees: 0 }\"), ",
        "Ok(\"OrderPartiallyFilled\")] } ",
        "and error: transaction reverted: Revert(18446744073709486086), ",
        "receipts: [Call { id: 0000, to: f155, amount: 0 }, ",
        "LogData { id: f155, ra: 0, rb: 2261086600904378517, ptr: 67108286, len: 8, ",
        "digest: abc, data: Some(Bytes(0000000000000000)) }, ",
        "LogData { id: 2a78, ra: 0, rb: 12033795032676640771, ptr: 67100980, len: 8, ",
        "digest: 4c0e, data: Some(Bytes(0000000000000008)) }, ",
        "Revert { id: 2a78, ra: 18446744073709486086 }, ",
        "ScriptResult { result: Revert }]"
    );

    // -----------------------------------------------------------------------
    // Strategy 1: LogResult extraction
    // -----------------------------------------------------------------------

    #[test]
    fn test_extracts_error_from_log_result() {
        let decoded =
            augment_revert_reason("Failed to process transaction", REALISTIC_REASON, None);
        assert_eq!(
            decoded,
            "contract_schema::order_book::OrderCreationError::OrderPartiallyFilled"
        );
    }

    #[test]
    fn test_log_result_with_escaped_quotes() {
        let reason = concat!(
            "LogResult { results: [Ok(\\\"IncrementNonceEvent\\\"), ",
            "Ok(\\\"TraderNotWhiteListed\\\")] }"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(
            decoded,
            "contract_schema::order_book::OrderCreationError::TraderNotWhiteListed"
        );
    }

    #[test]
    fn test_log_result_ignores_non_error_entries() {
        let reason = concat!(
            "LogResult { results: [Ok(\"IncrementNonceEvent\"), ",
            "Ok(\"OrderCreatedEvent\"), Ok(\"NotEnoughBalance\")] }"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(
            decoded,
            "contract_schema::trade_account::WithdrawError::NotEnoughBalance"
        );
    }

    // -----------------------------------------------------------------------
    // Strategy 2: LogData receipt parsing
    // -----------------------------------------------------------------------

    #[test]
    fn test_extracts_error_from_logdata_receipt() {
        let reason = concat!(
            "receipts: [LogData { id: abc, ra: 0, rb: 12033795032676640771, ",
            "ptr: 100, len: 8, digest: def, data: Some(Bytes(0000000000000008)) }, ",
            "Revert { id: abc, ra: 18446744073709486086 }]"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(
            decoded,
            "contract_schema::order_book::OrderCreationError::OrderPartiallyFilled"
        );
    }

    #[test]
    fn test_logdata_discriminant_zero() {
        let reason = concat!(
            "LogData { id: x, ra: 0, rb: 12033795032676640771, ",
            "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, ",
            "Revert { id: x, ra: 18446744073709486086 }"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(
            decoded,
            "contract_schema::order_book::OrderCreationError::InvalidOrderArgs"
        );
    }

    #[test]
    fn test_logdata_withdraw_error() {
        let reason = concat!(
            "LogData { id: x, ra: 0, rb: 14888260448086063780, ",
            "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000001)) }, ",
            "Revert { id: x, ra: 18446744073709486000 }"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(
            decoded,
            "contract_schema::trade_account::WithdrawError::NotEnoughBalance"
        );
    }

    #[test]
    fn test_logdata_unknown_log_id_falls_through() {
        let reason = concat!(
            "LogData { id: x, ra: 0, rb: 9999999999999999999, ",
            "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, ",
            "Revert { id: x, ra: 18446744073709486086 }"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert!(
            decoded.contains("REVERT_WITH_LOG"),
            "expected REVERT_WITH_LOG, got: {decoded}"
        );
    }

    // -----------------------------------------------------------------------
    // Strategy 3: Signal constant recognition
    // -----------------------------------------------------------------------

    #[test]
    fn test_recognizes_failed_require_signal() {
        let reason = "Revert(18446744073709486080)"; // 0xffffffffffff0000
        let decoded = augment_revert_reason("msg", reason, None);
        assert!(
            decoded.contains("FAILED_REQUIRE"),
            "expected FAILED_REQUIRE, got: {decoded}"
        );
    }

    #[test]
    fn test_recognizes_revert_with_log_signal() {
        let reason = "Revert(18446744073709486086)"; // 0xffffffffffff0006
        let decoded = augment_revert_reason("msg", reason, None);
        assert!(
            decoded.contains("REVERT_WITH_LOG"),
            "expected REVERT_WITH_LOG, got: {decoded}"
        );
    }

    #[test]
    fn test_non_signal_revert_code_falls_through() {
        let decoded = augment_revert_reason("msg", "Revert(42)", None);
        assert_eq!(decoded, "Revert(42)");
    }

    // -----------------------------------------------------------------------
    // Strategy 4: PanicInstruction
    // -----------------------------------------------------------------------

    #[test]
    fn test_extracts_panic_reason() {
        let reason = concat!(
            "receipts: [Panic { id: abc, reason: PanicInstruction ",
            "{ reason: NotEnoughBalance, instruction: CALL {} }, pc: 123 }]"
        );
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(decoded, "NotEnoughBalance");
    }

    // -----------------------------------------------------------------------
    // Strategy 5: "and error:" fallback
    // -----------------------------------------------------------------------

    #[test]
    fn test_extracts_and_error_summary() {
        let reason = "lots of noise and error: transaction reverted: SomeError, receipts: [...]";
        let decoded = augment_revert_reason("msg", reason, None);
        assert_eq!(decoded, "transaction reverted: SomeError");
    }

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn test_leaves_reason_unchanged_when_no_patterns() {
        let decoded = augment_revert_reason("plain error", "some reason", None);
        assert_eq!(decoded, "some reason");
    }

    #[test]
    fn test_truncates_long_reason() {
        let reason = "x".repeat(500);
        let decoded = augment_revert_reason("error", &reason, None);
        assert!(decoded.len() < 300);
        assert!(decoded.contains("truncated"));
    }

    #[test]
    fn test_receipts_json_searched() {
        let receipts =
            serde_json::from_str::<serde_json::Value>(r#"[{"note": "Ok(\"InvalidNonce\")"}]"#)
                .unwrap();
        let decoded = augment_revert_reason("msg", "", Some(&receipts));
        assert_eq!(
            decoded,
            "contract_schema::trade_account::NonceError::InvalidNonce"
        );
    }

    #[test]
    fn test_priority_log_result_over_logdata() {
        let decoded =
            augment_revert_reason("Failed to process transaction", REALISTIC_REASON, None);
        assert!(
            decoded.contains("OrderPartiallyFilled"),
            "expected OrderPartiallyFilled, got: {decoded}"
        );
    }
}
