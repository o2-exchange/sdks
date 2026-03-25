use serde_json::Value;

// ABI error enum mapping (0-based ordinals).
// Source of truth: abi/mainnet/*.json (metadataTypes → enum components).
// See CLAUDE.md "Maintaining On-Chain Revert Decoding" for update procedure.
const ABI_ERROR_ENUMS: &[(&str, &[&str])] = &[
    (
        "contract_schema::blacklist::BlacklistError",
        &["TraderAlreadyBlacklisted", "TraderNotBlacklisted"],
    ),
    (
        "contract_schema::order_book::FeeError",
        &["NoFeesAvailable"],
    ),
    (
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
        "contract_schema::order_book::OrderCancelError",
        &["NotOrderOwner", "TraderNotBlacklisted", "NoBlacklist"],
    ),
    (
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
        "contract_schema::register::OrderBookRegistryError",
        &["MarketAlreadyHasOrderBook", "InvalidPair"],
    ),
    (
        "contract_schema::register::TradeAccountRegistryError",
        &[
            "OwnerAlreadyHasTradeAccount",
            "TradeAccountNotRegistered",
            "TradeAccountAlreadyHasReferer",
        ],
    ),
    (
        "contract_schema::trade_account::CallerError",
        &["InvalidCaller"],
    ),
    (
        "contract_schema::trade_account::NonceError",
        &["InvalidNonce"],
    ),
    (
        "contract_schema::trade_account::SessionError",
        &["SessionInThePast", "NoApprovedContractIdsProvided"],
    ),
    (
        "contract_schema::trade_account::SignerError",
        &["InvalidSigner", "ProxyOwnerIsContract"],
    ),
    (
        "contract_schema::trade_account::WithdrawError",
        &["AmountIsZero", "NotEnoughBalance"],
    ),
    (
        "contract_schema::whitelist::WhitelistError",
        &["TraderAlreadyWhitelisted", "TraderNotWhitelisted"],
    ),
    (
        "ownership::errors::InitializationError",
        &["CannotReinitialized"],
    ),
    ("pausable::errors::PauseError", &["Paused", "NotPaused"]),
    ("src5::AccessError", &["NotOwner"]),
    (
        "std::crypto::signature_error::SignatureError",
        &[
            "UnrecoverablePublicKey",
            "InvalidPublicKey",
            "InvalidSignature",
            "InvalidOperation",
        ],
    ),
    (
        "upgradability::errors::SetProxyOwnerError",
        &["CannotUninitialize"],
    ),
];

fn infer_enum_from_context(context: &str) -> Option<&'static str> {
    if context.contains("CreateOrder") {
        return Some("contract_schema::order_book::OrderCreationError");
    }
    if context.contains("CancelOrder") {
        return Some("contract_schema::order_book::OrderCancelError");
    }
    if context.contains("SettleBalance") || context.contains("settle_balance") {
        return Some("contract_schema::order_book::OrderCreationError");
    }
    if context.contains("withdraw") || context.contains("Withdraw") {
        return Some("contract_schema::trade_account::WithdrawError");
    }
    if context.contains("register_referer") {
        return Some("contract_schema::register::TradeAccountRegistryError");
    }
    if context.contains("session") || context.contains("Session") {
        return Some("contract_schema::trade_account::SessionError");
    }
    if context.contains("nonce") || context.contains("Nonce") {
        return Some("contract_schema::trade_account::NonceError");
    }
    None
}

fn lookup_variant(enum_name: &str, ordinal: usize) -> Option<&'static str> {
    let (_, variants) = ABI_ERROR_ENUMS
        .iter()
        .find(|(name, _)| *name == enum_name)?;
    variants.get(ordinal).copied()
}

fn extract_revert_codes(text: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    // Match Revert(DIGITS) — structured receipts
    while let Some(start_rel) = text[offset..].find("Revert(") {
        let start = offset + start_rel + "Revert(".len();
        let digits = text[start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>();
        if !digits.is_empty()
            && text[start + digits.len()..]
                .chars()
                .next()
                .is_some_and(|c| c == ')')
        {
            if let Ok(v) = digits.parse::<u64>() {
                out.push(v);
            }
        }
        offset = start;
    }
    // Match Revert { ... ra: DIGITS ... } — Rust Debug format embedded in reason strings
    offset = 0;
    while let Some(start_rel) = text[offset..].find("Revert {") {
        let block_start = offset + start_rel;
        if let Some(ra_rel) = text[block_start..].find("ra:") {
            let ra_start = block_start + ra_rel + "ra:".len();
            let digits: String = text[ra_start..]
                .chars()
                .skip_while(|c| c.is_whitespace())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(v) = digits.parse::<u64>() {
                out.push(v);
            }
            offset = ra_start;
        } else {
            offset = block_start + "Revert {".len();
        }
    }
    out
}

/// Extract a Fuel VM panic reason from embedded receipt text.
///
/// Matches `PanicInstruction { reason: NotEnoughBalance, ... }` from
/// Rust Debug formatted receipts embedded in the reason string.
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

fn decode_revert_code(raw: u64, context: &str) -> Option<String> {
    // `revert_with_log` / `require` error signal convention:
    // 0xffffffffffff0000 | ordinal (0-based)
    if (raw & 0xffff_ffff_ffff_0000) != 0xffff_ffff_ffff_0000 {
        return None;
    }
    let ordinal = (raw & 0xffff) as usize;
    // ordinal 0 is valid — it's the first variant of the enum.

    if let Some(enum_name) = infer_enum_from_context(context) {
        if let Some(variant) = lookup_variant(enum_name, ordinal) {
            return Some(format!(
                "{enum_name}::{variant} (ordinal={ordinal}, raw=0x{raw:016x})"
            ));
        }
    }

    // Fallback: try all enums (0-based ordinals).
    let candidates: Vec<String> = ABI_ERROR_ENUMS
        .iter()
        .filter_map(|(name, variants)| variants.get(ordinal).map(|v| format!("{name}::{v}")))
        .collect();

    if candidates.is_empty() {
        return Some(format!(
            "unknown ABI error ordinal={ordinal} (raw=0x{raw:016x})"
        ));
    }

    // Deprioritize admin-only enums that SDK users won't encounter.
    let admin_enums = [
        "InitializationError",
        "SetProxyOwnerError",
        "AccessError",
        "PauseError",
    ];
    let filtered: Vec<&String> = if candidates.len() > 1 {
        let non_admin: Vec<&String> = candidates
            .iter()
            .filter(|c| !admin_enums.iter().any(|a| c.contains(a)))
            .collect();
        if non_admin.is_empty() {
            candidates.iter().collect()
        } else {
            non_admin
        }
    } else {
        candidates.iter().collect()
    };

    if filtered.len() == 1 {
        return Some(format!(
            "{} (ordinal={}, raw=0x{:016x})",
            filtered[0], ordinal, raw
        ));
    }

    let joined: Vec<&str> = filtered.iter().map(|s| s.as_str()).collect();
    Some(format!(
        "ambiguous ABI error ordinal={} (raw=0x{:016x}); candidates=[{}]",
        ordinal,
        raw,
        joined.join(", ")
    ))
}

pub(crate) fn augment_revert_reason(
    message: &str,
    reason: &str,
    receipts: Option<&Value>,
) -> String {
    let context = format!(
        "{message}\n{reason}\n{}",
        receipts.map(|v| v.to_string()).unwrap_or_default()
    );

    let mut decoded: Option<String> = None;
    for raw in extract_revert_codes(&context) {
        if let Some(mapped) = decode_revert_code(raw, &context) {
            decoded = Some(mapped);
            break;
        }
    }

    if let Some(mapped) = decoded {
        // Return just the decoded name — the raw reason/receipts dump can be
        // several KB and makes log lines unreadable. Full receipts are still
        // accessible via OnChainRevert.receipts for callers that need them.
        return mapped;
    }

    // Check for Fuel VM Panic receipts embedded in the reason string
    // (e.g. PanicInstruction { reason: NotEnoughBalance }).
    if let Some(panic) = extract_panic_reason(&context) {
        return panic;
    }

    // No decodable revert code found. Try to extract the "and error: ..."
    // summary the backend embeds after the LogResult noise.
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

    // Cap the raw reason to avoid dumping multi-KB receipt blobs.
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

    #[test]
    fn decodes_order_creation_error_from_create_order_context() {
        let message =
            "Failed payload ... CreateOrder { side: Buy } ... Revert(18446744073709486086)";
        let reason = "transaction reverted";
        let decoded = augment_revert_reason(message, reason, None);
        assert!(decoded.contains("OrderCreationError::FractionalPrice"));
    }

    #[test]
    fn decodes_even_when_reason_is_empty() {
        let message = "CreateOrder failed Revert(18446744073709486088)";
        let decoded = augment_revert_reason(message, "", None);
        assert!(decoded.contains("OrderCreationError::OrderPartiallyFilled"));
    }

    #[test]
    fn leaves_reason_unchanged_when_no_revert_code() {
        let message = "plain error";
        let reason = "some reason";
        let decoded = augment_revert_reason(message, reason, None);
        assert_eq!(decoded, reason);
    }

    #[test]
    fn truncates_long_reason_without_revert_code() {
        let message = "error";
        let reason = "x".repeat(500);
        let decoded = augment_revert_reason(message, &reason, None);
        assert!(decoded.len() < 300);
        assert!(decoded.contains("truncated"));
    }

    #[test]
    fn returns_clean_decoded_not_appended() {
        let message =
            "Failed payload ... CreateOrder { side: Buy } ... Revert(18446744073709486086)";
        let reason = "transaction reverted";
        let decoded = augment_revert_reason(message, reason, None);
        // Should NOT contain the original reason prefix
        assert!(!decoded.starts_with("transaction reverted"));
        assert!(decoded.contains("OrderCreationError::FractionalPrice"));
    }

    #[test]
    fn extracts_panic_reason_from_embedded_receipts() {
        let message = "Failed to process transaction";
        let reason = "Failed to process SessionCallPayload { ... } with error: transaction reverted: NotEnoughBalance, receipts: [Panic { id: abc, reason: PanicInstruction { reason: NotEnoughBalance, instruction: CALL { } }, pc: 123, is: 456 }]";
        let decoded = augment_revert_reason(message, reason, None);
        assert_eq!(decoded, "NotEnoughBalance");
    }

    #[test]
    fn extracts_revert_ra_from_embedded_receipts() {
        let message = "Failed to process transaction";
        let reason = "Failed to process SessionCallPayload { actions: [MarketActions { actions: [CreateOrder { side: Buy }] }] } receipts: [Revert { id: abc, ra: 18446744073709486086, pc: 123, is: 456 }]";
        let decoded = augment_revert_reason(message, reason, None);
        assert!(
            decoded.contains("OrderCreationError::FractionalPrice"),
            "got: {decoded}"
        );
    }
}
