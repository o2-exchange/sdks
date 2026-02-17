use serde_json::Value;

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

fn lookup_variant(enum_name: &str, ordinal_1_based: usize) -> Option<&'static str> {
    let (_, variants) = ABI_ERROR_ENUMS
        .iter()
        .find(|(name, _)| *name == enum_name)?;
    if ordinal_1_based == 0 || ordinal_1_based > variants.len() {
        return None;
    }
    Some(variants[ordinal_1_based - 1])
}

fn extract_revert_codes(text: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let mut offset = 0usize;
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
    out
}

fn decode_revert_code(raw: u64, context: &str) -> Option<String> {
    // `revert_with_log` / `require` error signal convention:
    // 0xffffffffffff0000 | ordinal_1_based
    if (raw & 0xffff_ffff_ffff_0000) != 0xffff_ffff_ffff_0000 {
        return None;
    }
    let ordinal = (raw & 0xffff) as usize;
    if ordinal == 0 {
        return None;
    }

    if let Some(enum_name) = infer_enum_from_context(context) {
        if let Some(variant) = lookup_variant(enum_name, ordinal) {
            return Some(format!(
                "{enum_name}::{variant} (ordinal={ordinal}, raw=0x{raw:016x})"
            ));
        }
    }

    let candidates: Vec<String> = ABI_ERROR_ENUMS
        .iter()
        .filter_map(|(name, variants)| {
            if ordinal <= variants.len() {
                Some(format!("{name}::{}", variants[ordinal - 1]))
            } else {
                None
            }
        })
        .collect();

    if candidates.is_empty() {
        return Some(format!(
            "unknown ABI error ordinal={ordinal} (raw=0x{raw:016x})"
        ));
    }

    if candidates.len() == 1 {
        return Some(format!(
            "{} (ordinal={}, raw=0x{:016x})",
            candidates[0], ordinal, raw
        ));
    }

    Some(format!(
        "ambiguous ABI error ordinal={} (raw=0x{:016x}); candidates=[{}]",
        ordinal,
        raw,
        candidates.join(", ")
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

    match (reason.is_empty(), decoded) {
        (_, None) => reason.to_string(),
        (true, Some(mapped)) => mapped,
        (false, Some(mapped)) => {
            if reason.contains(&mapped) {
                reason.to_string()
            } else {
                format!("{reason} [{mapped}]")
            }
        }
    }
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
        assert!(decoded.contains("OrderCreationError::InvalidHeapPrices"));
    }

    #[test]
    fn decodes_even_when_reason_is_empty() {
        let message = "CreateOrder failed Revert(18446744073709486089)";
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
}
