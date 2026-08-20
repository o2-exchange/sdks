"""Integration tests against testnet.

Run with: pytest tests/test_integration.py -m integration
These tests require network access and hit the live testnet API.
"""

import asyncio
import contextlib
import json
import math
from pathlib import Path

import pytest

from o2_sdk import (
    BalanceUpdate,
    ContractIdentity,
    Network,
    NonceUpdate,
    O2Client,
    O2Error,
    OrderSide,
    OrderType,
    OrderUpdate,
    TradeUpdate,
)
from o2_sdk.api import O2Api
from o2_sdk.config import get_config
from o2_sdk.crypto import Wallet
from o2_sdk.models import Market, SessionInfo

pytestmark = pytest.mark.integration

_WALLET_CACHE_PATH = Path(__file__).resolve().parents[1] / ".integration-wallets.json"


async def _mint_with_retry(api, trade_account_id, max_retries=4):
    """Attempt faucet mint with retry on cooldown."""
    for attempt in range(max_retries):
        try:
            await api.mint_to_contract(trade_account_id)
            return
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)


async def _wait_for_trading_account_balance(
    client: O2Client,
    trade_account_id: str,
    asset_id: str,
    expected: int,
    *,
    at_least: bool = False,
) -> int:
    """Wait for the balance indexer to observe a withdrawal or faucet mint."""
    for _ in range(20):
        balance = await client.api.get_balance(asset_id=asset_id, contract=trade_account_id)
        raw = int(balance.trading_account_balance)
        matches = raw >= expected if at_least else raw == expected
        if matches:
            return raw
        await asyncio.sleep(1)
    comparison = "at least" if at_least else "exactly"
    raise AssertionError(f"trading account balance did not reach {comparison} {expected}")


def _load_cached_wallet(client: O2Client, role: str):
    if not _WALLET_CACHE_PATH.exists():
        return None
    try:
        data = json.loads(_WALLET_CACHE_PATH.read_text())
        pk = data.get(role)
        if isinstance(pk, str) and pk:
            return client.load_wallet(pk)
    except Exception:
        return None
    return None


def _save_cached_wallet(role: str, wallet) -> None:
    data = {}
    if _WALLET_CACHE_PATH.exists():
        try:
            data = json.loads(_WALLET_CACHE_PATH.read_text())
        except Exception:
            data = {}
    data[role] = "0x" + wallet.private_key.hex()
    _WALLET_CACHE_PATH.write_text(json.dumps(data, indent=2) + "\n")


def _load_or_create_wallet(client: O2Client, role: str):
    wallet = _load_cached_wallet(client, role)
    if wallet is not None:
        return wallet
    wallet = client.generate_wallet()
    _save_cached_wallet(role, wallet)
    return wallet


async def _wait_for_indexed_account(
    api,
    *,
    owner=None,
    trade_account_id=None,
    require_trade_account=False,
):
    for _ in range(30):
        account = await api.get_account(owner=owner, trade_account_id=trade_account_id)
        if account.exists and (not require_trade_account or account.trade_account is not None):
            return account
        await asyncio.sleep(2)
    raise AssertionError("Testnet account did not reach the indexer within 60 seconds")


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


async def _ensure_sufficient_test_balance(client, trade_account_id):
    """Mint only when account balance is below a conservative test threshold."""
    markets_resp = await client.api.get_markets()
    min_orders = [int(m.min_order or "0") for m in markets_resp.markets]
    min_required = (max(min_orders) if min_orders else 1_000_000) * 50
    current = await client.api.get_balance(
        asset_id=markets_resp.base_asset_id,
        contract=trade_account_id,
    )
    current_balance = int(current.trading_account_balance)
    if current_balance >= min_required:
        return
    await _mint_with_retry(client.api, trade_account_id)


async def _setup_funded_account(client, role, max_retries=4):
    """Create/reuse account, ensure whitelist, and fund only if below threshold."""
    wallet = _load_or_create_wallet(client, role)
    for attempt in range(max_retries):
        try:
            account = await client.setup_account(wallet)
            break
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)
            else:
                raise
    # Explicitly whitelist with retry for propagation robustness on testnet.
    await _whitelist_with_retry(client.api, account.trade_account_id)
    await _ensure_sufficient_test_balance(client, account.trade_account_id)
    return wallet, account


@pytest.fixture(scope="module")
async def funded_accounts():
    """Two funded accounts (maker + taker) for cross-account tests."""
    client = O2Client(network=Network.TESTNET)

    maker_wallet, maker_account = await _setup_funded_account(client, "maker")
    taker_wallet, taker_account = await _setup_funded_account(client, "taker")

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


@pytest.fixture(scope="module")
async def market_snapshot():
    """Shared read-only market snapshot with parallel depth/trades fetch."""
    api = O2Api(get_config(Network.TESTNET))
    try:
        markets_resp = await api.get_markets()
        if not markets_resp.markets:
            pytest.skip("No markets available")
        market = markets_resp.markets[0]
        depth, trades = await asyncio.gather(
            api.get_depth(market.market_id),
            api.get_trades(market.market_id, count=10),
        )
        yield {
            "markets_resp": markets_resp,
            "market": market,
            "depth": depth,
            "trades": trades,
        }
    finally:
        await api.close()


@pytest.fixture
def client():
    return O2Client(network=Network.TESTNET)


class TestMarketData:
    async def test_get_markets(self, market_snapshot):
        resp = market_snapshot["markets_resp"]
        market = market_snapshot["market"]
        assert len(resp.markets) > 0
        assert resp.chain_id is not None
        assert resp.accounts_registry_id != ""
        assert market.contract_id.startswith("0x")
        assert market.market_id.startswith("0x")
        assert market.base.decimals > 0
        assert market.quote.decimals > 0

    async def test_get_depth(self, market_snapshot):
        depth = market_snapshot["depth"]
        assert isinstance(depth.bids, list)
        assert isinstance(depth.asks, list)

    async def test_get_trades(self, market_snapshot):
        trades = market_snapshot["trades"]
        assert isinstance(trades, list)

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
        account = await _wait_for_indexed_account(
            client.api,
            owner=wallet.b256_address,
            require_trade_account=True,
        )
        assert account.exists
        assert account.trade_account is not None
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
    # Apply margin, then round up to nearest precision step.
    # Rounding first and multiplying by margin can violate max_precision.
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    step = truncate_factor / base_factor
    rounded = math.ceil((min_qty * 1.1) / step) * step
    return rounded


def test_min_quantity_for_min_order_rounds_after_margin_to_step():
    class _Asset:
        def __init__(self, decimals, max_precision):
            self.decimals = decimals
            self.max_precision = max_precision

    class _Market:
        def __init__(self):
            self.min_order = 950_000
            self.base = _Asset(decimals=9, max_precision=3)
            self.quote = _Asset(decimals=9, max_precision=9)

    market = _Market()
    qty = _min_quantity_for_min_order(market, price=1.0)
    step = 10 ** (market.base.decimals - market.base.max_precision) / (10**market.base.decimals)
    min_required_with_margin = (market.min_order / (10**market.quote.decimals)) * 1.1

    assert qty >= min_required_with_margin
    assert math.isclose(qty / step, round(qty / step), rel_tol=0.0, abs_tol=1e-9)
    assert qty == pytest.approx(0.002, abs=1e-12)


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


async def _conservative_post_only_buy_price(client, market):
    """Choose a conservative post-only buy price from live depth when available."""
    fallback = _moderate_fill_price(market)
    price_step = 10 ** (-market.quote.max_precision)
    try:
        # Use precision=1 (finest) to get accurate best ask/bid prices.
        # Coarser levels aggregate prices into wide buckets, which can cause
        # the chosen price to accidentally cross the actual best ask.
        depth = await client.get_depth(market.pair, precision=1)
        if depth.best_bid:
            best_bid = market.format_price(int(depth.best_bid.price))
            return max(price_step, _floor_to_step(best_bid * 0.8, price_step))
        if depth.best_ask:
            best_ask = market.format_price(int(depth.best_ask.price))
            return max(price_step, _floor_to_step(best_ask * 0.8, price_step))
    except Exception as ex:
        # Depth fetch failures are non-fatal; fall back to a conservative price.
        print(f"Warning: failed to fetch depth for {market.pair}: {ex}")
    return max(price_step, fallback)


def _floor_to_step(value, step):
    if step <= 0:
        return value
    return math.floor(value / step) * step


async def _symbol_balance_chain(client, trade_account_id, symbol):
    balances = await client.get_balances(trade_account_id)
    bal = balances.get(symbol)
    if bal is None:
        return 0
    return int(bal.trading_account_balance)


async def _cross_fill_quantity(
    client,
    market,
    price,
    maker_trade_account_id,
    taker_trade_account_id,
):
    """Choose minimal deterministic cross-fill quantity, funding and failing explicitly if needed."""
    min_qty = _min_quantity_for_min_order(market, price)
    target_qty = min_qty * 1.05

    base_decimals = market.base.decimals
    quote_decimals = market.quote.decimals
    step = 10 ** (base_decimals - market.base.max_precision) / (10**base_decimals)

    last_details = ""
    for attempt in range(2):
        taker_base_chain = await _symbol_balance_chain(
            client, taker_trade_account_id, market.base.symbol
        )
        maker_quote_chain = await _symbol_balance_chain(
            client, maker_trade_account_id, market.quote.symbol
        )

        taker_base_human_cap = (taker_base_chain / (10**base_decimals)) * 0.9
        maker_quote_human_cap = (maker_quote_chain / (10**quote_decimals)) * 0.9
        maker_affordable_qty_cap = maker_quote_human_cap / price if price > 0 else 0

        cap = min(taker_base_human_cap, maker_affordable_qty_cap)
        qty = _floor_to_step(min(target_qty, cap), step)
        last_details = (
            f"min_qty={min_qty}, proposed_qty={qty}, cap={cap}, "
            f"taker_base_chain={taker_base_chain}, maker_quote_chain={maker_quote_chain}, "
            f"market={market.pair}, price={price}"
        )
        if qty >= min_qty:
            return qty

        if attempt == 0:
            # Refresh funding and retry once before failing invariant.
            await _mint_with_retry(client.api, maker_trade_account_id, max_retries=2)
            await _mint_with_retry(client.api, taker_trade_account_id, max_retries=2)

    raise AssertionError(f"Unable to compute valid cross-fill quantity: {last_details}")


async def _cleanup_open_orders(client, wallet, market_pair):
    """Best-effort cleanup: cancel all open orders and settle balance for an account."""
    with contextlib.suppress(Exception):
        session = await client.create_session(owner=wallet, markets=[market_pair], expiry_days=1)
        with contextlib.suppress(Exception):
            await client.cancel_all_orders(market_pair, session=session)
        with contextlib.suppress(Exception):
            await client.settle_balance(market_pair, session=session)


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
        fill_price = await _conservative_post_only_buy_price(client, market)
        quantity = await _cross_fill_quantity(
            client,
            market,
            fill_price,
            maker_account.trade_account_id,
            taker_account.trade_account_id,
        )

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
            fill_price = await _conservative_post_only_buy_price(ws_client, market)
            quantity = await _cross_fill_quantity(
                ws_client,
                market,
                fill_price,
                maker_account.trade_account_id,
                taker_account.trade_account_id,
            )

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
                    await ws_client.settle_balance(market.pair, session=maker_session)
            with contextlib.suppress(Exception):
                if taker_session:
                    await ws_client.settle_balance(market.pair, session=taker_session)
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
                    await ws_client.settle_balance(market.pair, session=session)
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
                    await ws_client.settle_balance(market.pair, session=session)
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
                    await ws_client.settle_balance(market.pair, session=session)
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
                    await ws_client.settle_balance(market.pair, session=session)
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
            fill_price = await _conservative_post_only_buy_price(ws_client, market)
            quantity = await _cross_fill_quantity(
                ws_client,
                market,
                fill_price,
                maker_account.trade_account_id,
                taker_account.trade_account_id,
            )

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
                    await ws_client.settle_balance(market.pair, session=maker_session)
            with contextlib.suppress(Exception):
                if taker_session:
                    await ws_client.settle_balance(market.pair, session=taker_session)
            await ws_client.close()


@pytest.mark.integration

async def test_parallel_nonce_concurrent_submission():
    """Fire N concurrent batch_actions on the parallel track and assert there are
    no nonce conflicts and the cursor advances by N (one distinct slot each).

    This is the core guarantee: concurrent submissions never collide on a nonce
    (sequential would fail N-1 of them with 'nonce too low').

    Goes through ensure_parallel_session, which is also the assertion that the
    probe-and-upgrade startup path works against a live API: it probes the
    account and upgrades it only if the parallel entry points are missing."""
    from o2_sdk.client import O2Client
    from o2_sdk.config import Network

    n = 6
    client = O2Client(network=Network.TESTNET)
    try:
        wallet = _load_or_create_wallet(client, "parallel_test_tn")
        acct = await client.api.get_account(owner=wallet.b256_address)
        if acct.trade_account is None:
            res = await client.api.create_account(wallet.b256_address)
            acct = await client.api.get_account(trade_account_id=res.trade_account_id)
        ta = acct.trade_account_id
        with contextlib.suppress(Exception):
            await client.api.mint_to_contract(ta)

        market = (await client.get_markets())[0]
        session = await client.ensure_parallel_session(
            owner=wallet,
            markets=[market.pair],
            expiry_days=1,
            nonce_session_id=0,
        )
        assert session.nonce_manager is not None
        before = session.nonce_manager.cursor
        price = 10 ** (-market.quote.max_precision)
        qty = _min_quantity_for_min_order(market, price)

        async def place():
            try:
                r = await client.create_order(
                    market=market.pair,
                    side=OrderSide.BUY,
                    price=price,
                    quantity=qty,
                    order_type=OrderType.POST_ONLY,
                    settle_first=True,
                    collect_orders=True,
                    session=session,
                )
                return ("ok", str(r.tx_id))
            except Exception as e:
                reason = (str(e) + " " + (getattr(e, "reason", "") or "")).lower()
                is_nonce = "nonce" in reason and any(
                    k in reason for k in ("low", "usable", "window")
                )
                return ("nonce_conflict" if is_nonce else "other", reason[:120])

        results = await asyncio.gather(*[place() for _ in range(n)])
        nonce_conflicts = [r for r in results if r[0] == "nonce_conflict"]
        after = session.nonce_manager.cursor

        # The guarantee: concurrent submissions never collide on a nonce, and the
        # cursor advances by exactly n (one slot per call). Carry across the
        # 128-bit word boundary, or this fails whenever the run starts near the
        # end of a word.
        from o2_sdk.nonce import NONCE_BITMAP_SIZE

        assert not nonce_conflicts, f"nonce conflicts under concurrency: {nonce_conflicts}"
        word, bit = before
        expected = divmod(word * NONCE_BITMAP_SIZE + bit + n, NONCE_BITMAP_SIZE)
        assert after == expected, f"cursor {before} -> {after}, expected {expected}"
    finally:
        await client.close()


async def _parallel_recovery_setup(client: O2Client) -> tuple[Wallet, Market, SessionInfo]:
    """Shared setup for the two nonce-recovery tests: a funded testnet account
    on the parallel track with an empty book, so open-order counts are small
    and unambiguous.

    Returns (wallet, market, session). Reuses the wallet the concurrent-
    submission test uses, which is known-good in CI; the tests run
    sequentially, so each creating its own session is fine (the contract holds
    one session per account, and the previous test is finished by then).
    """
    wallet = _load_or_create_wallet(client, "parallel_test_tn")
    acct = await client.api.get_account(owner=wallet.b256_address)
    if acct.trade_account is None:
        res = await client.api.create_account(wallet.b256_address)
        acct = await client.api.get_account(trade_account_id=res.trade_account_id)
    with contextlib.suppress(Exception):
        await client.api.mint_to_contract(acct.trade_account_id)

    market = (await client.get_markets())[0]
    session = await client.ensure_parallel_session(
        owner=wallet, markets=[market.pair], expiry_days=1, nonce_session_id=0
    )
    # Start from an empty book so "did a second order appear" is answerable
    # without paginating a large order list.
    with contextlib.suppress(Exception):
        await client.cancel_all_orders(market.pair, session=session)
    return wallet, market, session


async def _open_order_count(client, market, session):
    orders = await client.get_orders(market.pair, session.trade_account_id, is_open=True, count=100)
    return len(orders)


@pytest.mark.integration
async def test_parallel_nonce_out_of_window_recovers_without_duplicating():
    """Force the cursor past the chain's sliding window, then submit.

    The server must reject the nonce as out-of-window, the SDK must resync the
    cursor once and retry on a fresh slot, and the result must be exactly ONE
    order. This is the retry path that IS safe (the rejection proves the
    actions never executed) and it has no live coverage otherwise.
    """
    from o2_sdk.client import O2Client
    from o2_sdk.config import Network
    from o2_sdk.nonce import NONCE_BITMAP_SIZE, NONCE_SESSION_SLIDING_WINDOW_SIZE

    client = O2Client(network=Network.TESTNET)
    try:
        _wallet, market, session = await _parallel_recovery_setup(client)
        manager = session.nonce_manager
        assert manager is not None

        before_count = await _open_order_count(client, market, session)
        generation_before = manager.resync_generation

        # Burn the cursor past the whole window (1024 slots) plus a margin, so
        # the next nonce is unambiguously outside [base, base + 8 words).
        burn = NONCE_BITMAP_SIZE * NONCE_SESSION_SLIDING_WINDOW_SIZE + NONCE_BITMAP_SIZE
        for _ in range(burn):
            manager.next_nonce()
        assert manager.cursor[0] > NONCE_SESSION_SLIDING_WINDOW_SIZE

        price = 10 ** (-market.quote.max_precision)
        qty = _min_quantity_for_min_order(market, price)
        result = await client.create_order(
            market=market.pair,
            side=OrderSide.BUY,
            price=price,
            quantity=qty,
            order_type=OrderType.POST_ONLY,
            settle_first=True,
            collect_orders=True,
            session=session,
        )

        assert result.tx_id, "submission should have recovered and landed"
        assert manager.resync_generation > generation_before, (
            "the out-of-window rejection should have driven exactly one resync"
        )
        after_count = await _open_order_count(client, market, session)
        assert after_count == before_count + 1, (
            f"expected exactly one new order after recovery, went {before_count} -> {after_count}"
        )
    finally:
        with contextlib.suppress(Exception):
            await client.cancel_all_orders(market.pair, session=session)
        await client.close()


@pytest.mark.integration
async def test_parallel_nonce_already_used_is_surfaced_not_retried():
    """The duplicate-order guard, end to end against a live chain.

    Consume a slot with a real order, rewind the cursor onto that exact slot
    (which is the state the un-coalesced resync used to produce), and submit
    again. The server answers "nonce already used", which is ambiguous: it is
    also what a submission that LANDED but lost its response looks like. The
    SDK must surface it rather than retry on a fresh slot, because retrying
    would place a second order.

    Before the fix this test would fail by placing two orders.
    """
    from o2_sdk.client import O2Client
    from o2_sdk.config import Network
    from o2_sdk.nonce import is_parallel_nonce_already_used

    client = O2Client(network=Network.TESTNET)
    try:
        _wallet, market, session = await _parallel_recovery_setup(client)
        manager = session.nonce_manager
        assert manager is not None

        price = 10 ** (-market.quote.max_precision)
        qty = _min_quantity_for_min_order(market, price)

        # The slot the next submission will consume.
        consumed_cursor = manager.cursor
        first = await client.create_order(
            market=market.pair,
            side=OrderSide.BUY,
            price=price,
            quantity=qty,
            order_type=OrderType.POST_ONLY,
            settle_first=True,
            collect_orders=True,
            session=session,
        )
        assert first.tx_id
        count_after_first = await _open_order_count(client, market, session)

        # Rewind onto the slot that order just consumed. Reaching into the
        # cursor is the only way to produce this deterministically from one
        # client, and it reproduces exactly the state a backwards resync
        # created in production.
        with manager._lock:
            manager._word, manager._bit = consumed_cursor

        with pytest.raises(O2Error) as exc_info:
            await client.create_order(
                market=market.pair,
                side=OrderSide.BUY,
                price=price,
                quantity=qty,
                order_type=OrderType.POST_ONLY,
                settle_first=True,
                collect_orders=True,
                session=session,
            )

        assert is_parallel_nonce_already_used(exc_info.value), (
            f"expected an already-used rejection, got: {exc_info.value}"
        )
        count_after_second = await _open_order_count(client, market, session)
        assert count_after_second == count_after_first, (
            f"a second order was placed on an already-used nonce "
            f"({count_after_first} -> {count_after_second}); the retry must not "
            f"fire on an ambiguous rejection"
        )
    finally:
        with contextlib.suppress(Exception):
            await client.cancel_all_orders(market.pair, session=session)
        await client.close()


@pytest.mark.integration
async def test_sequential_withdraw_to_address_and_contract_id():
    """Tries a withdrawal on the live testnet environment."""
    client = O2Client(network=Network.TESTNET)
    try:
        wallet = _load_or_create_wallet(client, "parallel_test_tn")
        account = await client.api.get_account(owner=wallet.b256_address)
        if account.trade_account_id is None:
            created = await client.api.create_account(wallet.b256_address)
            account = await client.api.get_account(trade_account_id=created.trade_account_id)
        assert account.trade_account_id is not None

        recipient_wallet = _load_or_create_wallet(client, "withdraw_recipient_tn")
        recipient = await client.api.get_account(owner=recipient_wallet.b256_address)
        if recipient.trade_account_id is None:
            created = await client.api.create_account(recipient_wallet.b256_address)
            recipient = await client.api.get_account(trade_account_id=created.trade_account_id)
        assert recipient.trade_account_id is not None

        market = (await client.get_markets())[0]
        asset = market.quote
        before_response = await client.api.get_balance(
            asset_id=asset.asset,
            contract=account.trade_account_id,
        )
        before = int(before_response.trading_account_balance)
        if before < 2:
            await _mint_with_retry(client.api, account.trade_account_id)
            before = await _wait_for_trading_account_balance(
                client,
                account.trade_account_id,
                asset.asset,
                2,
                at_least=True,
            )

        atomic_amount = 10.0 ** (-asset.decimals)
        assert int(atomic_amount * (10**asset.decimals)) == 1
        assert client.session is None

        address_result = await client.withdraw(
            wallet,
            asset.asset,
            atomic_amount,
            wallet.b256_address,
        )
        assert address_result.success, address_result.message

        contract_result = await client.withdraw(
            wallet,
            asset.asset,
            atomic_amount,
            ContractIdentity(str(recipient.trade_account_id)),
        )
        assert contract_result.success, contract_result.message

        after = await _wait_for_trading_account_balance(
            client,
            account.trade_account_id,
            asset.asset,
            before - 2,
        )
        assert after == before - 2
    finally:
        await client.close()


@pytest.mark.integration
async def test_parallel_nonce_withdrawal_recovery():
    """Exercise typed withdrawals and both managed-nonce recovery branches.

    A normal managed withdrawal must land, an out-of-window nonce must resync
    and land exactly once, and an already-consumed slot must resync local state
    while surfacing the error without a retry.
    """
    from o2_sdk.nonce import (
        NONCE_BITMAP_SIZE,
        NONCE_SESSION_SLIDING_WINDOW_SIZE,
        is_parallel_nonce_already_used,
    )

    client = O2Client(network=Network.TESTNET)
    try:
        wallet, market, session = await _parallel_recovery_setup(client)
        manager = session.nonce_manager
        assert manager is not None

        account = await client.api.get_account(owner=wallet.b256_address)
        assert account.trade_account_id is not None
        asset = market.quote
        balance = await client.api.get_balance(
            asset_id=asset.asset,
            contract=account.trade_account_id,
        )
        if int(balance.trading_account_balance) < 2:
            await _mint_with_retry(client.api, account.trade_account_id)
            await _wait_for_trading_account_balance(
                client,
                account.trade_account_id,
                asset.asset,
                2,
                at_least=True,
            )
        atomic_amount = 10.0 ** (-asset.decimals)
        assert int(atomic_amount * (10**asset.decimals)) == 1

        consumed_cursor = manager.cursor
        happy = await client.withdraw(wallet, asset.asset, atomic_amount)
        assert happy.success

        generation_before_out_of_window = manager.resync_generation
        burn = NONCE_BITMAP_SIZE * NONCE_SESSION_SLIDING_WINDOW_SIZE + NONCE_BITMAP_SIZE
        for _ in range(burn):
            manager.next_nonce()

        recovered = await client.withdraw(wallet, asset.asset, atomic_amount)
        assert recovered.success
        assert manager.resync_generation > generation_before_out_of_window

        generation_before_already_used = manager.resync_generation
        with manager._lock:
            manager._word, manager._bit = consumed_cursor

        with pytest.raises(O2Error) as exc_info:
            await client.withdraw(wallet, asset.asset, atomic_amount)

        assert is_parallel_nonce_already_used(exc_info.value), (
            f"expected an already-used rejection, got: {exc_info.value}"
        )
        assert manager.resync_generation > generation_before_already_used
    finally:
        await client.close()
