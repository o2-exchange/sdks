"""Tests for on-chain revert code decoding.

Tests the new decoding strategy:
1. LogResult extraction (backend-decoded names)
2. LogData receipt parsing (logId + discriminant)
3. Signal constant recognition
4. PanicInstruction extraction
5. "and error:" fallback
"""

from __future__ import annotations

import pytest

from o2_sdk.errors import OnChainRevert, raise_for_error
from o2_sdk.onchain_revert import augment_revert_reason

# ---------------------------------------------------------------------------
# Realistic reason string from a real backend error response.
# The backend wraps the fuels-rs error chain in the reason field.
# ---------------------------------------------------------------------------

REALISTIC_REASON = (
    "Failed to process SessionCallPayload { actions: [MarketActions { actions: "
    "[SettleBalance, CreateOrder { side: Buy }] }] } with error: "
    "Transaction abc123 failed with logs: LogResult { results: "
    '[Ok("IncrementNonceEvent { nonce: 2752 }"), '
    'Ok("SessionContractCallEvent { nonce: 2751 }"), '
    'Ok("SessionContractCallEvent { nonce: 2751 }"), '
    'Ok("OrderCreatedEvent { quantity: 1000000, price: 2129980000000 }"), '
    'Ok("OrderMatchedEvent { quantity: 1000000, price: 2129320000000 }"), '
    'Ok("FeesCollectedEvent { base_fees: 100, quote_fees: 0 }"), '
    'Ok("OrderPartiallyFilled")] } '
    "and error: transaction reverted: Revert(18446744073709486086), "
    "receipts: [Call { id: 0000, to: f155, amount: 0 }, "
    "LogData { id: f155, ra: 0, rb: 2261086600904378517, ptr: 67108286, len: 8, "
    "digest: abc, data: Some(Bytes(0000000000000000)) }, "
    "LogData { id: 2a78, ra: 0, rb: 12033795032676640771, ptr: 67100980, len: 8, "
    "digest: 4c0e, data: Some(Bytes(0000000000000008)) }, "
    "Revert { id: 2a78, ra: 18446744073709486086 }, "
    "ScriptResult { result: Revert }]"
)


# ---------------------------------------------------------------------------
# Strategy 1: LogResult extraction
# ---------------------------------------------------------------------------


def test_extracts_error_from_log_result():
    """The last Ok("...") matching a known variant is extracted."""
    decoded = augment_revert_reason("Failed to process transaction", REALISTIC_REASON, None)
    assert (
        decoded
        == "OrderCreationError::OrderPartiallyFilled \u2014 PostOnly order would cross the spread. Use a lower buy price or higher sell price."
    )


def test_log_result_with_escaped_quotes():
    """Backend JSON-encodes the reason, so Ok entries have escaped quotes."""
    reason = (
        'LogResult { results: [Ok(\\"IncrementNonceEvent\\"), Ok(\\"TraderNotWhiteListed\\")] }'
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert (
        decoded
        == "OrderCreationError::TraderNotWhiteListed \u2014 Account not whitelisted. Call whitelist_account() first."
    )


def test_log_result_ignores_non_error_entries():
    """Event names that aren't error variants are skipped."""
    reason = (
        'LogResult { results: [Ok("IncrementNonceEvent"), '
        'Ok("OrderCreatedEvent"), Ok("NotEnoughBalance")] }'
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert decoded == "WithdrawError::NotEnoughBalance \u2014 Insufficient balance for withdrawal"


# ---------------------------------------------------------------------------
# Strategy 2: LogData receipt parsing
# ---------------------------------------------------------------------------


def test_extracts_error_from_logdata_receipt():
    """Parse logId (rb) and discriminant (data) from embedded LogData receipt."""
    # LogData with rb=12033795032676640771 (OrderCreationError) and data=0x08 (OrderPartiallyFilled)
    reason = (
        "receipts: [LogData { id: abc, ra: 0, rb: 12033795032676640771, "
        "ptr: 100, len: 8, digest: def, data: Some(Bytes(0000000000000008)) }, "
        "Revert { id: abc, ra: 18446744073709486086 }]"
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert (
        decoded
        == "OrderCreationError::OrderPartiallyFilled \u2014 PostOnly order would cross the spread. Use a lower buy price or higher sell price."
    )


def test_logdata_discriminant_zero():
    """Discriminant 0 = first variant."""
    reason = (
        "LogData { id: x, ra: 0, rb: 12033795032676640771, "
        "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, "
        "Revert { id: x, ra: 18446744073709486086 }"
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert decoded == "OrderCreationError::InvalidOrderArgs \u2014 Order arguments are invalid"


def test_logdata_withdraw_error():
    """Different enum: WithdrawError logId with discriminant 1 = NotEnoughBalance."""
    reason = (
        "LogData { id: x, ra: 0, rb: 14888260448086063780, "
        "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000001)) }, "
        "Revert { id: x, ra: 18446744073709486000 }"
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert decoded == "WithdrawError::NotEnoughBalance \u2014 Insufficient balance for withdrawal"


def test_logdata_unknown_log_id_falls_through():
    """Unknown logId doesn't match any enum — falls through to next strategy."""
    reason = (
        "LogData { id: x, ra: 0, rb: 9999999999999999999, "
        "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, "
        "Revert { id: x, ra: 18446744073709486086 }"
    )
    decoded = augment_revert_reason("msg", reason, None)
    # Falls through to signal recognition
    assert "REVERT_WITH_LOG" in decoded


# ---------------------------------------------------------------------------
# Strategy 3: Signal constant recognition
# ---------------------------------------------------------------------------


def test_recognizes_failed_require_signal():
    reason = "Revert(18446744073709486080)"  # 0xffffffffffff0000
    decoded = augment_revert_reason("msg", reason, None)
    assert "FAILED_REQUIRE" in decoded


def test_recognizes_revert_with_log_signal():
    reason = "Revert(18446744073709486086)"  # 0xffffffffffff0006
    decoded = augment_revert_reason("msg", reason, None)
    assert "REVERT_WITH_LOG" in decoded


def test_non_signal_revert_code_falls_through():
    """A revert code that isn't a known signal passes through."""
    decoded = augment_revert_reason("msg", "Revert(42)", None)
    # Falls through to truncation — reason is the raw "Revert(42)"
    assert decoded == "Revert(42)"


# ---------------------------------------------------------------------------
# Strategy 4: PanicInstruction
# ---------------------------------------------------------------------------


def test_extracts_panic_reason():
    reason = (
        "receipts: [Panic { id: abc, reason: PanicInstruction "
        "{ reason: NotEnoughBalance, instruction: CALL {} }, pc: 123 }]"
    )
    decoded = augment_revert_reason("msg", reason, None)
    assert decoded == "NotEnoughBalance"


# ---------------------------------------------------------------------------
# Strategy 5: "and error:" fallback
# ---------------------------------------------------------------------------


def test_extracts_and_error_summary():
    reason = "lots of noise and error: transaction reverted: SomeError, receipts: [...]"
    decoded = augment_revert_reason("msg", reason, None)
    assert decoded == "transaction reverted: SomeError"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_leaves_reason_unchanged_when_no_patterns():
    decoded = augment_revert_reason("plain error", "some reason", None)
    assert decoded == "some reason"


def test_reason_none_treated_as_empty():
    decoded = augment_revert_reason("plain error", None, None)
    assert decoded == ""


def test_truncates_long_reason():
    reason = "x" * 500
    decoded = augment_revert_reason("error", reason, None)
    assert len(decoded) < 300
    assert "truncated" in decoded


def test_receipts_json_searched():
    """Structured receipts are JSON-serialized and searched."""
    receipts = [{"note": 'Ok("InvalidNonce")'}]
    decoded = augment_revert_reason("msg", "", receipts)
    assert (
        decoded
        == "NonceError::InvalidNonce \u2014 Nonce is stale or out of sequence. Refresh the nonce and retry."
    )


def test_priority_log_result_over_logdata():
    """LogResult extraction takes priority over LogData parsing."""
    decoded = augment_revert_reason("Failed to process transaction", REALISTIC_REASON, None)
    # Should get OrderPartiallyFilled from LogResult, not from LogData
    assert "OrderPartiallyFilled" in decoded


# ---------------------------------------------------------------------------
# Integration: raise_for_error produces OnChainRevert with decoded reason
# ---------------------------------------------------------------------------


def test_raise_for_error_decodes_on_chain_revert():
    data = {
        "message": "Failed to process transaction",
        "reason": REALISTIC_REASON,
        "receipts": None,
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)

    err = exc_info.value
    assert "OrderPartiallyFilled" in err.reason
    assert str(err).startswith("On-chain revert:")
    assert "OrderPartiallyFilled" in str(err)


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
