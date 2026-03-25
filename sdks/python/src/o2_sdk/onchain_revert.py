"""Decode Fuel VM revert codes into human-readable contract error names.

Ports the Rust implementation from ``onchain_revert.rs``.

Fuel's ``revert_with_log`` / ``require`` uses the convention::

    raw_code = 0xffffffffffff0000 | ordinal

This module extracts ``Revert(DIGITS)`` patterns from error messages,
decodes the ordinal into a named enum variant, and augments the reason
string so that users see e.g.
``OrderCreationError::OrderPartiallyFilled`` instead of a raw u64.
"""

from __future__ import annotations

import json
import re
from typing import Any

# ---------------------------------------------------------------------------
# ABI error enum mapping (0-based ordinals)
#
# Source of truth: abi/mainnet/*.json (metadataTypes → enum components).
# See CLAUDE.md "Maintaining On-Chain Revert Decoding" for update procedure.
# ---------------------------------------------------------------------------

ABI_ERROR_ENUMS: list[tuple[str, list[str]]] = [
    (
        "contract_schema::blacklist::BlacklistError",
        ["TraderAlreadyBlacklisted", "TraderNotBlacklisted"],
    ),
    (
        "contract_schema::order_book::FeeError",
        ["NoFeesAvailable"],
    ),
    (
        "contract_schema::order_book::OrderBookInitializationError",
        [
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
        ["NotOrderOwner", "TraderNotBlacklisted", "NoBlacklist"],
    ),
    (
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
    ),
    (
        "contract_schema::register::OrderBookRegistryError",
        ["MarketAlreadyHasOrderBook", "InvalidPair"],
    ),
    (
        "contract_schema::register::TradeAccountRegistryError",
        [
            "OwnerAlreadyHasTradeAccount",
            "TradeAccountNotRegistered",
            "TradeAccountAlreadyHasReferer",
        ],
    ),
    (
        "contract_schema::trade_account::CallerError",
        ["InvalidCaller"],
    ),
    (
        "contract_schema::trade_account::NonceError",
        ["InvalidNonce"],
    ),
    (
        "contract_schema::trade_account::SessionError",
        ["SessionInThePast", "NoApprovedContractIdsProvided"],
    ),
    (
        "contract_schema::trade_account::SignerError",
        ["InvalidSigner", "ProxyOwnerIsContract"],
    ),
    (
        "contract_schema::trade_account::WithdrawError",
        ["AmountIsZero", "NotEnoughBalance"],
    ),
    (
        "contract_schema::whitelist::WhitelistError",
        ["TraderAlreadyWhitelisted", "TraderNotWhitelisted"],
    ),
    (
        "ownership::errors::InitializationError",
        ["CannotReinitialized"],
    ),
    (
        "pausable::errors::PauseError",
        ["Paused", "NotPaused"],
    ),
    (
        "src5::AccessError",
        ["NotOwner"],
    ),
    (
        "std::crypto::signature_error::SignatureError",
        [
            "UnrecoverablePublicKey",
            "InvalidPublicKey",
            "InvalidSignature",
            "InvalidOperation",
        ],
    ),
    (
        "upgradability::errors::SetProxyOwnerError",
        ["CannotUninitialize"],
    ),
]

_REVERT_RE = re.compile(r"Revert\((\d+)\)")

_FUEL_MASK = 0xFFFF_FFFF_FFFF_0000
_FUEL_TAG = 0xFFFF_FFFF_FFFF_0000


# ---------------------------------------------------------------------------
# Context inference
# ---------------------------------------------------------------------------


def _infer_enum_from_context(context: str) -> str | None:
    """Narrow down to a specific enum based on action keywords in *context*."""
    if "CreateOrder" in context:
        return "contract_schema::order_book::OrderCreationError"
    if "CancelOrder" in context:
        return "contract_schema::order_book::OrderCancelError"
    if "SettleBalance" in context or "settle_balance" in context:
        return "contract_schema::order_book::OrderCreationError"
    if "withdraw" in context or "Withdraw" in context:
        return "contract_schema::trade_account::WithdrawError"
    if "register_referer" in context:
        return "contract_schema::register::TradeAccountRegistryError"
    if "session" in context or "Session" in context:
        return "contract_schema::trade_account::SessionError"
    if "nonce" in context or "Nonce" in context:
        return "contract_schema::trade_account::NonceError"
    return None


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------


def _lookup_variant(enum_name: str, ordinal: int) -> str | None:
    """Return the variant name for *ordinal* (0-based) inside *enum_name*."""
    for name, variants in ABI_ERROR_ENUMS:
        if name == enum_name:
            if ordinal < 0 or ordinal >= len(variants):
                return None
            return variants[ordinal]
    return None


def _extract_revert_codes(text: str) -> list[int]:
    """Return all revert code values found in *text*.

    Matches both ``Revert(DIGITS)`` (from structured receipts) and
    ``Revert { ... ra: DIGITS ... }`` (Rust Debug format embedded in
    reason strings when the backend doesn't send structured receipts).
    Uses string search for embedded receipts to avoid ReDoS.
    """
    codes = [int(m.group(1)) for m in _REVERT_RE.finditer(text)]
    # Revert { ... ra: DIGITS ... } — string search, no regex
    search_from = 0
    while True:
        idx = text.find("Revert {", search_from)
        if idx == -1:
            break
        ra_idx = text.find("ra:", idx)
        brace_end = text.find("}", idx)
        if ra_idx != -1 and (brace_end == -1 or ra_idx < brace_end):
            start = ra_idx + 3
            while start < len(text) and text[start] == " ":
                start += 1
            end = start
            while end < len(text) and text[end].isdigit():
                end += 1
            if end > start:
                codes.append(int(text[start:end]))
        search_from = idx + 8
    return codes


def _extract_panic_reason(text: str) -> str | None:
    """Extract a Fuel VM panic reason from embedded receipt text.

    Matches ``PanicInstruction { reason: NotEnoughBalance, ... }`` from
    Rust Debug formatted receipts. Uses string search to avoid ReDoS.
    """
    marker = "PanicInstruction {"
    idx = text.find(marker)
    if idx == -1:
        return None
    reason_idx = text.find("reason:", idx + len(marker))
    if reason_idx == -1:
        return None
    start = reason_idx + len("reason:")
    while start < len(text) and text[start] == " ":
        start += 1
    end = start
    while end < len(text) and (text[end].isalnum() or text[end] == "_"):
        end += 1
    name = text[start:end]
    return name or None


def _decode_revert_code(raw: int, context: str) -> str | None:
    """Decode a single Fuel VM revert *raw* code into a human string."""
    if (raw & _FUEL_MASK) != _FUEL_TAG:
        return None
    ordinal = raw & 0xFFFF

    # Try context-based inference first.
    inferred = _infer_enum_from_context(context)
    if inferred is not None:
        variant = _lookup_variant(inferred, ordinal)
        if variant is not None:
            return f"{inferred}::{variant} (ordinal={ordinal}, raw=0x{raw:016x})"

    # Fallback: try all enums (0-based ordinals).
    candidates: list[str] = []
    for name, variants in ABI_ERROR_ENUMS:
        if ordinal < len(variants):
            candidates.append(f"{name}::{variants[ordinal]}")

    if not candidates:
        return f"unknown ABI error ordinal={ordinal} (raw=0x{raw:016x})"

    # Deprioritize admin-only enums that SDK users won't encounter.
    if len(candidates) > 1:
        filtered = [
            c
            for c in candidates
            if "InitializationError" not in c
            and "SetProxyOwnerError" not in c
            and "AccessError" not in c
            and "PauseError" not in c
        ]
        if filtered:
            candidates = filtered

    if len(candidates) == 1:
        return f"{candidates[0]} (ordinal={ordinal}, raw=0x{raw:016x})"

    joined = ", ".join(candidates)
    return f"ambiguous ABI error ordinal={ordinal} (raw=0x{raw:016x}); candidates=[{joined}]"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def augment_revert_reason(
    message: str,
    reason: str | None,
    receipts: Any | None,
) -> str:
    """Return an augmented *reason* string with decoded revert info.

    Parameters
    ----------
    message:
        The full error ``message`` field from the API response.
    reason:
        The ``reason`` field (may be ``None`` or empty).
    receipts:
        The ``receipts`` field (list / dict / None).  Serialised to text
        for pattern matching.

    Returns
    -------
    str
        The original *reason* (or ``""``) augmented with a decoded
        ``[EnumName::Variant (...)]`` suffix when a revert code is found.
    """
    reason = reason or ""

    receipts_text = ""
    if receipts is not None:
        try:
            receipts_text = json.dumps(receipts)
        except (TypeError, ValueError):
            receipts_text = str(receipts)

    context = f"{message}\n{reason}\n{receipts_text}"

    decoded: str | None = None
    for raw in _extract_revert_codes(context):
        decoded = _decode_revert_code(raw, context)
        if decoded is not None:
            break

    if decoded is not None:
        # Return just the decoded name — the raw reason/receipts dump can be
        # several KB and makes log lines unreadable. Full receipts are still
        # accessible via OnChainRevert.receipts for callers that need them.
        return decoded

    # Check for Fuel VM Panic receipts embedded in the reason string
    # (e.g. PanicInstruction { reason: NotEnoughBalance }).
    panic = _extract_panic_reason(context)
    if panic:
        return panic

    # No decodable revert code found. Try to extract the "and error: ..."
    # summary the backend embeds after the LogResult noise.
    err_idx = context.find("and error:")
    if err_idx != -1:
        after = context[err_idx + len("and error:") :].strip()
        # Take up to the next ", receipts:" or end
        receipts_idx = after.find(", receipts:")
        summary = after[:receipts_idx].strip() if receipts_idx != -1 else after[:200]
        if summary:
            return summary

    # Cap the raw reason to avoid dumping multi-KB receipt blobs.
    if len(reason) > 200:
        return f"{reason[:200]}... (truncated, full receipts on .receipts)"
    return reason
