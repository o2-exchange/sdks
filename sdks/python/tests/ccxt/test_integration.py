"""Live O2 testnet verification for the asynchronous CCXT adapter.

Run with::

    O2_INTEGRATION=1 pytest tests/ccxt/test_integration.py -m integration -v --timeout=600
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar

import pytest

from o2_sdk import Id, Market, Network, O2Client, OrderSide, OrderType
from o2_sdk.ccxt import O2CCXT

pytestmark = [
    pytest.mark.integration,
    pytest.mark.timeout(180),
    pytest.mark.skipif(
        os.environ.get("O2_INTEGRATION") != "1",
        reason="set O2_INTEGRATION=1 to run live CCXT testnet actions",
    ),
]

PYTHON_WALLETS_FILE = Path(__file__).resolve().parents[2] / ".integration-wallets.json"
TYPESCRIPT_WALLETS_FILE = (
    Path(__file__).resolve().parents[3] / "typescript" / ".integration-wallets.json"
)
T = TypeVar("T")


def _private_key(role: str) -> str:
    wallets_file = next(
        (path for path in (PYTHON_WALLETS_FILE, TYPESCRIPT_WALLETS_FILE) if path.exists()), None
    )
    if wallets_file is None:
        pytest.skip("Missing Python or TypeScript .integration-wallets.json")
    wallets = json.loads(wallets_file.read_text())
    value = wallets.get(role) or wallets.get(f"{role}PrivateKey")
    if not isinstance(value, str) or not value:
        pytest.skip(f"No {role} wallet in {wallets_file}")
    return value


async def _wait_for(
    operation: Callable[[], Awaitable[T | None]], description: str, attempts: int = 30
) -> T:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            result = await operation()
            if result is not None:
                return result
        except Exception as error:
            last_error = error
        await asyncio.sleep(2)
    raise TimeoutError(f"Timed out waiting for {description}") from last_error


def _valid_order(market: Market, price: float, multiplier: float = 1.1) -> tuple[float, float]:
    price_step = 10**-market.quote.max_precision
    amount_step = 10**-market.base.max_precision
    rounded_price = max(price_step, math.floor(price / price_step) * price_step)
    minimum_cost = int(market.min_order) / 10**market.quote.decimals
    amount_steps = math.ceil((minimum_cost / rounded_price * multiplier) / amount_step)
    for _ in range(10):
        amount = amount_steps * amount_step
        scaled_price = market.scale_price(rounded_price)
        scaled_amount = market.adjust_quantity(scaled_price, market.scale_quantity(amount))
        try:
            market.validate_order(scaled_price, scaled_amount)
            return rounded_price, market.format_quantity(scaled_amount)
        except ValueError:
            amount_steps *= 2
    raise ValueError(f"Unable to construct a valid test order for {market.pair}")


async def _ensure_balance(client: O2Client, account_id: Id, symbol: str, minimum_raw: int) -> None:
    for _ in range(3):
        balances = await client.get_balances(account_id)
        available = int(balances[symbol].trading_account_balance) if symbol in balances else 0
        if available >= minimum_raw:
            return
        with contextlib.suppress(Exception):
            await client.api.mint_to_contract(account_id)
        await asyncio.sleep(5)
    balances = await client.get_balances(account_id)
    available = int(balances[symbol].trading_account_balance) if symbol in balances else 0
    if available < minimum_raw:
        raise ValueError(
            f"Testnet faucet did not fund {symbol}: {available} available, {minimum_raw} required"
        )


async def _account(client: O2Client, role: str) -> tuple[object, Id]:
    signer = client.load_wallet(_private_key(role))
    account = await client.api.get_account(owner=signer.b256_address)
    if account.trade_account_id is None:
        raise ValueError(f"The {role} integration wallet has no O2 testnet account")
    for attempt in range(2):
        try:
            await client.api.whitelist_account(account.trade_account_id)
            break
        except Exception:
            if attempt == 0:
                await asyncio.sleep(2)
    return signer, account.trade_account_id


async def test_limit_create_fetch_cancel_lifecycle() -> None:
    client = O2Client(network=Network.TESTNET)
    exchange: O2CCXT | None = None
    market: Market | None = None
    created_id: str | None = None
    try:
        signer, account_id = await _account(client, "maker")
        markets = await client.get_markets()
        if not markets:
            pytest.skip("O2 testnet returned no markets")
        market = markets[0]
        await client.create_session(signer, [market], 1)  # type: ignore[arg-type]
        exchange = O2CCXT({"client": client, "signer": signer, "tradeAccountId": str(account_id)})
        loaded = await exchange.load_markets()
        assert loaded[market.pair]["spot"] is True

        price, amount = _valid_order(market, 10**-market.quote.max_precision, 2)
        quote_raw = (
            market.scale_price(price) * market.scale_quantity(amount) // (10**market.base.decimals)
        )
        await _ensure_balance(client, account_id, market.quote.symbol, quote_raw)

        created = await exchange.create_order(
            market.pair,
            "limit",
            "buy",
            amount,
            price,
            {"orderType": "PostOnly"},
        )
        created_id = created["id"]
        assert created["status"] == "open"

        fetched = await _wait_for(
            lambda: exchange.fetch_order(created_id, market.pair),
            "the created order to reach the indexer",
        )
        assert fetched["id"] == created_id

        async def find_open() -> dict | None:
            orders = await exchange.fetch_open_orders(market.pair, limit=100)
            return next((order for order in orders if order["id"] == created_id), None)

        assert (await _wait_for(find_open, "the order to appear as open"))["status"] == "open"
        assert (await exchange.cancel_order(created_id, market.pair))["status"] == "canceled"

        async def find_closed() -> dict | None:
            orders = await exchange.fetch_closed_orders(market.pair, limit=100)
            return next((order for order in orders if order["id"] == created_id), None)

        assert (await _wait_for(find_closed, "the order to appear as closed"))["status"] in (
            "closed",
            "canceled",
        )
        created_id = None
    finally:
        if created_id and market:
            with contextlib.suppress(Exception):
                await client.cancel_order(created_id, market)
        if exchange:
            await exchange.close()
        else:
            await client.close()


async def test_bounded_fok_market_order_against_controlled_liquidity() -> None:
    maker_client = O2Client(network=Network.TESTNET)
    taker_client = O2Client(network=Network.TESTNET)
    taker_exchange: O2CCXT | None = None
    market: Market | None = None
    try:
        (maker_signer, maker_id), (taker_signer, taker_id) = await asyncio.gather(
            _account(maker_client, "maker"), _account(taker_client, "taker")
        )
        markets = await maker_client.get_markets()
        if not markets:
            pytest.skip("O2 testnet returned no markets")
        market = markets[0]
        await asyncio.gather(
            maker_client.create_session(maker_signer, [market], 1),  # type: ignore[arg-type]
            taker_client.create_session(taker_signer, [market], 1),  # type: ignore[arg-type]
        )
        taker_exchange = O2CCXT(
            {"client": taker_client, "signer": taker_signer, "tradeAccountId": str(taker_id)}
        )
        with contextlib.suppress(Exception):
            await maker_client.cancel_all_orders(market)
        with contextlib.suppress(Exception):
            await taker_client.cancel_all_orders(market)

        step = 10**-market.quote.max_precision
        amount_step = 10**-market.base.max_precision

        async def controlled_price() -> float | None:
            depth = await maker_client.get_depth(market, precision=1)
            best_ask = market.format_price(int(depth.asks[0].price)) if depth.asks else None
            best_bid = market.format_price(int(depth.bids[0].price)) if depth.bids else None
            if best_bid is not None:
                next_bid = round(best_bid + step, market.quote.max_precision)
                return next_bid if best_ask is None or next_bid < best_ask else None
            if best_ask is not None:
                return max(step, math.floor((best_ask * 0.8) / step) * step)
            return step

        price, amount = _valid_order(
            market,
            await _wait_for(
                controlled_price,
                "a testnet spread wide enough for controlled post-only liquidity",
            ),
        )
        quote_raw = (
            market.scale_price(price) * market.scale_quantity(amount) // (10**market.base.decimals)
        )
        await asyncio.gather(
            _ensure_balance(maker_client, maker_id, market.quote.symbol, quote_raw),
            _ensure_balance(
                taker_client, taker_id, market.base.symbol, market.scale_quantity(amount)
            ),
        )

        maker = await maker_client.create_order(
            market, OrderSide.BUY, price, amount, OrderType.POST_ONLY
        )
        assert maker.orders and maker.orders[-1].order_id

        async def maker_is_active() -> bool | None:
            depth = await maker_client.get_depth(market, precision=1)
            for level in depth.bids:
                level_price = market.format_price(int(level.price))
                level_amount = market.format_quantity(int(level.quantity))
                if abs(level_price - price) < step / 2 and level_amount >= amount:
                    return True
            return None

        await _wait_for(maker_is_active, "the controlled maker order to become active in depth")

        result = await taker_exchange.create_order(
            market.pair,
            "market",
            "sell",
            amount,
            None,
            {"maxPrice": price + step, "minPrice": price},
        )
        assert result["type"] == "market"
        assert result["side"] == "sell"
        assert result["amount"] == amount

        async def taker_closed() -> dict | None:
            order = await taker_exchange.fetch_order(result["id"], market.pair)
            return (
                order
                if order["status"] == "closed" and order["filled"] >= amount - amount_step / 2
                else None
            )

        indexed = await _wait_for(taker_closed, "the bounded FOK order to close")
        assert indexed["filled"] >= amount - amount_step / 2
    finally:
        if market:
            with contextlib.suppress(Exception):
                await maker_client.cancel_all_orders(market)
            with contextlib.suppress(Exception):
                await taker_client.cancel_all_orders(market)
            with contextlib.suppress(Exception):
                await maker_client.settle_balance(market)
            with contextlib.suppress(Exception):
                await taker_client.settle_balance(market)
        await maker_client.close()
        if taker_exchange:
            await taker_exchange.close()
        else:
            await taker_client.close()
