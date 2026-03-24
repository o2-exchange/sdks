"""Decode Fuel VM revert codes into human-readable contract error names.

Ports the Rust implementation from ``onchain_revert.rs``.

Fuel's ``revert_with_log`` / ``require`` uses the convention::

    raw_code = 0xffffffffffff0000 | ordinal_1_based

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
# ABI error enum mapping (1-based ordinals)
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

def _lookup_variant(enum_name: str, ordinal_1_based: int) -> str | None:
    """Return the variant name for *ordinal_1_based* inside *enum_name*."""
    for name, variants in ABI_ERROR_ENUMS:
        if name == enum_name:
            if ordinal_1_based < 1 or ordinal_1_based > len(variants):
                return None
            return variants[ordinal_1_based - 1]
    return None


def _extract_revert_codes(text: str) -> list[int]:
    """Return all ``Revert(DIGITS)`` values found in *text*."""
    return [int(m.group(1)) for m in _REVERT_RE.finditer(text)]


def _decode_revert_code(raw: int, context: str) -> str | None:
    """Decode a single Fuel VM revert *raw* code into a human string."""
    if (raw & _FUEL_MASK) != _FUEL_TAG:
        return None
    ordinal = raw & 0xFFFF
    if ordinal == 0:
        return None

    # Try context-based inference first.
    inferred = _infer_enum_from_context(context)
    if inferred is not None:
        variant = _lookup_variant(inferred, ordinal)
        if variant is not None:
            return (
                f"{inferred}::{variant} "
                f"(ordinal={ordinal}, raw=0x{raw:016x})"
            )

    # Fallback: try all enums.
    candidates: list[str] = []
    for name, variants in ABI_ERROR_ENUMS:
        if ordinal <= len(variants):
            candidates.append(f"{name}::{variants[ordinal - 1]}")

    if not candidates:
        return f"unknown ABI error ordinal={ordinal} (raw=0x{raw:016x})"

    if len(candidates) == 1:
        return f"{candidates[0]} (ordinal={ordinal}, raw=0x{raw:016x})"

    joined = ", ".join(candidates)
    return (
        f"ambiguous ABI error ordinal={ordinal} "
        f"(raw=0x{raw:016x}); candidates=[{joined}]"
    )


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

    if decoded is None:
        return reason

    if not reason:
        return decoded

    if decoded in reason:
        return reason

    return f"{reason} [{decoded}]"
