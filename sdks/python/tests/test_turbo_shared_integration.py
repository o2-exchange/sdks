"""Live E2E test for shared orders and explicit Turbo execution.

The test creates a session (replacing any existing session on that account) and
places a small live order. ``TURBO_TEST_MARKET`` defaults to ``fwBTC/fUSDC``.
The execution test creates a separate temporary account and uses the testnet
faucet to seed a small opposing Turbo order.
"""

import asyncio
import math
import os
import warnings

import pytest

from o2_sdk import ChainInt, Network, O2Client, O2Error, OrderSide, OrderType
from o2_sdk.crypto import raw_sign
from o2_sdk.encoding import action_to_call, build_actions_signing_bytes
from o2_sdk.models import CancelOrderAction, CreateOrderAction, Id, Market, SettleBalanceAction

pytestmark = pytest.mark.integration

MAX_QUOTE_NOTIONAL = 5
INDEXER_ATTEMPTS = 30


def _same_id(left: object, right: object) -> bool:
    return str(left).removeprefix("0x").lower() == str(right).removeprefix("0x").lower()


def _minimum_quantity(market, price: int) -> tuple[int, int]:
    """Return the smallest valid base quantity and its quote notional."""
    base_unit = 10**market.base.decimals
    quantum = base_unit // math.gcd(price, base_unit)
    minimum = max(1, int(market.min_order))
    quantity = (minimum * base_unit + price - 1) // price
    quantity = ((quantity + quantum - 1) // quantum) * quantum
    market.validate_order(price, quantity)
    return quantity, price * quantity // base_unit


async def _depth(client: O2Client, market_id: str, *, turbo: bool = False, view: str = "demand"):
    params = {"market_id": market_id, "precision": 0}
    if turbo:
        params.update({"turbo": "true", "view": view})
    return await client.api._request("GET", "/v1/depth", params=params)


async def _indexed_order(client: O2Client, market_id: str, order_id: str):
    last_error = None
    for _ in range(INDEXER_ATTEMPTS):
        try:
            return await client.api.get_order(market_id, order_id)
        except O2Error as error:
            last_error = error
            await asyncio.sleep(1)
    raise AssertionError(f"Order {order_id} was not indexed: {last_error}")


async def _cancel_if_open(client: O2Client, session, market, order_id: str) -> None:
    try:
        order = await _indexed_order(client, str(market.market_id), order_id)
        if order.is_open:
            await client.cancel_order(market=market.pair, order_id=order_id, session=session)
    except Exception as error:
        warnings.warn(f"Could not cancel test order {order_id}: {error}", stacklevel=2)


@pytest.fixture(scope="module")
async def turbo_context():
    key = os.getenv("TURBO_TEST_KEY")
    if not key:
        pytest.skip("Set TURBO_TEST_KEY to run the live Turbo shared-order tests")

    client = O2Client(network=Network.TESTNET)
    try:
        wallet = client.load_wallet(key)
        account = await client.api.get_account(owner=wallet.b256_address)
        assert account.trade_account_id is not None, (
            "TURBO_TEST_KEY must belong to an existing funded testnet trading account"
        )

        pair = os.getenv("TURBO_TEST_MARKET", "fwBTC/fUSDC")
        markets = await client.get_markets()
        market = next((item for item in markets if item.pair == pair), None)
        assert market is not None, f"Testnet market {pair} is unavailable"

        sidecars = await client.api._request("GET", "/v1/markets", params={"turbo": "true"})
        sidecar = next(
            (
                item
                for item in sidecars.get("markets", [])
                if _same_id(item["market_id"], market.market_id)
            ),
            None,
        )
        if sidecar is None:
            pytest.skip(f"{pair} has no active Turbo sidecar")

        session = None

        async def get_session():
            nonlocal session
            if session is None:
                session = await client.create_session(wallet, [market.pair], expiry_days=1)
            return session

        yield client, account, market, sidecar, get_session
    finally:
        await client.close()


async def _available_balance(client: O2Client, account, asset_id: str) -> int:
    balance = await client.api.get_balance(
        asset_id=asset_id,
        contract=str(account.trade_account_id),
    )
    return int(balance.trading_account_balance)


async def _place_shared_order(client, session, market, side, price, quantity):
    actions = (
        client.actions_for(market)
        .settle_balance()
        .create_shared_order(side, ChainInt(price), ChainInt(quantity))
        .build()
    )
    result = await client.batch_actions([actions], collect_orders=True, session=session)
    assert result.tx_id, f"Shared order submission failed: {result.message}"
    assert result.orders and len(result.orders) == 1
    return result.orders[0]


async def _submit_turbo_action(client, session, sidecar, actions, *, collect_orders=False):
    """Test-only signed action directed to the sidecar, not a public SDK API."""
    wire = [action.to_dict() for action in actions]
    calls = [action_to_call(action, sidecar) for action in wire]
    nonce = await client._get_nonce(session.trade_account_id)
    signature = raw_sign(session.session_private_key, build_actions_signing_bytes(nonce, calls))
    request = {
        "actions": [
            {
                "market_id": sidecar["market_id"],
                "turbo": True,
                "actions": wire,
            }
        ],
        "signature": {"Secp256k1": "0x" + signature.hex()},
        "nonce": str(nonce),
        "trade_account_id": session.trade_account_id,
        "session_id": session.session_id.to_dict(),
        "collect_orders": collect_orders,
    }
    try:
        result = await client.api.submit_actions(session.owner_address, request)
    except O2Error:
        await client.refresh_nonce(session)
        raise
    client._nonce_cache[session.trade_account_id] = nonce + 1
    session.nonce = nonce + 1
    return result


async def _cancel_turbo_if_open(client, session, sidecar, order_id):
    try:
        for _ in range(INDEXER_ATTEMPTS):
            try:
                response = await client.api._request(
                    "GET",
                    "/v1/order",
                    params={
                        "market_id": sidecar["market_id"],
                        "turbo": "true",
                        "order_id": order_id,
                    },
                )
                if not response.get("order", response).get("close", False):
                    await _submit_turbo_action(
                        client, session, sidecar, [CancelOrderAction(order_id=Id(order_id))]
                    )
                return
            except O2Error:
                await asyncio.sleep(1)
        warnings.warn(f"Could not confirm state of Turbo test order {order_id}", stacklevel=2)
    except Exception as error:
        warnings.warn(f"Could not cancel Turbo test order {order_id}: {error}", stacklevel=2)


async def test_shared_post_only_order_rests_on_testnet(turbo_context):
    client, account, market, _, get_session = turbo_context
    canonical = await _depth(client, str(market.market_id))
    demand = await _depth(client, str(market.market_id), turbo=True)
    bids = canonical["orders"]["buys"]
    if not bids:
        pytest.skip("No public bid is available to select a conservative test price")

    tick = 10 ** (market.quote.decimals - market.quote.max_precision)
    best_bid = int(bids[0]["price"])
    best_turbo_ask = min(
        (int(level["price"]) for level in demand["orders"]["sells"]), default=best_bid
    )
    price = ((min(best_bid, best_turbo_ask) * 99 // 100) // tick) * tick
    if price <= 0:
        pytest.skip("No valid non-crossing test price")
    quantity, notional = _minimum_quantity(market, price)
    assert notional <= MAX_QUOTE_NOTIONAL * 10**market.quote.decimals, (
        "Minimum order value exceeds the live-test notional cap"
    )
    balance = await _available_balance(client, account, str(market.quote.asset))
    assert balance >= notional, f"Fund the test account with at least {notional} quote units"

    session = await get_session()
    order_id = None
    try:
        order = await _place_shared_order(client, session, market, OrderSide.BUY, price, quantity)
        order_id = str(order.order_id)
        assert order.order_type == "TurboSharedPostOnly"
        indexed = await _indexed_order(client, str(market.market_id), order_id)
        assert indexed.is_open
        assert indexed.order_type == "TurboSharedPostOnly"
    finally:
        if order_id is not None:
            await _cancel_if_open(client, session, market, order_id)


async def test_shared_order_executes_resting_turbo_liquidity(turbo_context):
    client, account, market, sidecar, get_session = turbo_context
    market_id = str(market.market_id)
    canonical = await _depth(client, market_id)
    best_public_bid = max((int(x["price"]) for x in canonical["orders"]["buys"]), default=0)
    best_public_ask = min((int(x["price"]) for x in canonical["orders"]["sells"]), default=2**64)
    if best_public_bid == 0 or best_public_ask == 2**64:
        pytest.skip("Both sides of the public book are needed for a non-crossing quote")
    tick = 10 ** (market.quote.decimals - market.quote.max_precision)
    price = ((best_public_bid + best_public_ask) // 2 // tick) * tick
    if not best_public_bid < price < best_public_ask:
        pytest.skip("Public spread is too narrow to seed a non-crossing quote")
    quantity, notional = _minimum_quantity(market, price)
    assert notional <= MAX_QUOTE_NOTIONAL * 10**market.quote.decimals, (
        "Minimum order value exceeds the live-test notional cap"
    )
    house_can_buy = await _available_balance(client, account, str(market.quote.asset)) >= notional
    house_can_sell = await _available_balance(client, account, str(market.base.asset)) >= quantity
    assert house_can_buy or house_can_sell, (
        "Fund the House test account before creating a counterparty"
    )

    counterparty = O2Client(network=Network.TESTNET)
    counterparty_session = None
    turbo_order_id = None
    source_id = None
    try:
        wallet = counterparty.generate_wallet()
        other_account = await counterparty.setup_account(wallet)
        assert other_account.trade_account_id is not None

        selected = None
        for _ in range(INDEXER_ATTEMPTS):
            for house_side, house_funded, other_asset, other_needed in (
                (OrderSide.BUY, house_can_buy, market.base.asset, quantity),
                (OrderSide.SELL, house_can_sell, market.quote.asset, notional),
            ):
                if (
                    house_funded
                    and await _available_balance(counterparty, other_account, str(other_asset))
                    >= other_needed
                ):
                    selected = house_side
                    break
            if selected is not None:
                break
            await asyncio.sleep(1)
        assert selected is not None, (
            "House account or faucet-funded counterparty lacks assets for a small Turbo fill"
        )
        side = selected
        other_side = OrderSide.SELL if side == OrderSide.BUY else OrderSide.BUY

        # Session authorization and signature both name the sidecar contract.
        counterparty_session = await counterparty.create_session(
            wallet, [Market.from_dict(sidecar)], expiry_days=1
        )
        seeded = await _submit_turbo_action(
            counterparty,
            counterparty_session,
            sidecar,
            [
                SettleBalanceAction(to=Id(counterparty_session.trade_account_id)),
                CreateOrderAction(
                    side=other_side,
                    price=str(price),
                    quantity=str(quantity),
                    order_type=OrderType.SPOT,
                ),
            ],
            collect_orders=True,
        )
        assert seeded.tx_id and seeded.orders and len(seeded.orders) == 1
        turbo_order_id = str(seeded.orders[0].order_id)

        for _ in range(INDEXER_ATTEMPTS):
            try:
                indexed = await counterparty.api._request(
                    "GET",
                    "/v1/order",
                    params={
                        "market_id": market_id,
                        "turbo": "true",
                        "order_id": turbo_order_id,
                    },
                )
                demand = await _depth(client, market_id, turbo=True)
                levels = demand["orders"]["sells" if other_side == OrderSide.SELL else "buys"]
                if not indexed.get("order", indexed).get("close", False) and any(
                    int(level["price"]) == price for level in levels
                ):
                    break
            except O2Error:
                pass
            await asyncio.sleep(1)
        else:
            raise AssertionError("Seeded Turbo order did not appear in demand depth")

        session = await get_session()
        source = await _place_shared_order(client, session, market, side, price, quantity)
        source_id = str(source.order_id)
        # The quote rests publicly while crossing Turbo liquidity awaits explicit execution.
        assert source.order_type == "PostOnly"
        before = await _indexed_order(client, market_id, source_id)
        assert before.is_open

        actions = (
            client.actions_for(market)
            .execute_turbo_orders(source_id, ChainInt(quantity), max_fills=1)
            .build()
        )
        result = await client.batch_actions([actions], collect_orders=True, session=session)
        assert result.tx_id
        assert result.orders, "Turbo execution produced no order"

        executed_id = str(result.orders[0].order_id)
        for _ in range(INDEXER_ATTEMPTS):
            try:
                executed = await client.api._request(
                    "GET",
                    "/v1/order",
                    params={"market_id": market_id, "turbo": "true", "order_id": executed_id},
                )
            except O2Error:
                await asyncio.sleep(1)
                continue
            funding_source = executed.get("order", {}).get("funding_source", {})
            if _same_id(funding_source.get("order_id"), source_id):
                break
            await asyncio.sleep(1)
        else:
            raise AssertionError("Executed Turbo order did not reference the shared source")

        for _ in range(INDEXER_ATTEMPTS):
            try:
                after = await client.api.get_order(market_id, source_id)
            except O2Error:
                await asyncio.sleep(1)
                continue
            if int(after.quantity_fill) > int(before.quantity_fill):
                break
            await asyncio.sleep(1)
        else:
            raise AssertionError("Shared source did not record a Turbo fill")
    finally:
        if source_id is not None:
            await _cancel_if_open(client, session, market, source_id)
        if turbo_order_id is not None and counterparty_session is not None:
            await _cancel_turbo_if_open(counterparty, counterparty_session, sidecar, turbo_order_id)
        await counterparty.close()
