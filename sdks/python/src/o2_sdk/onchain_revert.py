"""Decode Fuel VM on-chain revert errors into human-readable names.

The backend wraps on-chain failures as ``code: 1000`` (InternalError) with the
Fuel VM receipt data embedded in the ``reason`` string.  This module extracts
the actual error variant from that text using two strategies:

1. **LogResult extraction** — The backend's fuels-rs SDK decodes the LOG receipt
   and includes the result in a ``LogResult { results: [..., Ok("VariantName")] }``
   block.  We extract the last ``Ok("...")`` entry, which is the error name.

2. **LogData receipt parsing** — Each ``LogData`` receipt carries ``rb`` (the ABI
   log-ID that identifies the enum type) and ``data`` (the ABI-encoded value whose
   first 8 bytes are the 0-based variant discriminant).  We match ``rb`` against
   the ABI's ``loggedTypes`` and index into the variant list.

Sway's ``require()`` and ``revert_with_log()`` both emit a LOG receipt with the
typed error value, then revert with a **fixed signal constant** (not the variant
ordinal).  The signal constants are:

* ``0xffffffffffff0000`` — ``FAILED_REQUIRE``
* ``0xffffffffffff0001`` — ``FAILED_TRANSFER_TO_ADDRESS``
* ``0xffffffffffff0003`` — ``FAILED_ASSERT_EQ``
* ``0xffffffffffff0004`` — ``FAILED_ASSERT``
* ``0xffffffffffff0005`` — ``FAILED_ASSERT_NE``
* ``0xffffffffffff0006`` — ``REVERT_WITH_LOG``
"""

from __future__ import annotations

import json
import re
from typing import Any

# ---------------------------------------------------------------------------
# ABI error enums — variant lists keyed by logId
#
# Source of truth: abi/mainnet/*.json  (loggedTypes + concreteTypes).
# Validate with:  python scripts/validate_abi_enums.py
# ---------------------------------------------------------------------------

# logId (u64 from LogData receipt rb register) → (fully-qualified enum name, [(variant, description)])
# Variant index = 0-based discriminant found in LogData.data first 8 bytes.
ABI_ERROR_ENUMS: dict[int, tuple[str, list[tuple[str, str]]]] = {
    537125673719950211: (
        "upgradability::errors::SetProxyOwnerError",
        [("CannotUninitialize", "Cannot uninitialize proxy owner")],
    ),
    821289540733930261: (
        "contract_schema::trade_account::CallerError",
        [("InvalidCaller", "Caller is not authorized for this operation")],
    ),
    1043998670105365804: (
        "contract_schema::order_book::OrderCancelError",
        [
            ("NotOrderOwner", "You can only cancel your own orders"),
            ("TraderNotBlacklisted", "Trader is not blacklisted"),
            ("NoBlacklist", "No blacklist configured for this market"),
        ],
    ),
    2735857006735158246: (
        "contract_schema::trade_account::SessionError",
        [
            ("SessionInThePast", "Session expiry is in the past. Create a new session."),
            (
                "NoApprovedContractIdsProvided",
                "Session must include at least one approved contract",
            ),
        ],
    ),
    4755763688038835574: (
        "contract_schema::order_book::FeeError",
        [("NoFeesAvailable", "No fees to collect")],
    ),
    4997665884103701952: (
        "pausable::errors::PauseError",
        [
            ("Paused", "Market is paused"),
            ("NotPaused", "Market is not paused"),
        ],
    ),
    5347491661573165298: (
        "contract_schema::whitelist::WhitelistError",
        [
            ("TraderAlreadyWhitelisted", "Account is already whitelisted"),
            ("TraderNotWhitelisted", "Account is not whitelisted"),
        ],
    ),
    8930260739195532515: (
        "contract_schema::order_book::OrderBookInitializationError",
        [
            ("InvalidAsset", "Invalid asset configuration (admin)"),
            ("InvalidDecimals", "Invalid decimals configuration (admin)"),
            ("InvalidPriceWindow", "Invalid price window (admin)"),
            ("InvalidPricePrecision", "Invalid price precision (admin)"),
            ("OwnerNotSet", "Owner not set (admin)"),
            ("InvalidMinOrder", "Invalid minimum order (admin)"),
        ],
    ),
    9305944841695250538: (
        "contract_schema::register::TradeAccountRegistryError",
        [
            ("OwnerAlreadyHasTradeAccount", "This wallet already has a trade account"),
            ("TradeAccountNotRegistered", "Trade account not found. Call setup_account() first."),
            ("TradeAccountAlreadyHasReferer", "Referral code already set for this account"),
        ],
    ),
    11035215306127844569: (
        "contract_schema::trade_account::SignerError",
        [
            ("InvalidSigner", "Signature doesn't match the session signer"),
            ("ProxyOwnerIsContract", "Contract IDs cannot be used as proxy owners"),
        ],
    ),
    12033795032676640771: (
        "contract_schema::order_book::OrderCreationError",
        [
            ("InvalidOrderArgs", "Order arguments are invalid"),
            (
                "InvalidInputAmount",
                "Input amount doesn't match price \u00d7 quantity. Check your balance.",
            ),
            ("InvalidAsset", "Wrong asset for this market"),
            ("PriceExceedsRange", "Price is outside the allowed range for this market"),
            (
                "PricePrecision",
                "Price doesn't align with the market's tick size. Use Market.scale_price().",
            ),
            ("InvalidHeapPrices", "Internal order book state error. Retry the order."),
            (
                "FractionalPrice",
                "price \u00d7 quantity must be divisible by 10^base_decimals. Use Market.adjust_quantity().",
            ),
            (
                "OrderNotFilled",
                "FillOrKill order could not be fully filled. Try a smaller quantity or use Spot.",
            ),
            (
                "OrderPartiallyFilled",
                "PostOnly order would cross the spread. Use a lower buy price or higher sell price.",
            ),
            ("TraderNotWhiteListed", "Account not whitelisted. Call whitelist_account() first."),
            ("TraderBlackListed", "Account is blacklisted and cannot trade on this market"),
            ("InvalidMarketOrder", "Market orders are not supported on this order book"),
            ("InvalidMarketOrderArgs", "Invalid arguments for bounded market order"),
        ],
    ),
    12825652816513834595: (
        "ownership::errors::InitializationError",
        [("CannotReinitialized", "Contract already initialized")],
    ),
    13517258236389385817: (
        "contract_schema::blacklist::BlacklistError",
        [
            ("TraderAlreadyBlacklisted", "Account is already blacklisted"),
            ("TraderNotBlacklisted", "Account is not blacklisted"),
        ],
    ),
    14509209538366790003: (
        "std::crypto::signature_error::SignatureError",
        [
            ("UnrecoverablePublicKey", "Could not recover public key from signature"),
            ("InvalidPublicKey", "Public key is invalid"),
            ("InvalidSignature", "Signature verification failed"),
            ("InvalidOperation", "Invalid cryptographic operation"),
        ],
    ),
    14888260448086063780: (
        "contract_schema::trade_account::WithdrawError",
        [
            ("AmountIsZero", "Withdrawal amount must be greater than zero"),
            ("NotEnoughBalance", "Insufficient balance for withdrawal"),
        ],
    ),
    17376141311665587813: (
        "src5::AccessError",
        [("NotOwner", "Caller is not the contract owner")],
    ),
    17909535172322737929: (
        "contract_schema::trade_account::NonceError",
        [("InvalidNonce", "Nonce is stale or out of sequence. Refresh the nonce and retry.")],
    ),
}

# Reverse lookup: variant name → fully qualified "EnumName::VariantName"
_VARIANT_TO_QUALIFIED: dict[str, str] = {}
# Variant name → human-readable description
_VARIANT_DESCRIPTIONS: dict[str, str] = {}
for _enum_name, _variants in ABI_ERROR_ENUMS.values():
    for _v, _desc in _variants:
        # If a variant name appears in multiple enums, keep the first (most specific).
        if _v not in _VARIANT_TO_QUALIFIED:
            _VARIANT_TO_QUALIFIED[_v] = f"{_enum_name}::{_v}"
            _VARIANT_DESCRIPTIONS[_v] = _desc

# Fuel VM signal constants (from sway-lib-std/src/error_signals.sw).
# These are the REVERT receipt ra values — they identify the *type* of failure,
# NOT the specific error variant.
_SIGNAL_NAMES: dict[int, str] = {
    0xFFFF_FFFF_FFFF_0000: "FAILED_REQUIRE",
    0xFFFF_FFFF_FFFF_0001: "FAILED_TRANSFER_TO_ADDRESS",
    0xFFFF_FFFF_FFFF_0003: "FAILED_ASSERT_EQ",
    0xFFFF_FFFF_FFFF_0004: "FAILED_ASSERT",
    0xFFFF_FFFF_FFFF_0005: "FAILED_ASSERT_NE",
    0xFFFF_FFFF_FFFF_0006: "REVERT_WITH_LOG",
}

_REVERT_RE = re.compile(r"Revert\((\d+)\)")
_OK_RE = re.compile(r'Ok\(\\"([^"\\]+)\\"\)|Ok\("([^"]+)"\)')


# ---------------------------------------------------------------------------
# Formatting helper
# ---------------------------------------------------------------------------


def _format_error(enum_name: str, variant: str, description: str) -> str:
    """Return a formatted error string with the short enum name, variant, and description.

    Example: ``OrderCreationError::OrderPartiallyFilled — PostOnly order would cross the spread.``
    """
    short_name = enum_name.split("::")[-1]
    return f"{short_name}::{variant} \u2014 {description}"


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------


def _extract_log_result_error(text: str) -> str | None:
    """Extract the last decoded error name from a ``LogResult { results: [...] }`` block.

    The backend formats failed transaction logs as::

        LogResult { results: [Ok("Event1"), Ok("Event2"), Ok("ErrorName")] }

    The last ``Ok("...")`` entry that matches a known error variant is the error.
    """
    # Find all Ok("...") entries — the last one matching a known variant wins.
    result: str | None = None
    for m in _OK_RE.finditer(text):
        name = m.group(1) or m.group(2)
        if name and name in _VARIANT_TO_QUALIFIED:
            result = name
    if result is not None:
        qualified = _VARIANT_TO_QUALIFIED[result]
        # Extract the enum name (everything before the last ::variant)
        enum_name = qualified.rsplit("::", 1)[0]
        description = _VARIANT_DESCRIPTIONS[result]
        return _format_error(enum_name, result, description)
    return None


def _extract_logdata_error(text: str) -> str | None:
    """Parse the LogData receipt before a Revert receipt for logId + discriminant.

    In the embedded receipt text, the LogData immediately before the Revert has::

        LogData { ..., rb: <logId>, ..., data: Some(Bytes(<hex>)) }

    ``rb`` identifies the enum type (via ABI loggedTypes).
    First 8 bytes of ``data`` (16 hex chars) is the 0-based variant discriminant.
    """
    # Find the last LogData + Revert pair (same contract id).
    # Walk backwards: find last "Revert {", then find the LogData before it.
    revert_idx = text.rfind("Revert {")
    if revert_idx == -1:
        return None

    # Find the LogData immediately preceding this Revert
    logdata_idx = text.rfind("LogData {", 0, revert_idx)
    if logdata_idx == -1:
        return None

    logdata_block = text[logdata_idx:revert_idx]

    # Extract rb: <digits>
    rb_idx = logdata_block.find("rb:")
    if rb_idx == -1:
        return None
    start = rb_idx + 3
    while start < len(logdata_block) and logdata_block[start] == " ":
        start += 1
    end = start
    while end < len(logdata_block) and logdata_block[end].isdigit():
        end += 1
    if end == start:
        return None
    log_id = int(logdata_block[start:end])

    entry = ABI_ERROR_ENUMS.get(log_id)
    if entry is None:
        return None
    enum_name, variants = entry

    # Extract data: Some(Bytes(<hex>))
    data_marker = "Bytes("
    data_idx = logdata_block.find(data_marker)
    if data_idx == -1:
        return None
    hex_start = data_idx + len(data_marker)
    hex_end = logdata_block.find(")", hex_start)
    if hex_end == -1:
        return None
    hex_str = logdata_block[hex_start:hex_end]

    # First 8 bytes = 16 hex chars = u64 big-endian discriminant
    if len(hex_str) < 16:
        return None
    discriminant = int(hex_str[:16], 16)

    if discriminant < len(variants):
        variant_name, description = variants[discriminant]
        return _format_error(enum_name, variant_name, description)
    return f"{enum_name.split('::')[-1]}::unknown(discriminant={discriminant})"


def _extract_panic_reason(text: str) -> str | None:
    """Extract a Fuel VM panic reason from ``PanicInstruction { reason: ... }``."""
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


def _extract_revert_codes(text: str) -> list[int]:
    """Extract all revert codes from ``Revert(DIGITS)`` and ``Revert { ra: DIGITS }``."""
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


def _recognize_signal(text: str) -> str | None:
    """Identify Fuel VM signal constants from revert codes in text."""
    for code in _extract_revert_codes(text):
        name = _SIGNAL_NAMES.get(code)
        if name is not None:
            return name
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def augment_revert_reason(
    message: str,
    reason: str | None,
    receipts: Any | None,
) -> str:
    """Return a human-readable error name decoded from the backend's error response.

    Tries multiple strategies in priority order:

    1. Extract the error variant from the backend's decoded ``LogResult``
    2. Parse the ``LogData`` receipt (logId + discriminant) from embedded receipts
    3. Recognize Fuel VM signal constants
    4. Extract ``PanicInstruction`` reason
    5. Extract ``and error:`` summary
    6. Truncate raw reason as last resort
    """
    reason_str = reason or ""

    receipts_text = ""
    if receipts is not None:
        try:
            receipts_text = json.dumps(receipts)
        except (TypeError, ValueError):
            receipts_text = str(receipts)

    context = f"{message}\n{reason_str}\n{receipts_text}"

    # 1. Extract from backend-decoded LogResult (most reliable)
    decoded = _extract_log_result_error(context)
    if decoded is not None:
        return decoded

    # 2. Parse LogData receipt before Revert (fallback)
    decoded = _extract_logdata_error(context)
    if decoded is not None:
        return decoded

    # 3. Recognize signal constant (tells what KIND of failure, not which variant)
    signal = _recognize_signal(context)

    # 4. Check for PanicInstruction
    panic = _extract_panic_reason(context)
    if panic:
        return panic

    # 5. Extract "and error:" summary
    err_idx = context.find("and error:")
    if err_idx != -1:
        after = context[err_idx + len("and error:") :].strip()
        receipts_idx = after.find(", receipts:")
        summary = after[:receipts_idx].strip() if receipts_idx != -1 else after[:200]
        if summary:
            return summary

    # 6. If we recognized a signal, return it as context
    if signal is not None:
        return f"{signal} (specific error unknown \u2014 check .receipts)"

    # 7. Truncate raw reason
    if len(reason_str) > 200:
        return f"{reason_str[:200]}... (truncated, full receipts on .receipts)"
    return reason_str
