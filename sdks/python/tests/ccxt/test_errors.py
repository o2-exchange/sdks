from __future__ import annotations

import asyncio
import json
from pathlib import Path

import aiohttp
import ccxt
import pytest

from o2_sdk.ccxt import O2AmbiguousSubmission, map_o2_error
from o2_sdk.errors import InvalidSession, O2Error, OnChainRevert, RateLimitExceeded

FIXTURES = Path(__file__).resolve().parents[4] / "fixtures" / "ccxt"


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


def test_matches_shared_cross_language_error_contract() -> None:
    cases = json.loads((FIXTURES / "raw/errors.json").read_text())
    expected = json.loads((FIXTURES / "expected/errors.json").read_text())

    actual = {}
    for entry in cases:
        native = (
            O2Error(entry["message"])
            if entry["kind"] == "o2"
            else ConnectionError(entry["message"])
        )
        context = "private_submission" if entry["context"] == "private" else "read"
        actual[entry["id"]] = type(map_o2_error(native, context)).__name__

    assert actual == expected


def test_maps_direct_order_and_balance_rejections() -> None:
    no_fill = map_o2_error(
        O2Error("OrderCreationError::OrderNotFilled — FillOrKill order could not be fully filled."),
        "private_submission",
    )
    crossing = map_o2_error(
        O2Error(
            "OrderCreationError::OrderPartiallyFilled — PostOnly order would cross the spread."
        ),
        "private_submission",
    )
    funds = map_o2_error(O2Error("NotEnoughBalance"), "private_submission")

    assert isinstance(no_fill, ccxt.InvalidOrder)
    assert isinstance(crossing, ccxt.InvalidOrder)
    assert isinstance(funds, ccxt.InsufficientFunds)


def test_private_network_failure_is_ambiguous() -> None:
    original = ConnectionError("socket closed")
    error = map_o2_error(original, "private_submission")

    assert isinstance(error, O2AmbiguousSubmission)
    assert isinstance(error, ccxt.OperationFailed)
    assert error.original_error is original
    assert error.transaction_id is None


@pytest.mark.parametrize(
    ("message", "cause"),
    [
        ("response lost", None),
        ("Cannot connect to host api.testnet.o2.app", None),
        ("O2 request failed", aiohttp.ClientConnectionError("disconnected")),
        ("O2 request failed", asyncio.TimeoutError()),
    ],
)
def test_wrapped_transport_failures_remain_ambiguous(
    message: str, cause: BaseException | None
) -> None:
    wrapped = O2Error(message)
    wrapped.__cause__ = cause

    error = map_o2_error(wrapped, "private_submission")

    assert isinstance(error, O2AmbiguousSubmission)
    assert error.original_error is wrapped


def test_wrapped_transport_failure_on_read_is_network_error() -> None:
    wrapped = O2Error("request failed")
    wrapped.__cause__ = aiohttp.ClientConnectionError("response lost")

    error = map_o2_error(wrapped, "read")

    assert isinstance(error, ccxt.NetworkError)
    assert error.original_error is wrapped
