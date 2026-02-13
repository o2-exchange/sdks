"""Integration tests against testnet.

Run with: pytest tests/test_integration.py -m integration
These tests require network access and hit the live testnet API.
"""

import asyncio
import contextlib
import math

import pytest

from o2_sdk import (
    BalanceUpdate,
    Network,
    NonceUpdate,
    O2Client,
    OrderSide,
    OrderType,
    OrderUpdate,
    TradeUpdate,
)
from o2_sdk.api import O2Api
from o2_sdk.config import get_config

pytestmark = pytest.mark.integration


async def _mint_with_retry(api, trade_account_id, max_retries=4):
    """Attempt faucet mint with retry on cooldown."""
    for attempt in range(max_retries):
        try:
            await api.mint_to_contract(trade_account_id)
            return
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)


async def _whitelist_with_retry(api, trade_account_id, max_retries=4):
    """Ensure account is whitelisted with retry on rate limit."""
    for attempt in range(max_retries):
        try:
            await api.whitelist_account(trade_account_id)
            # Allow time for on-chain whitelist propagation
            await asyncio.sleep(10)
            return
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)


async def _create_order_with_whitelist_retry(client, max_retries=5, **kwargs):
    """Place an order, re-whitelisting on TraderNotWhiteListed errors."""
    session = kwargs.get("session")
    for attempt in range(max_retries):
        try:
            return await client.create_order(**kwargs)
        except Exception as e:
            err_text = str(e) + (getattr(e, "reason", None) or "")
            if "TraderNotWhiteListed" in err_text and attempt < max_retries - 1:
                # Re-whitelist and retry with increasing backoff
                trade_account_id = session.trade_account_id if session else None
                if trade_account_id:
                    await _whitelist_with_retry(client.api, trade_account_id, max_retries=2)
                    # Additional backoff on top of whitelist propagation delay
                    await asyncio.sleep(5 * (attempt + 1))
                continue
            raise


async def _setup_funded_account(client, max_retries=4):
    """Create, whitelist, and mint to a single account with rate-limit retries."""
    wallet = client.generate_wallet()
    for attempt in range(max_retries):
        try:
            account = await client.setup_account(wallet)
            break
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)
            else:
                raise
    # Explicitly whitelist with retry (setup_account catches failures silently)
    await _whitelist_with_retry(client.api, account.trade_account_id)
    await _mint_with_retry(client.api, account.trade_account_id)
    return wallet, account


@pytest.fixture(scope="module")
async def funded_accounts():
    """Two funded accounts (maker + taker) for cross-account tests."""
    client = O2Client(network=Network.TESTNET)

    maker_wallet, maker_account = await _setup_funded_account(client)
    taker_wallet, taker_account = await _setup_funded_account(client)

    yield {
        "client": client,
        "maker": (maker_wallet, maker_account),
        "taker": (taker_wallet, taker_account),
    }
    await client.close()


@pytest.fixture(scope="module")
async def funded_account(funded_accounts):
    """Backward-compatible fixture delegating to maker from funded_accounts."""
    ctx = funded_accounts
    wallet, account = ctx["maker"]
    yield ctx["client"], wallet, account


@pytest.fixture
def config():
    return get_config(Network.TESTNET)


@pytest.fixture
def api(config):
    return O2Api(config)


@pytest.fixture
def client():
    return O2Client(network=Network.TESTNET)


class TestMarketData:
    async def test_get_markets(self, api):
        resp = await api.get_markets()
        assert len(resp.markets) > 0
        assert resp.chain_id is not None
        assert resp.accounts_registry_id != ""

        market = resp.markets[0]
        assert market.contract_id.startswith("0x")
        assert market.market_id.startswith("0x")
        assert market.base.decimals > 0
        assert market.quote.decimals > 0
        await api.close()

    async def test_get_depth(self, api):
        resp = await api.get_markets()
        market = resp.markets[0]
        depth = await api.get_depth(market.market_id)
        assert isinstance(depth.buys, list)
        assert isinstance(depth.sells, list)
        await api.close()

    async def test_get_trades(self, api):
        resp = await api.get_markets()
        market = resp.markets[0]
        trades = await api.get_trades(market.market_id, count=10)
        assert isinstance(trades, list)
        await api.close()

    async def test_get_market_by_pair(self, client):
        markets = await client.get_markets()
        assert len(markets) > 0
        first = markets[0]
        pair = first.pair

        resolved = await client.get_market(pair)
        assert resolved.market_id == first.market_id
        await client.close()


class TestAccountFlow:
    async def test_account_creation_and_lookup(self, client):
        wallet = client.generate_wallet()

        # Check account doesn't exist
        account = await client.api.get_account(owner=wallet.b256_address)
        assert not account.exists

        # Create account
        result = await client.api.create_account(wallet.b256_address)
        assert result.trade_account_id.startswith("0x")

        # Verify it exists now
        account = await client.api.get_account(owner=wallet.b256_address)
        assert account.exists
        assert account.trade_account_id == result.trade_account_id
        assert account.nonce == 0
        await client.close()

    async def test_setup_account_idempotent(self, client):
        wallet = client.generate_wallet()

        # First call creates
        account1 = await client.setup_account(wallet)
        assert account1.exists

        # Second call is idempotent
        account2 = await client.setup_account(wallet)
        assert account2.trade_account_id == account1.trade_account_id
        await client.close()


class TestSessionFlow:
    async def test_create_session(self, funded_account):
        client, wallet, account = funded_account

        markets = await client.get_markets()
        if not markets:
            pytest.skip("No markets available")

        market = markets[0]
        session = await client.create_session(
            owner=wallet,
            markets=[market.pair],
            expiry_days=1,
        )

        assert session.trade_account_id == account.trade_account_id
        assert session.session_private_key is not None
        assert len(session.contract_ids) > 0


def _min_quantity_for_min_order(market, price):
    """Calculate minimum quantity that meets min_order at the given price."""
    min_order = float(market.min_order) if market.min_order else 1_000_000
    quote_factor = 10**market.quote.decimals
    base_factor = 10**market.base.decimals
    # min_order <= price * quote_factor * quantity
    min_qty = min_order / (price * quote_factor)
    # Round up to nearest precision step and add margin
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    step = truncate_factor / base_factor
    rounded = math.ceil(min_qty / step) * step
    return rounded * 1.1


async def _consume_first(stream):
    """Get the first item from an async generator (for use as a background task)."""
    async for update in stream:
        return update
    return None


def _moderate_fill_price(market):
    """Deterministic price for fill tests: min_order * 10^base.max_precision / 10^quote.decimals.

    Low enough to avoid walking through expensive stale sells on the book,
    high enough for comfortable order sizing.
    """
    min_order = float(market.min_order) if market.min_order else 1_000_000
    base_precision_factor = 10**market.base.max_precision
    quote_factor = 10**market.quote.decimals
    return min_order * base_precision_factor / quote_factor


def _fill_quantity(market, price):
    """Quantity targeting ~10x min_order value for fill tests.

    Rounded up to the nearest base precision step.
    """
    min_order = float(market.min_order) if market.min_order else 1_000_000
    quote_factor = 10**market.quote.decimals
    base_factor = 10**market.base.decimals
    qty = 10 * min_order / (price * quote_factor)
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    step = truncate_factor / base_factor
    return math.ceil(qty / step) * step


async def _cleanup_open_orders(client, wallet, market_pair):
    """Best-effort cleanup: cancel all open orders and settle balance for an account."""
    with contextlib.suppress(Exception):
        session = await client.create_session(owner=wallet, markets=[market_pair], expiry_days=1)
        with contextlib.suppress(Exception):
            await client.cancel_all_orders(session, market_pair)
        with contextlib.suppress(Exception):
            await client.settle_balance(session, market_pair)


class TestTradingFlow:
    async def test_get_nonce(self, funded_account):
        client, _wallet, account = funded_account
        nonce = await client.get_nonce(account.trade_account_id)
        assert isinstance(nonce, int)
        assert nonce >= 0

    async def test_get_balances(self, funded_account):
        client, _wallet, account = funded_account
        result = await client.get_balances(account.trade_account_id)
        assert isinstance(result, dict)

    async def test_order_placement(self, funded_accounts):
        client = funded_accounts["client"]
        wallet, account = funded_accounts["maker"]

        # Re-whitelist before trading (idempotent, handles propagation delays)
        await _whitelist_with_retry(client.api, account.trade_account_id, max_retries=2)

        markets = await client.get_markets()
        if not markets:
            pytest.skip("No markets available")

        market = markets[0]

        # Use minimum price step — guaranteed below any ask on the book.
        # Buy cost is always ≈ min_order regardless of price, so this is affordable.
        price_step = 10 ** (-market.quote.max_precision)
        buy_price = price_step
        quantity = _min_quantity_for_min_order(market, buy_price)

        # Verify we have quote balance
        balances = await client.get_balances(account.trade_account_id)
        quote_symbol = market.quote.symbol
        assert quote_symbol in balances, f"No {quote_symbol} balance after faucet"
        assert int(balances[quote_symbol].trading_account_balance) > 0

        session = await client.create_session(
            owner=wallet,
            markets=[market.pair],
            expiry_days=1,
        )

        # Place PostOnly Buy well below market - guaranteed to rest on the book
        result = await _create_order_with_whitelist_retry(
            client,
            session=session,
            market=market.pair,
            side=OrderSide.BUY,
            price=buy_price,
            quantity=quantity,
            order_type=OrderType.POST_ONLY,
            settle_first=True,
            collect_orders=True,
        )

        assert result.tx_id is not None, f"Order placement failed: {result.message}"
        assert result.orders is not None and len(result.orders) > 0
        order = result.orders[0]
        assert order.order_id is not None
        assert order.cancel is not True, "Order was unexpectedly cancelled"

        # Cancel the order
        cancel_result = await client.cancel_order(
            session=session,
            order_id=order.order_id,
            market=market.pair,
        )
        assert cancel_result.tx_id is not None, "Cancel failed"

    async def test_cross_account_fill(self, funded_accounts):
        client = funded_accounts["client"]
        maker_wallet, maker_account = funded_accounts["maker"]
        taker_wallet, taker_account = funded_accounts["taker"]

        # Re-whitelist both accounts before trading
        await _whitelist_with_retry(client.api, maker_account.trade_account_id, max_retries=2)
        await _whitelist_with_retry(client.api, taker_account.trade_account_id, max_retries=2)

        markets = await client.get_markets()
        if not markets:
            pytest.skip("No markets available")

        market = markets[0]

        # Cleanup leaked orders from earlier tests
        await _cleanup_open_orders(client, maker_wallet, market.pair)
        await _cleanup_open_orders(client, taker_wallet, market.pair)

        # Moderate price below stale sells — maker buy rests safely.
        # Taker FillOrKill sell targets the maker directly, avoiding
        # the gas cost of walking through many intermediate orders.
        fill_price = _moderate_fill_price(market)
        quantity = _fill_quantity(market, fill_price)

        # Check maker has enough quote to buy
        balances = await client.get_balances(maker_account.trade_account_id)
        quote_symbol = market.quote.symbol
        assert quote_symbol in balances, f"No {quote_symbol} balance after faucet"
        assert int(balances[quote_symbol].trading_account_balance) > 0

        # Maker: PostOnly Buy at moderate price → rests below stale sells
        maker_session = await client.create_session(
            owner=maker_wallet,
            markets=[market.pair],
            expiry_days=1,
        )
        maker_result = await _create_order_with_whitelist_retry(
            client,
            session=maker_session,
            market=market.pair,
            side=OrderSide.BUY,
            price=fill_price,
            quantity=quantity,
            order_type=OrderType.POST_ONLY,
            settle_first=True,
            collect_orders=True,
        )
        assert maker_result.tx_id is not None, f"Maker order failed: {maker_result.message}"
        assert maker_result.orders is not None and len(maker_result.orders) > 0
        maker_order = maker_result.orders[0]
        assert maker_order.order_id is not None
        assert maker_order.cancel is not True, "Maker order was unexpectedly cancelled"

        # Taker: FillOrKill Sell — fills against maker, never rests on the book
        taker_session = await client.create_session(
            owner=taker_wallet,
            markets=[market.pair],
            expiry_days=1,
        )
        taker_result = await _create_order_with_whitelist_retry(
            client,
            session=taker_session,
            market=market.pair,
            side=OrderSide.SELL,
            price=fill_price,
            quantity=quantity,
            order_type=OrderType.FILL_OR_KILL,
            settle_first=True,
            collect_orders=True,
        )
        assert taker_result.tx_id is not None, f"Taker order failed: {taker_result.message}"

        # Cleanup: cancel maker order if still open (may or may not have been filled)
        with contextlib.suppress(Exception):
            await client.cancel_order(
                session=maker_session,
                order_id=maker_order.order_id,
                market=market.pair,
            )


class TestWebSocket:
    async def test_depth_snapshot(self, client):
        markets = await client.get_markets()
        if not markets:
            pytest.skip("No markets available")

        market = markets[0]
        ws = await client._ensure_ws()

        received = False
        async for update in ws.stream_depth(market.market_id, "10"):
            assert update.market_id == market.market_id
            received = True
            break  # Just need one message

        assert received
        await client.close()

    async def test_websocket_trades(self, funded_accounts):
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]
        taker_wallet, taker_account = ctx["taker"]

        # Re-whitelist both accounts before trading
        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )
        await _whitelist_with_retry(
            ctx["client"].api, taker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        consumer = None
        maker_session = None
        taker_session = None
        maker_order = None
        taker_order = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            # Cleanup leaked orders from earlier tests
            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)
            await _cleanup_open_orders(ws_client, taker_wallet, market.pair)

            # Subscribe to trades stream via background task
            consumer = asyncio.create_task(_consume_first(ws_client.stream_trades(market.pair)))
            await asyncio.sleep(2)  # Wait for subscription to propagate

            # Deterministic pricing
            fill_price = _moderate_fill_price(market)
            quantity = _fill_quantity(market, fill_price)

            # Maker: PostOnly Buy at moderate price — rests below stale sells
            maker_session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            maker_result = await _create_order_with_whitelist_retry(
                ws_client,
                session=maker_session,
                market=market.pair,
                side=OrderSide.BUY,
                price=fill_price,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert maker_result.tx_id is not None, f"Maker order failed: {maker_result.message}"
            assert maker_result.orders and len(maker_result.orders) > 0
            maker_order = maker_result.orders[0]
            assert maker_order.cancel is not True, "Maker order was unexpectedly cancelled"

            # Taker: FillOrKill Sell — fills against maker, never rests
            taker_session = await ws_client.create_session(
                owner=taker_wallet, markets=[market.pair], expiry_days=1
            )
            taker_result = await _create_order_with_whitelist_retry(
                ws_client,
                session=taker_session,
                market=market.pair,
                side=OrderSide.SELL,
                price=fill_price,
                quantity=quantity,
                order_type=OrderType.FILL_OR_KILL,
                settle_first=True,
                collect_orders=True,
            )
            assert taker_result.tx_id is not None, f"Taker order failed: {taker_result.message}"
            if taker_result.orders:
                taker_order = taker_result.orders[0]

            # Wait for trade update — MUST arrive after cross-account fill
            try:
                update = await asyncio.wait_for(consumer, timeout=30)
                consumer = None  # Task completed
                assert update is not None
                assert isinstance(update, TradeUpdate)
            except asyncio.TimeoutError:
                pytest.fail(
                    "WebSocket trades timed out after successful fill — subscription is broken"
                )
        finally:
            if consumer and not consumer.done():
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consumer
            with contextlib.suppress(Exception):
                if maker_session and maker_order:
                    await ws_client.cancel_order(
                        session=maker_session,
                        order_id=maker_order.order_id,
                        market=market.pair,
                    )
            with contextlib.suppress(Exception):
                if taker_session and taker_order:
                    await ws_client.cancel_order(
                        session=taker_session,
                        order_id=taker_order.order_id,
                        market=market.pair,
                    )
            with contextlib.suppress(Exception):
                if maker_session:
                    await ws_client.settle_balance(maker_session, market.pair)
            with contextlib.suppress(Exception):
                if taker_session:
                    await ws_client.settle_balance(taker_session, market.pair)
            await ws_client.close()

    async def test_websocket_orders(self, funded_accounts):
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]

        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        consumer = None
        session = None
        order_id = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)

            # Subscribe to orders for maker account
            consumer = asyncio.create_task(
                _consume_first(ws_client.stream_orders(maker_account.trade_account_id))
            )
            await asyncio.sleep(2)

            # PostOnly Buy at minimum price step
            price_step = 10 ** (-market.quote.max_precision)
            quantity = _min_quantity_for_min_order(market, price_step)

            session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            result = await _create_order_with_whitelist_retry(
                ws_client,
                session=session,
                market=market.pair,
                side=OrderSide.BUY,
                price=price_step,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert result.tx_id is not None, f"Order placement failed: {result.message}"
            if result.orders:
                order_id = result.orders[0].order_id

            # MUST receive order update
            try:
                update = await asyncio.wait_for(consumer, timeout=30)
                consumer = None
                assert update is not None
                assert isinstance(update, OrderUpdate)
                assert len(update.orders) > 0
            except asyncio.TimeoutError:
                pytest.fail(
                    "WebSocket orders timed out after successful order placement — subscription is broken"
                )
        finally:
            if consumer and not consumer.done():
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consumer
            with contextlib.suppress(Exception):
                if session and order_id:
                    await ws_client.cancel_order(
                        session=session, order_id=order_id, market=market.pair
                    )
                    await ws_client.settle_balance(session, market.pair)
            await ws_client.close()

    async def test_websocket_balances(self, funded_accounts):
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]

        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        consumer = None
        session = None
        order_id = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)

            # Subscribe to balances for maker account
            consumer = asyncio.create_task(
                _consume_first(ws_client.stream_balances(maker_account.trade_account_id))
            )
            await asyncio.sleep(2)

            # PostOnly Buy at minimum price step — locks balance
            price_step = 10 ** (-market.quote.max_precision)
            quantity = _min_quantity_for_min_order(market, price_step)

            session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            result = await _create_order_with_whitelist_retry(
                ws_client,
                session=session,
                market=market.pair,
                side=OrderSide.BUY,
                price=price_step,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert result.tx_id is not None, f"Order placement failed: {result.message}"
            if result.orders:
                order_id = result.orders[0].order_id

            # MUST receive balance update
            try:
                update = await asyncio.wait_for(consumer, timeout=30)
                consumer = None
                assert update is not None
                assert isinstance(update, BalanceUpdate)
                assert len(update.balance) > 0
            except asyncio.TimeoutError:
                pytest.fail(
                    "WebSocket balances timed out after successful order placement — subscription is broken"
                )
        finally:
            if consumer and not consumer.done():
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consumer
            with contextlib.suppress(Exception):
                if session and order_id:
                    await ws_client.cancel_order(
                        session=session, order_id=order_id, market=market.pair
                    )
                    await ws_client.settle_balance(session, market.pair)
            await ws_client.close()

    async def test_websocket_nonce(self, funded_accounts):
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]

        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        consumer = None
        session = None
        order_id = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)

            # Subscribe to nonce for maker account
            consumer = asyncio.create_task(
                _consume_first(ws_client.stream_nonce(maker_account.trade_account_id))
            )
            await asyncio.sleep(2)

            # PostOnly Buy at minimum price step — bumps nonce
            price_step = 10 ** (-market.quote.max_precision)
            quantity = _min_quantity_for_min_order(market, price_step)

            session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            result = await _create_order_with_whitelist_retry(
                ws_client,
                session=session,
                market=market.pair,
                side=OrderSide.BUY,
                price=price_step,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert result.tx_id is not None, f"Order placement failed: {result.message}"
            if result.orders:
                order_id = result.orders[0].order_id

            # MUST receive nonce update
            try:
                update = await asyncio.wait_for(consumer, timeout=30)
                consumer = None
                assert update is not None
                assert isinstance(update, NonceUpdate)
                assert update.nonce is not None
            except asyncio.TimeoutError:
                pytest.fail(
                    "WebSocket nonce timed out after successful order placement — subscription is broken"
                )
        finally:
            if consumer and not consumer.done():
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consumer
            with contextlib.suppress(Exception):
                if session and order_id:
                    await ws_client.cancel_order(
                        session=session, order_id=order_id, market=market.pair
                    )
                    await ws_client.settle_balance(session, market.pair)
            await ws_client.close()

    async def test_websocket_concurrent_subscriptions(self, funded_accounts):
        """Subscribe to orders, balances, and nonce simultaneously;
        place one order and verify each stream receives only its correct type."""
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]

        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        orders_consumer = None
        balances_consumer = None
        nonce_consumer = None
        session = None
        order_id = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)

            # Subscribe to all three streams concurrently on one WS connection
            orders_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_orders(maker_account.trade_account_id))
            )
            balances_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_balances(maker_account.trade_account_id))
            )
            nonce_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_nonce(maker_account.trade_account_id))
            )
            await asyncio.sleep(2)

            # Place one order — triggers orders, balances, and nonce updates
            price_step = 10 ** (-market.quote.max_precision)
            quantity = _min_quantity_for_min_order(market, price_step)

            session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            result = await _create_order_with_whitelist_retry(
                ws_client,
                session=session,
                market=market.pair,
                side=OrderSide.BUY,
                price=price_step,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert result.tx_id is not None, f"Order placement failed: {result.message}"
            if result.orders:
                order_id = result.orders[0].order_id

            # Each stream must deliver the correct type — no cross-contamination
            try:
                orders_update = await asyncio.wait_for(orders_consumer, timeout=30)
                orders_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Orders stream timed out")

            try:
                balances_update = await asyncio.wait_for(balances_consumer, timeout=30)
                balances_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Balances stream timed out")

            try:
                nonce_update = await asyncio.wait_for(nonce_consumer, timeout=30)
                nonce_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Nonce stream timed out")

            assert isinstance(orders_update, OrderUpdate), (
                f"Orders stream received wrong type: {type(orders_update).__name__}"
            )
            assert len(orders_update.orders) > 0

            assert isinstance(balances_update, BalanceUpdate), (
                f"Balances stream received wrong type: {type(balances_update).__name__}"
            )
            assert len(balances_update.balance) > 0

            assert isinstance(nonce_update, NonceUpdate), (
                f"Nonce stream received wrong type: {type(nonce_update).__name__}"
            )
            assert nonce_update.nonce is not None

        finally:
            for consumer in [orders_consumer, balances_consumer, nonce_consumer]:
                if consumer and not consumer.done():
                    consumer.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await consumer
            with contextlib.suppress(Exception):
                if session and order_id:
                    await ws_client.cancel_order(
                        session=session, order_id=order_id, market=market.pair
                    )
                    await ws_client.settle_balance(session, market.pair)
            await ws_client.close()

    async def test_websocket_mixed_with_fill(self, funded_accounts):
        """Subscribe to trades, orders, and balances; execute a cross-account fill
        and verify each stream gets only its own type."""
        ctx = funded_accounts
        maker_wallet, maker_account = ctx["maker"]
        taker_wallet, taker_account = ctx["taker"]

        await _whitelist_with_retry(
            ctx["client"].api, maker_account.trade_account_id, max_retries=2
        )
        await _whitelist_with_retry(
            ctx["client"].api, taker_account.trade_account_id, max_retries=2
        )

        ws_client = O2Client(network=Network.TESTNET)
        trades_consumer = None
        orders_consumer = None
        balances_consumer = None
        maker_session = None
        taker_session = None
        maker_order = None
        try:
            markets = await ws_client.get_markets()
            if not markets:
                pytest.skip("No markets available")
            market = markets[0]

            await _cleanup_open_orders(ws_client, maker_wallet, market.pair)
            await _cleanup_open_orders(ws_client, taker_wallet, market.pair)

            # Subscribe to all three streams
            trades_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_trades(market.pair))
            )
            orders_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_orders(maker_account.trade_account_id))
            )
            balances_consumer = asyncio.create_task(
                _consume_first(ws_client.stream_balances(maker_account.trade_account_id))
            )
            await asyncio.sleep(2)

            # Cross-account fill
            fill_price = _moderate_fill_price(market)
            quantity = _fill_quantity(market, fill_price)

            maker_session = await ws_client.create_session(
                owner=maker_wallet, markets=[market.pair], expiry_days=1
            )
            maker_result = await _create_order_with_whitelist_retry(
                ws_client,
                session=maker_session,
                market=market.pair,
                side=OrderSide.BUY,
                price=fill_price,
                quantity=quantity,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
            )
            assert maker_result.tx_id is not None
            assert maker_result.orders and len(maker_result.orders) > 0
            maker_order = maker_result.orders[0]

            taker_session = await ws_client.create_session(
                owner=taker_wallet, markets=[market.pair], expiry_days=1
            )
            await _create_order_with_whitelist_retry(
                ws_client,
                session=taker_session,
                market=market.pair,
                side=OrderSide.SELL,
                price=fill_price,
                quantity=quantity,
                order_type=OrderType.FILL_OR_KILL,
                settle_first=True,
                collect_orders=True,
            )

            # Each stream must deliver the correct type
            try:
                trades_update = await asyncio.wait_for(trades_consumer, timeout=30)
                trades_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Trades stream timed out after cross-account fill")

            try:
                orders_update = await asyncio.wait_for(orders_consumer, timeout=30)
                orders_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Orders stream timed out after cross-account fill")

            try:
                balances_update = await asyncio.wait_for(balances_consumer, timeout=30)
                balances_consumer = None
            except asyncio.TimeoutError:
                pytest.fail("Balances stream timed out after cross-account fill")

            assert isinstance(trades_update, TradeUpdate), (
                f"Trades stream got wrong type: {type(trades_update).__name__}"
            )
            assert len(trades_update.trades) > 0

            assert isinstance(orders_update, OrderUpdate), (
                f"Orders stream got wrong type: {type(orders_update).__name__}"
            )
            assert len(orders_update.orders) > 0

            assert isinstance(balances_update, BalanceUpdate), (
                f"Balances stream got wrong type: {type(balances_update).__name__}"
            )
            assert len(balances_update.balance) > 0

        finally:
            for consumer in [trades_consumer, orders_consumer, balances_consumer]:
                if consumer and not consumer.done():
                    consumer.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await consumer
            with contextlib.suppress(Exception):
                if maker_session and maker_order:
                    await ws_client.cancel_order(
                        session=maker_session,
                        order_id=maker_order.order_id,
                        market=market.pair,
                    )
            with contextlib.suppress(Exception):
                if maker_session:
                    await ws_client.settle_balance(maker_session, market.pair)
            with contextlib.suppress(Exception):
                if taker_session:
                    await ws_client.settle_balance(taker_session, market.pair)
            await ws_client.close()
