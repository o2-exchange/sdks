"""Cross-language parser contract tests using the shared CCXT fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from o2_sdk.ccxt.parsers import (
    parse_balance,
    parse_market,
    parse_ohlcv,
    parse_order,
    parse_order_book,
    parse_ticker,
    parse_trade,
)
from o2_sdk.models import Balance, Bar, DepthLevel, DepthSnapshot, Market, Order, Trade

FIXTURES = Path(__file__).resolve().parents[4] / "fixtures" / "ccxt"


def fixture(path: str) -> Any:
    return json.loads((FIXTURES / path).read_text())


def projection(actual: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    return {key: actual[key] for key in expected}


def test_normalizes_market_metadata() -> None:
    market = Market.from_dict(fixture("raw/markets.json")[0])
    actual = parse_market(market)
    expected = fixture("expected/markets.json")[0]
    projected = projection(
        actual, {key: value for key, value in expected.items() if key != "minimumCost"}
    )
    projected["minimumCost"] = actual["limits"]["cost"]["min"]
    assert projected == expected


def test_normalizes_public_and_account_trades() -> None:
    market = Market.from_dict(fixture("raw/markets.json")[0])
    ccxt_market = parse_market(market)
    trades = [Trade.from_dict(value) for value in fixture("raw/trades.json")]
    expected = fixture("expected/trades.json")
    actual = [
        parse_trade(trade, ccxt_market, account_relative=index > 0)
        for index, trade in enumerate(trades)
    ]
    assert [projection(value, expected[index]) for index, value in enumerate(actual)] == expected
    assert actual[3]["info"]["trader_side"] == "both"
    json.dumps(actual)


def test_normalizes_public_and_private_objects() -> None:
    market = Market.from_dict(fixture("raw/markets.json")[0])
    ccxt_market = parse_market(market)

    raw_book = fixture("raw/orderbook.json")
    book = parse_order_book(
        DepthSnapshot(
            bids=[DepthLevel.from_dict(level) for level in raw_book["bids"]],
            asks=[DepthLevel.from_dict(level) for level in raw_book["asks"]],
        ),
        ccxt_market,
    )
    assert book == fixture("expected/orderbook.json")

    expected_ticker = fixture("expected/ticker.json")
    ticker = parse_ticker(fixture("raw/ticker.json"), ccxt_market, 1_700_000_000_000)
    assert projection(ticker, expected_ticker) == expected_ticker

    bars = [parse_ohlcv(Bar.from_dict(value)) for value in fixture("raw/ohlcv.json")]
    assert bars == fixture("expected/ohlcv.json")

    balances = {
        symbol: Balance.from_dict(value) for symbol, value in fixture("raw/balances.json").items()
    }
    parsed_balance = parse_balance(balances, {"USDC": 6})
    assert parsed_balance["USDC"] == fixture("expected/balances.json")["USDC"]

    expected_orders = fixture("expected/orders.json")
    orders = [Order.from_dict(value) for value in fixture("raw/orders.json")]
    actual_orders = [parse_order(order, ccxt_market) for order in orders]
    assert [
        projection(value, expected_orders[index]) for index, value in enumerate(actual_orders)
    ] == expected_orders
    json.dumps(
        {
            "market": ccxt_market,
            "book": book,
            "ticker": ticker,
            "balances": parsed_balance,
            "orders": actual_orders,
        }
    )
