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
from o2_sdk.onchain_revert import (
    MISMATCHED_SELECTOR_REASON,
    augment_revert_reason,
    is_selector_mismatch_revert,
)

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
    """Plain API errors without on-chain evidence raise O2Error, not OnChainRevert."""
    from o2_sdk.errors import O2Error

    data = {
        "message": "Something went wrong",
        "reason": "out of gas",
    }
    with pytest.raises(O2Error) as exc_info:
        raise_for_error(data)

    err = exc_info.value
    assert not isinstance(err, OnChainRevert)
    assert err.message == "Something went wrong"


def test_on_chain_revert_str_without_reason():
    err = OnChainRevert(message="raw msg", reason=None)
    assert str(err) == "On-chain revert: raw msg"


# ---------------------------------------------------------------------------
# Dispatcher selector mismatch (Revert(123))
#
# This is the ONLY reliable signal that a trade account's proxy still targets a
# pre-parallel-nonce implementation: the indexer reports V3 for every synced
# account, so the version field can never tell these apart.
# ---------------------------------------------------------------------------

# Shape of a parallel submission against a legacy proxy: the dispatcher does not
# recognize the selector, so there is no LOG receipt and nothing to decode.
SELECTOR_MISMATCH_REASON = (
    "Failed to process SessionCallPayload { parallel_nonce: Some(123456789) } "
    "with error: Transaction def456 failed with logs: LogResult { results: [] } "
    "and error: transaction reverted: Revert(123), "
    "receipts: [Call { id: 0000, to: 18f9, amount: 0 }, "
    "Revert { id: 18f9, ra: 123 }, "
    "ScriptResult { result: Revert, gas_used: 12345 }]"
)


def test_selector_mismatch_reason_is_named():
    decoded = augment_revert_reason("Failed to process transaction", SELECTOR_MISMATCH_REASON, None)
    assert decoded == MISMATCHED_SELECTOR_REASON


def test_selector_mismatch_detected_from_raised_error():
    data = {
        "message": "Failed to process transaction",
        "reason": SELECTOR_MISMATCH_REASON,
        "receipts": None,
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)
    assert is_selector_mismatch_revert(exc_info.value)


def test_selector_mismatch_detected_from_receipts_alone():
    """The augmented reason is not the only evidence: even when the decoder
    picks a different summary, the raw reason and receipts are still searched."""
    err = OnChainRevert(
        message="Failed to process transaction",
        reason="something else entirely",
        receipts=[{"Revert": {"id": "0x18f9", "ra": 123}}],
        raw_reason=None,
    )
    assert is_selector_mismatch_revert(err)


def test_selector_mismatch_detected_from_raw_reason():
    err = OnChainRevert(
        message="Failed to process transaction",
        reason="truncated summary with no revert code",
        receipts=None,
        raw_reason=SELECTOR_MISMATCH_REASON,
    )
    assert is_selector_mismatch_revert(err)


def test_raw_reason_preserved_through_augmentation():
    data = {
        "message": "Failed to process transaction",
        "reason": REALISTIC_REASON,
        "receipts": None,
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)
    err = exc_info.value
    assert err.raw_reason == REALISTIC_REASON
    assert err.reason != REALISTIC_REASON  # augmented


def test_other_reverts_are_not_selector_mismatches():
    """A real order-book revert must never be mistaken for a missing selector,
    or a healthy account would be needlessly upgraded on every startup."""
    data = {
        "message": "Failed to process transaction",
        "reason": REALISTIC_REASON,
        "receipts": None,
    }
    with pytest.raises(OnChainRevert) as exc_info:
        raise_for_error(data)
    assert not is_selector_mismatch_revert(exc_info.value)


def test_selector_mismatch_accepts_plain_strings():
    assert is_selector_mismatch_revert("transaction reverted: Revert(123)")
    assert is_selector_mismatch_revert(MISMATCHED_SELECTOR_REASON)
    assert not is_selector_mismatch_revert("transaction reverted: Revert(1234)")
    assert not is_selector_mismatch_revert("")


def test_selector_mismatch_ignores_unrelated_exceptions():
    assert not is_selector_mismatch_revert(RuntimeError("connection reset"))


def test_ra_on_a_non_revert_receipt_is_not_a_selector_mismatch():
    """LogData receipts carry an ``ra`` too. Reading a revert code out of one
    would upgrade healthy accounts on a coincidence."""
    err = OnChainRevert(
        message="Failed to process transaction",
        reason="some other failure",
        receipts=[
            {"LogData": {"id": "0x18f9", "ra": 123, "rb": 0}},
            {"ScriptResult": {"result": "Success", "gas_used": 1}},
        ],
        raw_reason=None,
    )
    assert not is_selector_mismatch_revert(err)


def test_selector_mismatch_from_internally_tagged_receipts():
    err = OnChainRevert(
        message="Failed to process transaction",
        reason="some other failure",
        receipts=[{"type": "Revert", "id": "0x18f9", "ra": "123"}],
        raw_reason=None,
    )
    assert is_selector_mismatch_revert(err)


# ---------------------------------------------------------------------------
# On-chain already-used (ExtendedNonceError::AlreadyUsed)
#
# The venue reports an already-consumed nonce slot two ways depending on
# whether the indexer has caught up. This is the on-chain form, captured
# VERBATIM from testnet on 2026-08-04 by
# experiments/nonce_collision_experiment.py. Note it arrives as InternalError
# code 1000, not OnChainRevert, and the signal is in `reason`.
# ---------------------------------------------------------------------------

ONCHAIN_ALREADY_USED_REASON = (
    "Transaction a43280780d9e33eec24c5f355c4065759e095fa04fbba75924ab1e74192ef1d7 "
    'failed with logs: LogResult { results: [Ok("AlreadyUsed")] } and error: '
    "transaction reverted: Revert(18446744073709486086), receipts: [Call { id: "
    "0000000000000000000000000000000000000000000000000000000000000000, to: "
    "487c1e35622760958ba2e76f12995ebd5f61c55120d9ac3e9947c004e1f54d9b, amount: 0, "
    "asset_id: f8f8b6283d7fa5b672b530cbb84fcccb4ff8dc40f8176ef4544ddb1f1952ad07, "
    "gas: 998623, param1: 10480, param2: 10514, pc: 12456, is: 12456 }]"
)


def _real_onchain_already_used():
    from o2_sdk.errors import InternalError

    return InternalError(
        message="transaction reverted: Revert(18446744073709486086)",
        code=1000,
        reason=ONCHAIN_ALREADY_USED_REASON,
    )


def test_onchain_already_used_is_recognised():
    from o2_sdk.onchain_revert import is_onchain_already_used

    assert is_onchain_already_used(_real_onchain_already_used())


def test_parallel_nonce_already_used_covers_the_onchain_form():
    """The whole point of the fix: one predicate, both forms."""
    from o2_sdk.nonce import is_parallel_nonce_already_used

    assert is_parallel_nonce_already_used(_real_onchain_already_used())
    # and the API form still works
    assert is_parallel_nonce_already_used("Parallel nonce is not usable: nonce already used")


def test_onchain_already_used_does_not_match_other_logged_variants():
    """Negative control. Matching a decoded variant rather than a substring is
    what keeps an unrelated revert from being read as a nonce collision."""
    from o2_sdk.nonce import is_parallel_nonce_already_used
    from o2_sdk.onchain_revert import is_onchain_already_used

    for variant in (
        "OrderPartiallyFilled",
        "TraderNotWhiteListed",
        "TraderAlreadyWhitelisted",  # contains "Already", must not match
        "OwnerAlreadyHasTradeAccount",
        "NotEnoughBalance",
    ):
        err = OnChainRevert(
            message="Failed to process transaction",
            reason=f'failed with logs: LogResult {{ results: [Ok("{variant}")] }}',
        )
        assert not is_onchain_already_used(err), variant
        assert not is_parallel_nonce_already_used(err), variant


def test_logged_variants_extracts_decoded_names():
    from o2_sdk.onchain_revert import logged_variants

    text = 'LogResult { results: [Ok("IncrementNonceEvent"), Ok("AlreadyUsed")] }'
    assert logged_variants(text) == {"IncrementNonceEvent", "AlreadyUsed"}
    # Escaped form, which is how it arrives when the backend JSON-encodes it.
    assert "AlreadyUsed" in logged_variants('[Ok(\\"AlreadyUsed\\")]')


def test_onchain_already_used_is_not_confused_with_out_of_window():
    """The two must stay separable: one is safe to retry, one is not."""
    from o2_sdk.nonce import is_parallel_nonce_already_used, is_parallel_nonce_out_of_window

    err = _real_onchain_already_used()
    assert is_parallel_nonce_already_used(err)
    assert not is_parallel_nonce_out_of_window(err)
