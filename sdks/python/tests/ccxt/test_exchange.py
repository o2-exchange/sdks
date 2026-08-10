from __future__ import annotations

import json
import subprocess
import sys
from unittest.mock import AsyncMock

import ccxt.async_support as ccxt
import pytest

from o2_sdk import (
    ActionsResponse,
    Balance,
    BoundedMarketOrder,
    DepthLevel,
    DepthSnapshot,
    Id,
    Market,
    MarketAsset,
    O2Client,
    Order,
    OrderSide,
    OrderType,
    WithdrawResponse,
)
from o2_sdk.ccxt import O2CCXT, ArgumentsRequired, BadRequest, O2AmbiguousSubmission

ACCOUNT_ID = Id("0x" + "11" * 32)
MARKET = Market(
    contract_id=Id("0x" + "22" * 32),
    market_id=Id("0x" + "33" * 32),
    maker_fee="0",
    taker_fee="10",
    min_order="1000000",
    dust="0",
    price_window=0,
    base=MarketAsset("FUEL", "0x" + "44" * 32, 9, 4),
    quote=MarketAsset("USDC", "0x" + "55" * 32, 6, 3),
)
RAW_ORDER = Order(
    order_id=Id("0x" + "66" * 32),
    side="buy",
    order_type="PostOnly",
    quantity="2000000000",
    quantity_fill="500000000",
    price="1500000",
    price_fill="1400000",
    timestamp="1700000000",
    close=False,
    partially_filled=True,
    cancel=False,
    market_id=MARKET.market_id,
)


def setup_exchange() -> tuple[O2Client, O2CCXT]:
    client = O2Client()
    client.get_markets = AsyncMock(return_value=[MARKET])  # type: ignore[method-assign]
    return client, O2CCXT({"client": client, "tradeAccountId": str(ACCOUNT_ID)})


async def test_is_official_async_exchange_and_loads_markets() -> None:
    client, exchange = setup_exchange()
    try:
        assert isinstance(exchange, ccxt.Exchange)
        assert exchange.id == "o2"
        assert exchange.has["createMarketOrder"] is True
        assert exchange.has["withdraw"] is True
        assert exchange.precisionMode == ccxt.DECIMAL_PLACES
        markets = await exchange.load_markets()
        assert markets["FUEL/USDC"]["limits"]["cost"]["min"] == 1
        assert exchange.amount_to_precision("FUEL/USDC", 1.23456) == "1.2345"
        assert exchange.price_to_precision("FUEL/USDC", 1.23456) == "1.235"
        await exchange.load_markets()
        client.get_markets.assert_awaited_once()  # type: ignore[attr-defined]
    finally:
        await exchange.close()


async def test_market_data_and_balance_mapping() -> None:
    client, exchange = setup_exchange()
    client.get_depth = AsyncMock(  # type: ignore[method-assign]
        return_value=DepthSnapshot(
            bids=[DepthLevel(price=1_500_000, quantity=2_000_000_000)],
            asks=[DepthLevel(price=1_600_000, quantity=3_000_000_000)],
        )
    )
    client.get_balances = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "USDC": Balance({}, "2000000", "8000000", "5000000"),
        }
    )
    try:
        book = await exchange.fetch_order_book("FUEL/USDC", 10, {"precision": 2})
        balance = await exchange.fetch_balance()
        assert book["bids"] == [[1.5, 2.0]]
        assert balance["USDC"] == {"free": 8.0, "used": 2.0, "total": 10.0}
        client.get_depth.assert_awaited_once_with(MARKET, 2, 10)  # type: ignore[attr-defined]
        with pytest.raises(BadRequest):
            await exchange.fetch_order_book("FUEL/USDC", params={"precision": 19})
    finally:
        await exchange.close()


async def test_limit_and_bounded_market_orders() -> None:
    client, exchange = setup_exchange()
    client.create_order = AsyncMock(  # type: ignore[method-assign]
        return_value=ActionsResponse(Id("0x" + "77" * 32), [RAW_ORDER])
    )
    try:
        order = await exchange.create_order(
            "FUEL/USDC",
            "limit",
            "buy",
            2,
            1.5,
            {"orderType": "PostOnly", "settleFirst": False},
        )
        assert order["type"] == "limit"
        assert order["timeInForce"] == "PO"
        client.create_order.assert_awaited_once_with(  # type: ignore[attr-defined]
            MARKET,
            OrderSide.BUY,
            "1.5",
            "2",
            order_type=OrderType.POST_ONLY,
            settle_first=False,
            collect_orders=True,
        )

        market_order = Order(**{**RAW_ORDER.__dict__, "order_type": {"BoundedMarket": {}}})
        client.create_order.reset_mock()  # type: ignore[attr-defined]
        client.create_order.return_value = ActionsResponse(  # type: ignore[attr-defined]
            Id("0x" + "77" * 32), [market_order]
        )
        result = await exchange.create_market_order(
            "FUEL/USDC",
            "sell",
            2,
            None,
            {"maxPrice": 1.6, "minPrice": 1.4},
        )
        assert result["type"] == "market"
        native_type = client.create_order.await_args.kwargs["order_type"]  # type: ignore[attr-defined]
        assert native_type == BoundedMarketOrder(max_price="1.6", min_price="1.4")
        with pytest.raises(ArgumentsRequired):
            await exchange.create_order("FUEL/USDC", "market", "buy", 2, params={"maxPrice": 1.6})
    finally:
        await exchange.close()


async def test_submission_fault_is_not_retried() -> None:
    client, exchange = setup_exchange()
    client.create_order = AsyncMock(side_effect=ConnectionError("socket closed"))  # type: ignore[method-assign]
    try:
        with pytest.raises(O2AmbiguousSubmission):
            await exchange.create_order("FUEL/USDC", "limit", "buy", 2, 1.5)
        client.create_order.assert_awaited_once()  # type: ignore[attr-defined]
    finally:
        await exchange.close()


async def test_mined_revert_is_definitive_not_ambiguous() -> None:
    client, exchange = setup_exchange()
    client.create_order = AsyncMock(  # type: ignore[method-assign]
        return_value=ActionsResponse(
            tx_id=Id("0x" + "88" * 32),
            orders=None,
            message="transaction reverted",
            reason="OrderCreationError::NotEnoughBalance",
            receipts=[],
        )
    )
    try:
        with pytest.raises(ccxt.InsufficientFunds):
            await exchange.create_order("FUEL/USDC", "limit", "buy", 2, 1.5)
        client.create_order.assert_awaited_once()  # type: ignore[attr-defined]
    finally:
        await exchange.close()


async def test_withdrawal_result_is_json_serializable() -> None:
    client = O2Client()
    signer = client.generate_wallet()
    transaction_id = Id("0x" + "99" * 32)
    client.withdraw = AsyncMock(  # type: ignore[method-assign]
        return_value=WithdrawResponse(tx_id=transaction_id)
    )
    exchange = O2CCXT({"client": client, "signer": signer})
    try:
        transaction = await exchange.withdraw("USDC", 10, signer.b256_address)
        assert transaction["txid"] == transaction_id
        assert json.loads(json.dumps(transaction))["info"]["tx_id"] == transaction_id
    finally:
        await exchange.close()


def test_core_import_does_not_load_ccxt() -> None:
    script = """
import importlib.abc
import sys
class BlockCCXT(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname == 'ccxt' or fullname.startswith('ccxt.'):
            raise ModuleNotFoundError('blocked ccxt')
        return None
sys.meta_path.insert(0, BlockCCXT())
import o2_sdk
assert not any(name == 'ccxt' or name.startswith('ccxt.') for name in sys.modules)
"""
    subprocess.run([sys.executable, "-c", script], check=True)
