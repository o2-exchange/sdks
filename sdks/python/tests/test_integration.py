"""Integration tests against testnet.

Run with: pytest tests/test_integration.py -m integration
These tests require network access and hit the live testnet API.
"""

import asyncio

import pytest

from o2_sdk import O2Client, Network
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
            await asyncio.sleep(3)
            return
        except Exception:
            if attempt < max_retries - 1:
                await asyncio.sleep(65)


async def _create_order_with_whitelist_retry(client, max_retries=3, **kwargs):
    """Place an order, re-whitelisting on TraderNotWhiteListed errors."""
    session = kwargs.get("session")
    for attempt in range(max_retries):
        try:
            return await client.create_order(**kwargs)
        except Exception as e:
            if "TraderNotWhiteListed" in str(e) and attempt < max_retries - 1:
                # Re-whitelist and retry
                trade_account_id = session.trade_account_id if session else None
                if trade_account_id:
                    await _whitelist_with_retry(client.api, trade_account_id, max_retries=2)
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


async def _get_market_prices(client, market):
    """Get (ref_price, best_bid, best_ask) from market data."""
    ref_price = 0.0
    best_bid = 0.0
    best_ask = 0.0

    try:
        depth = await client.api.get_depth(market.market_id)
        if depth.buys:
            entry = depth.buys[0]
            p = int(entry["price"] if isinstance(entry, dict) else entry.price)
            if p > 0:
                best_bid = market.format_price(p)
                if ref_price == 0.0:
                    ref_price = best_bid
        if depth.sells:
            entry = depth.sells[0]
            p = int(entry["price"] if isinstance(entry, dict) else entry.price)
            if p > 0:
                best_ask = market.format_price(p)
                if ref_price == 0.0:
                    ref_price = best_ask
    except Exception:
        pass

    try:
        trades = await client.get_trades(market.pair, count=5)
        if trades:
            chain_price = int(trades[0].price)
            if chain_price > 0:
                ref_price = market.format_price(chain_price)
    except Exception:
        pass

    if ref_price == 0.0:
        ref_price = 1.0
    return ref_price, best_bid, best_ask


def _safe_sell_price(market, base_balance):
    """Calculate a safe sell price from balance constraints alone (no book dependency).

    Uses a tiny fraction of base balance so the price is very high — well above
    any testnet bid — and the required quantity is trivially small.
    """
    min_order = float(market.min_order) if market.min_order else 1_000_000
    base_factor = 10 ** market.base.decimals
    quote_factor = 10 ** market.quote.decimals
    # Budget: 0.1% of balance or 100k chain units, whichever is smaller
    budget_chain = min(base_balance * 0.001, 100_000)
    budget = max(budget_chain, 1) / base_factor
    # Price where selling 'budget' meets min_order, with 2x margin
    return (min_order / (budget * quote_factor)) * 2.0


def _min_quantity_for_min_order(market, price):
    """Calculate minimum quantity that meets min_order at the given price."""
    import math

    min_order = float(market.min_order) if market.min_order else 1_000_000
    quote_factor = 10 ** market.quote.decimals
    base_factor = 10 ** market.base.decimals
    # min_order <= price * quote_factor * quantity
    min_qty = min_order / (price * quote_factor)
    # Round up to nearest precision step and add margin
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    step = truncate_factor / base_factor
    rounded = math.ceil(min_qty / step) * step
    return rounded * 1.1


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
            side="Buy",
            price=buy_price,
            quantity=quantity,
            order_type="PostOnly",
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
        quote_factor = 10 ** market.quote.decimals

        # Get reference price from market data
        ref_price, best_bid, best_ask = await _get_market_prices(client, market)

        # Sell price: 10% above best ask to ensure PostOnly rests
        if best_ask > 0.0:
            sell_price = best_ask * 1.1
        elif best_bid > 0.0:
            sell_price = best_bid * 1.5
        else:
            sell_price = ref_price * 1.5
        quantity = _min_quantity_for_min_order(market, sell_price)

        # Check maker has enough base
        balances = await client.get_balances(maker_account.trade_account_id)
        base_symbol = market.base.symbol
        assert base_symbol in balances, f"No {base_symbol} balance after faucet"
        assert int(balances[base_symbol].trading_account_balance) > 0

        # Maker: PostOnly Sell above market → rests on the book
        maker_session = await client.create_session(
            owner=maker_wallet,
            markets=[market.pair],
            expiry_days=1,
        )
        maker_result = await _create_order_with_whitelist_retry(
            client,
            session=maker_session,
            market=market.pair,
            side="Sell",
            price=sell_price,
            quantity=quantity,
            order_type="PostOnly",
            settle_first=True,
            collect_orders=True,
        )
        assert maker_result.tx_id is not None, f"Maker order failed: {maker_result.message}"
        assert maker_result.orders is not None and len(maker_result.orders) > 0
        maker_order = maker_result.orders[0]
        assert maker_order.order_id is not None
        assert maker_order.cancel is not True, "Maker order was unexpectedly cancelled"

        # Taker: use up to 90% of quote balance to buy at sell_price.
        # Don't try to estimate intermediate volume — other orders may
        # consume taker funds first, so we can't guarantee a full fill.
        taker_balances = await client.get_balances(taker_account.trade_account_id)
        quote_symbol = market.quote.symbol
        taker_quote = int(taker_balances[quote_symbol].trading_account_balance)
        taker_quantity = 0.9 * taker_quote / (quote_factor * sell_price)

        taker_session = await client.create_session(
            owner=taker_wallet,
            markets=[market.pair],
            expiry_days=1,
        )
        taker_result = await _create_order_with_whitelist_retry(
            client,
            session=taker_session,
            market=market.pair,
            side="Buy",
            price=sell_price,
            quantity=taker_quantity,
            order_type="Spot",
            settle_first=True,
            collect_orders=True,
        )
        assert taker_result.tx_id is not None, f"Taker order failed: {taker_result.message}"

        # Cleanup: cancel maker order if still open (may or may not have been filled)
        try:
            await client.cancel_order(
                session=maker_session,
                order_id=maker_order.order_id,
                market=market.pair,
            )
        except Exception:
            pass  # Already filled/closed


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
