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
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import TypeVar

import pytest

from o2_sdk import (
    Id,
    Market,
    MarketActionGroup,
    Network,
    O2Client,
    OrderSide,
    OrderType,
    SettleBalanceRequestAction,
)
from o2_sdk.ccxt import (
    O2CCXT,
    AuthenticationError,
    BadSymbol,
    ExchangeError,
    InsufficientFunds,
    InvalidOrder,
    OrderNotFound,
)

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


def _public_markets(markets: list[Market]) -> list[Market]:
    return [
        market for market in markets if market.base.symbol.strip() and market.quote.symbol.strip()
    ]


async def _post_only_price(client: O2Client, market: Market, side: str) -> float:
    depth = await client.get_depth(market, precision=1)
    step = 10**-market.quote.max_precision
    best_bid = market.format_price(int(depth.bids[0].price)) if depth.bids else None
    best_ask = market.format_price(int(depth.asks[0].price)) if depth.asks else None
    if side == "buy":
        return step
    reference = max(best_ask or 0, best_bid or 0, step * 1_000)
    return round(reference * 2 + step, market.quote.max_precision)


async def _controlled_maker_price(client: O2Client, market: Market, side: str) -> float:
    async def select() -> float | None:
        depth = await client.get_depth(market, precision=1)
        step = 10**-market.quote.max_precision
        best_bid = market.format_price(int(depth.bids[0].price)) if depth.bids else None
        best_ask = market.format_price(int(depth.asks[0].price)) if depth.asks else None
        if side == "buy":
            if best_bid is not None:
                inside = round(best_bid + step, market.quote.max_precision)
                return inside if best_ask is None or inside < best_ask else best_bid
            if best_ask is not None:
                return max(step, math.floor((best_ask * 0.8) / step) * step)
            return 1.0
        if best_ask is not None:
            inside = round(best_ask - step, market.quote.max_precision)
            return inside if best_bid is None or inside > best_bid else best_ask
        if best_bid is not None:
            return round(best_bid * 1.2 + step, market.quote.max_precision)
        return 1.0

    return await _wait_for(select, f"a testnet price for controlled {side} liquidity")


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


@pytest.mark.timeout(240)
async def test_all_supported_read_methods_across_testnet_markets() -> None:
    client = O2Client(network=Network.TESTNET)
    exchange: O2CCXT | None = None
    try:
        signer, account_id = await _account(client, "maker")
        native_markets = _public_markets(await client.get_markets())
        if not native_markets:
            pytest.skip("O2 testnet returned no public markets")
        await client.create_session(signer, native_markets, 1)  # type: ignore[arg-type]
        exchange = O2CCXT({"client": client, "signer": signer, "tradeAccountId": str(account_id)})

        fetched_markets = await exchange.fetch_markets()
        loaded_markets = await exchange.load_markets(True)
        assert len(fetched_markets) == len(native_markets)
        assert len(loaded_markets) == len(native_markets)

        for market in fetched_markets:
            symbol = market["symbol"]
            assert market["spot"] is True
            assert market["active"] is True

            ticker = await exchange.fetch_ticker(symbol)
            assert ticker["symbol"] == symbol
            assert ticker["timestamp"] is None or math.isfinite(ticker["timestamp"])

            book = await exchange.fetch_order_book(symbol, 20, {"precision": 1})
            l2_book = await exchange.fetch_l2_order_book(symbol, 20, {"precision": 1})
            assert book["symbol"] == symbol
            assert book["bids"] == sorted(book["bids"], key=lambda level: level[0], reverse=True)
            assert book["asks"] == sorted(book["asks"], key=lambda level: level[0])
            assert l2_book["symbol"] == symbol
            assert l2_book["bids"] == sorted(
                l2_book["bids"], key=lambda level: level[0], reverse=True
            )
            assert l2_book["asks"] == sorted(l2_book["asks"], key=lambda level: level[0])

            trades = await exchange.fetch_trades(symbol, limit=10)
            assert len(trades) <= 10
            assert all(trade["symbol"] == symbol for trade in trades)
            assert [trade["timestamp"] for trade in trades] == sorted(
                trade["timestamp"] for trade in trades
            )

            for timeframe in exchange.timeframes:
                candles = await exchange.fetch_ohlcv(symbol, timeframe, limit=2)
                assert len(candles) <= 2
                assert all(len(candle) == 6 for candle in candles)
                assert [candle[0] for candle in candles] == sorted(candle[0] for candle in candles)

        balance = await exchange.fetch_balance()
        assert balance["info"] is not None
        for code, total in balance["total"].items():
            assert total == pytest.approx(balance["free"][code] + balance["used"][code])

        orders, open_orders, closed_orders, account_trades = await asyncio.gather(
            exchange.fetch_orders(limit=20),
            exchange.fetch_open_orders(limit=20),
            exchange.fetch_closed_orders(limit=20),
            exchange.fetch_my_trades(limit=20),
        )
        assert len(orders) <= 20
        assert all(order["status"] == "open" for order in open_orders)
        assert all(order["status"] != "open" for order in closed_orders)
        assert len(account_trades) <= 20
        assert [trade["timestamp"] for trade in account_trades] == sorted(
            trade["timestamp"] for trade in account_trades
        )

        with pytest.raises(BadSymbol):
            await exchange.fetch_ticker("NOT/A-MARKET")
    finally:
        if exchange:
            await exchange.close()
        else:
            await client.close()


async def test_limit_create_fetch_cancel_lifecycle() -> None:
    client = O2Client(network=Network.TESTNET)
    exchange: O2CCXT | None = None
    market: Market | None = None
    created_ids: set[str] = set()
    try:
        signer, account_id = await _account(client, "maker")
        markets = _public_markets(await client.get_markets())
        if not markets:
            pytest.skip("O2 testnet returned no public markets")
        market = markets[0]
        await client.create_session(signer, [market], 1)  # type: ignore[arg-type]
        exchange = O2CCXT({"client": client, "signer": signer, "tradeAccountId": str(account_id)})
        loaded = await exchange.load_markets()
        assert loaded[market.pair]["spot"] is True

        for order_type in ("PostOnly", "Spot"):
            for side in ("buy", "sell"):
                price, amount = _valid_order(
                    market, await _post_only_price(client, market, side), 2
                )
                required_raw = (
                    market.scale_price(price)
                    * market.scale_quantity(amount)
                    // (10**market.base.decimals)
                    if side == "buy"
                    else market.scale_quantity(amount)
                )
                await _ensure_balance(
                    client,
                    account_id,
                    market.quote.symbol if side == "buy" else market.base.symbol,
                    required_raw,
                )

                created = await exchange.create_order(
                    market.pair,
                    "limit",
                    side,
                    amount,
                    price,
                    {"orderType": order_type},
                )
                created_id = created["id"]
                created_ids.add(created_id)
                assert created["status"] == "open"
                assert created["side"] == side

                fetched = await _wait_for(
                    lambda created_id=created_id: exchange.fetch_order(created_id, market.pair),
                    f"the {order_type} {side} order to reach the indexer",
                )
                assert fetched["id"] == created_id

                async def find_open(created_id: str = created_id) -> dict | None:
                    orders = await exchange.fetch_open_orders(market.pair, limit=100)
                    return next((order for order in orders if order["id"] == created_id), None)

                assert (
                    await _wait_for(find_open, f"the {order_type} {side} order to appear as open")
                )["status"] == "open"
                assert (await exchange.cancel_order(created_id, market.pair))[
                    "status"
                ] == "canceled"

                async def find_closed(created_id: str = created_id) -> dict | None:
                    orders = await exchange.fetch_closed_orders(market.pair, limit=100)
                    return next((order for order in orders if order["id"] == created_id), None)

                assert (
                    await _wait_for(
                        find_closed, f"the canceled {order_type} {side} order to appear as closed"
                    )
                )["status"] in ("closed", "canceled")
                created_ids.remove(created_id)
    finally:
        if market:
            for created_id in created_ids:
                with contextlib.suppress(Exception):
                    await client.cancel_order(created_id, market)
        if exchange:
            await exchange.close()
        else:
            await client.close()


async def test_bounded_market_and_explicit_fok_limits_on_both_sides() -> None:
    maker_client = O2Client(network=Network.TESTNET)
    taker_client = O2Client(network=Network.TESTNET)
    taker_exchange: O2CCXT | None = None
    market: Market | None = None
    try:
        (maker_signer, maker_id), (taker_signer, taker_id) = await asyncio.gather(
            _account(maker_client, "maker"), _account(taker_client, "taker")
        )
        markets = _public_markets(await maker_client.get_markets())
        if not markets:
            pytest.skip("O2 testnet returned no public markets")
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

        for execution_type in ("market", "limit"):
            for taker_side in ("buy", "sell"):
                maker_side = "sell" if taker_side == "buy" else "buy"
                price, amount = _valid_order(
                    market,
                    await _controlled_maker_price(maker_client, market, maker_side),
                )
                quote_raw = (
                    market.scale_price(price)
                    * market.scale_quantity(amount)
                    // (10**market.base.decimals)
                )
                base_raw = market.scale_quantity(amount)
                await asyncio.gather(
                    _ensure_balance(
                        maker_client,
                        maker_id,
                        market.quote.symbol if maker_side == "buy" else market.base.symbol,
                        quote_raw if maker_side == "buy" else base_raw,
                    ),
                    _ensure_balance(
                        taker_client,
                        taker_id,
                        market.quote.symbol if taker_side == "buy" else market.base.symbol,
                        quote_raw if taker_side == "buy" else base_raw,
                    ),
                )

                maker = await maker_client.create_order(
                    market,
                    OrderSide.BUY if maker_side == "buy" else OrderSide.SELL,
                    price,
                    amount,
                    OrderType.POST_ONLY,
                )
                assert maker.orders and maker.orders[-1].order_id

                async def maker_is_active(
                    maker_side: str = maker_side,
                    price: float = price,
                    amount: float = amount,
                ) -> bool | None:
                    depth = await maker_client.get_depth(market, precision=1)
                    levels = depth.bids if maker_side == "buy" else depth.asks
                    for level in levels:
                        level_price = market.format_price(int(level.price))
                        level_amount = market.format_quantity(int(level.quantity))
                        if abs(level_price - price) < step / 2 and level_amount >= amount:
                            return True
                    return None

                await _wait_for(
                    maker_is_active,
                    f"the controlled {maker_side} maker order to become active in depth",
                )

                protective_price = price + step if taker_side == "buy" else max(step, price - step)
                result = await taker_exchange.create_order(
                    market.pair,
                    execution_type,
                    taker_side,
                    amount,
                    protective_price if execution_type == "limit" else None,
                    (
                        {"maxPrice": price + step, "minPrice": max(step, price - step)}
                        if execution_type == "market"
                        else {"orderType": "FillOrKill"}
                    ),
                )
                assert result["type"] == execution_type
                assert result["side"] == taker_side
                assert result["amount"] == amount

                async def taker_closed(
                    result_id: str = result["id"], amount: float = amount
                ) -> dict | None:
                    order = await taker_exchange.fetch_order(result_id, market.pair)
                    return (
                        order
                        if order["status"] == "closed"
                        and order["filled"] >= amount - amount_step / 2
                        else None
                    )

                indexed = await _wait_for(
                    taker_closed, f"the {execution_type} FOK {taker_side} to close"
                )
                assert indexed["filled"] >= amount - amount_step / 2
                await asyncio.gather(
                    maker_client.settle_balance(market),
                    taker_client.settle_balance(market),
                    return_exceptions=True,
                )
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


async def test_definitive_testnet_order_rejections_are_not_retried() -> None:
    maker_client = O2Client(network=Network.TESTNET)
    taker_client = O2Client(network=Network.TESTNET)
    exchange: O2CCXT | None = None
    market: Market | None = None
    maker_order_id: Id | None = None
    try:
        (maker_signer, maker_id), (taker_signer, taker_id) = await asyncio.gather(
            _account(maker_client, "maker"), _account(taker_client, "taker")
        )
        markets = _public_markets(await taker_client.get_markets())
        if not markets:
            pytest.skip("O2 testnet returned no public markets")
        market = markets[0]
        await asyncio.gather(
            maker_client.create_session(maker_signer, [market], 1),  # type: ignore[arg-type]
            taker_client.create_session(taker_signer, [market], 1),  # type: ignore[arg-type]
        )
        exchange = O2CCXT(
            {"client": taker_client, "signer": taker_signer, "tradeAccountId": str(taker_id)}
        )
        await exchange.load_markets()

        crossing_price, crossing_amount = _valid_order(
            market, await _controlled_maker_price(maker_client, market, "buy")
        )
        crossing_quote = (
            market.scale_price(crossing_price)
            * market.scale_quantity(crossing_amount)
            // (10**market.base.decimals)
        )
        await asyncio.gather(
            _ensure_balance(maker_client, maker_id, market.quote.symbol, crossing_quote),
            _ensure_balance(
                taker_client,
                taker_id,
                market.base.symbol,
                market.scale_quantity(crossing_amount),
            ),
        )
        maker = await maker_client.create_order(
            market,
            OrderSide.BUY,
            crossing_price,
            crossing_amount,
            OrderType.POST_ONLY,
        )
        assert maker.orders and maker.orders[-1].order_id
        maker_order_id = maker.orders[-1].order_id

        async def maker_is_active() -> bool | None:
            depth = await maker_client.get_depth(market, precision=1)
            step = 10**-market.quote.max_precision
            return (
                True
                if any(
                    abs(market.format_price(int(level.price)) - crossing_price) < step / 2
                    and market.format_quantity(int(level.quantity)) >= crossing_amount
                    for level in depth.bids
                )
                else None
            )

        await _wait_for(maker_is_active, "the maker order for a crossing post-only rejection")
        with pytest.raises(InvalidOrder):
            await exchange.create_order(
                market.pair,
                "limit",
                "sell",
                crossing_amount,
                crossing_price,
                {"orderType": "PostOnly", "settleFirst": False},
            )
        await maker_client.cancel_order(maker_order_id, market)
        maker_order_id = None

        depth = await taker_client.get_depth(market, precision=1)
        step = 10**-market.quote.max_precision
        best_bid = market.format_price(int(depth.bids[0].price)) if depth.bids else 0
        no_liquidity_price = round(
            best_bid + max(step, best_bid or step), market.quote.max_precision
        )
        _, amount = _valid_order(market, no_liquidity_price)
        await _ensure_balance(
            taker_client,
            taker_id,
            market.base.symbol,
            math.ceil(amount * 1.1 * 10**market.base.decimals),
        )

        with pytest.raises(InvalidOrder):
            await exchange.create_order(
                market.pair,
                "market",
                "sell",
                amount,
                None,
                {
                    "maxPrice": no_liquidity_price + step,
                    "minPrice": no_liquidity_price,
                    "settleFirst": False,
                },
            )

        balances = await taker_client.get_balances(taker_id)
        available_base = int(balances[market.base.symbol].trading_account_balance)
        amount_step = 10**-market.base.max_precision
        unavailable_amount = (
            math.ceil((available_base / 10**market.base.decimals + amount_step * 10) / amount_step)
            * amount_step
        )
        with pytest.raises(InsufficientFunds):
            await exchange.create_order(
                market.pair,
                "limit",
                "sell",
                unavailable_amount,
                no_liquidity_price,
                {"orderType": "PostOnly", "settleFirst": False},
            )

        with pytest.raises(OrderNotFound):
            await exchange.fetch_order("0x" + "ff" * 32, market.pair)
    finally:
        if maker_order_id and market:
            with contextlib.suppress(Exception):
                await maker_client.cancel_order(maker_order_id, market)
        await maker_client.close()
        if exchange:
            await exchange.close()
        else:
            await taker_client.close()


async def test_adapter_owned_account_session_restore_settle_and_batch() -> None:
    client = O2Client(network=Network.TESTNET)
    signer = client.load_wallet(_private_key("maker"))
    exchange: O2CCXT | None = O2CCXT({"client": client, "signer": signer})
    restored_exchange: O2CCXT | None = None
    try:
        setup = await exchange.setup_account()
        assert setup.trade_account_id is not None

        markets = await exchange.fetch_markets()
        if not markets:
            pytest.skip("O2 testnet returned no public CCXT markets")
        market = markets[0]
        with contextlib.suppress(Exception):
            await client.api.whitelist_account(setup.trade_account_id)

        session = await exchange.create_session([market["symbol"]], 1)
        assert session.trade_account_id == setup.trade_account_id
        assert client.session is session
        assert (await exchange.fetch_balance())["total"] is not None
        assert (await exchange.settle_balance(market["symbol"])).success is True
        batch = await exchange.batch_actions(
            [MarketActionGroup(market=market["symbol"], actions=[SettleBalanceRequestAction()])]
        )
        assert batch.success is True

        await exchange.close()
        exchange = None

        restored_client = O2Client(network=Network.TESTNET)
        restored_exchange = O2CCXT({"client": restored_client, "signer": signer})
        restored_exchange.restore_session(session)
        assert restored_client.session is session
        assert (await restored_exchange.fetch_balance())["total"] is not None
        assert (await restored_exchange.settle_balance(market["symbol"])).success is True

        if len(markets) > 1:
            with pytest.raises(ExchangeError):
                await restored_exchange.settle_balance(markets[1]["symbol"])

        restored_exchange.restore_session(
            replace(session, session_expiry=str(int(time.time()) - 1))
        )
        with pytest.raises(AuthenticationError):
            await restored_exchange.settle_balance(market["symbol"])
    finally:
        if exchange:
            await exchange.close()
        if restored_exchange:
            await restored_exchange.close()
