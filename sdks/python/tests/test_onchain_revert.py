"""Tests for on-chain revert code decoding.

Ported from the Rust SDK tests in ``onchain_revert.rs``, plus additional
coverage for the ``errors.py`` integration.
"""

from __future__ import annotations

import pytest

from o2_sdk.errors import OnChainRevert, raise_for_error
from o2_sdk.onchain_revert import augment_revert_reason

# ---------------------------------------------------------------------------
# augment_revert_reason — direct unit tests (ported from Rust)
# ---------------------------------------------------------------------------


def test_decodes_order_creation_error_from_create_order_context():
    message = "Failed payload ... CreateOrder { side: Buy } ... Revert(18446744073709486086)"
    reason = "transaction reverted"
    decoded = augment_revert_reason(message, reason, None)
    assert "OrderCreationError::InvalidHeapPrices" in decoded  # ordinal 6


def test_decodes_even_when_reason_is_empty():
    message = "CreateOrder failed Revert(18446744073709486089)"
    decoded = augment_revert_reason(message, "", None)
    assert "OrderCreationError::OrderPartiallyFilled" in decoded  # ordinal 9


def test_decodes_not_enough_balance():
    message = "withdraw failed Revert(18446744073709486082)"
    decoded = augment_revert_reason(message, "", None)
    assert "WithdrawError::NotEnoughBalance" in decoded  # ordinal 2


def test_leaves_reason_unchanged_when_no_revert_code():
    decoded = augment_revert_reason("plain error", "some reason", None)
    assert decoded == "some reason"


# ---------------------------------------------------------------------------
# Additional coverage
# ---------------------------------------------------------------------------


def test_decodes_cancel_order_context():
    message = "CancelOrder ... Revert(18446744073709486081)"
    decoded = augment_revert_reason(message, "", None)
    assert "OrderCancelError::NotOrderOwner" in decoded  # ordinal 1


def test_decodes_session_context():
    message = "Session payload Revert(18446744073709486081)"
    decoded = augment_revert_reason(message, "tx reverted", None)
    assert "SessionError::SessionInThePast" in decoded  # ordinal 1


def test_decodes_nonce_context():
    message = "bad nonce Revert(18446744073709486081)"
    decoded = augment_revert_reason(message, "", None)
    assert "NonceError::InvalidNonce" in decoded  # ordinal 1


def test_settle_balance_context_maps_to_order_creation():
    message = "SettleBalance ... Revert(18446744073709486089)"
    decoded = augment_revert_reason(message, "", None)
    assert "OrderCreationError::OrderPartiallyFilled" in decoded


def test_ambiguous_fallback_when_no_context():
    # ordinal 1 matches many enums with no context keywords
    message = "something unknown Revert(18446744073709486081)"
    decoded = augment_revert_reason(message, "", None)
    # Should contain "ambiguous" or at least one candidate
    assert "ordinal=1" in decoded


def test_unknown_high_ordinal():
    # ordinal so large it matches no enum
    raw = 0xFFFF_FFFF_FFFF_0000 | 9999
    message = f"Revert({raw})"
    decoded = augment_revert_reason(message, "", None)
    assert "unknown ABI error" in decoded


def test_non_fuel_revert_code_ignored():
    # Low value that doesn't match the 0xffffffffffff0000 mask
    message = "Revert(42)"
    decoded = augment_revert_reason(message, "some reason", None)
    assert decoded == "some reason"


def test_receipts_searched_for_revert_codes():
    message = "some message with no revert code"
    receipts = [
        {"type": "Revert", "ra": 18446744073709486089},
        {"note": "Revert(18446744073709486089)"},
    ]
    decoded = augment_revert_reason(message, "tx reverted", receipts)
    # The Revert(...) pattern appears in the JSON serialisation of receipts
    assert "OrderPartiallyFilled" in decoded


def test_reason_none_treated_as_empty():
    message = "CreateOrder failed Revert(18446744073709486089)"
    decoded = augment_revert_reason(message, None, None)
    assert "OrderCreationError::OrderPartiallyFilled" in decoded


def test_ordinal_zero_ignored():
    raw = 0xFFFF_FFFF_FFFF_0000  # ordinal 0
    message = f"Revert({raw})"
    decoded = augment_revert_reason(message, "reason", None)
    assert decoded == "reason"


def test_truncates_long_reason_without_revert_code():
    """Long raw reasons are truncated to avoid multi-KB log lines."""
    reason = "x" * 500
    decoded = augment_revert_reason("error", reason, None)
    assert len(decoded) < 300
    assert "truncated" in decoded


def test_existing_decoded_returns_clean():
    """When reason already contains the decoded tag, still return clean decoded."""
    tag = "contract_schema::order_book::OrderCreationError::InvalidHeapPrices (ordinal=6, raw=0xffffffffffff0006)"
    reason = f"tx reverted [{tag}]"
    message = "CreateOrder ... Revert(18446744073709486086)"
    decoded = augment_revert_reason(message, reason, None)
    # augment_revert_reason now returns just the decoded name (not the original reason)
    assert decoded == tag


# ---------------------------------------------------------------------------
# Integration: raise_for_error produces OnChainRevert with decoded reason
# ---------------------------------------------------------------------------


def test_raise_for_error_decodes_on_chain_revert():
    data = {
        "message": (
            "Failed to process SessionCallPayload { actions: "
            "[MarketActions { actions: [CreateOrder { side: Sell }] }] } "
            "Revert(18446744073709486089)"
        ),
        "reason": "transaction reverted",
        "receipts": [],
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)

    err = exc_info.value
    assert "OrderCreationError::OrderPartiallyFilled" in err.reason
    assert err.receipts == []
    # __str__ should be concise
    s = str(err)
    assert s.startswith("On-chain revert:")
    assert "OrderPartiallyFilled" in s


def test_raise_for_error_no_revert_code_keeps_original_reason():
    data = {
        "message": "Something went wrong on chain",
        "reason": "out of gas",
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)

    err = exc_info.value
    assert err.reason == "out of gas"
    assert str(err) == "On-chain revert: out of gas"


def test_on_chain_revert_str_without_reason():
    err = OnChainRevert(message="raw msg", reason=None)
    assert str(err) == "On-chain revert: raw msg"
