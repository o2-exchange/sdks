from __future__ import annotations

import ccxt

from o2_sdk.ccxt import O2AmbiguousSubmission, map_o2_error
from o2_sdk.errors import InvalidSession, O2Error, OnChainRevert, RateLimitExceeded


def test_maps_official_ccxt_error_categories() -> None:
    authentication = map_o2_error(InvalidSession("expired"))
    funds = map_o2_error(OnChainRevert("reverted", reason="WithdrawError::NotEnoughBalance"))
    rate = map_o2_error(RateLimitExceeded("slow down"))
    invalid = map_o2_error(O2Error("Order value below min_order"))

    assert isinstance(authentication, ccxt.AuthenticationError)
    assert isinstance(authentication, ccxt.ExchangeError)
    assert authentication.original_error.__class__ is InvalidSession
    assert isinstance(funds, ccxt.InsufficientFunds)
    assert isinstance(rate, ccxt.RateLimitExceeded)
    assert isinstance(invalid, ccxt.InvalidOrder)


def test_private_network_failure_is_ambiguous() -> None:
    original = ConnectionError("socket closed")
    error = map_o2_error(original, "private_submission")

    assert isinstance(error, O2AmbiguousSubmission)
    assert isinstance(error, ccxt.OperationFailed)
    assert error.original_error is original
    assert error.transaction_id is None
