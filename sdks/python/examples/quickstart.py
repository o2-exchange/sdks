"""Minimal end-to-end flow: generate wallet, setup account, place/cancel orders."""

import asyncio

from o2_sdk import Network, O2Client, OrderSide, OrderType


async def main():
    client = O2Client(network=Network.TESTNET)

    # 1. Generate a wallet
    owner = client.generate_wallet()
    print(f"Owner address: {owner.b256_address}")

    # 2. Setup account (creates account, funds via faucet, whitelists)
    account = await client.setup_account(owner)
    print(f"Trade account ID: {account.trade_account_id}")

    # 3. Get available markets
    markets = await client.get_markets()
    market = markets[0]
    print(f"Trading on: {market.pair}")

    # 4. Wait for faucet funds to arrive (may need multiple mints)
    print("Waiting for faucet funds...")
    await asyncio.sleep(5)

    # Optionally mint again to get more funds
    try:
        await asyncio.sleep(60)  # Faucet cooldown
        await client.api.mint_to_contract(account.trade_account_id)
        await asyncio.sleep(5)
    except Exception as e:
        print(f"Second mint: {e}")

    # 5. Create a trading session
    session = await client.create_session(
        owner=owner,
        markets=[market.pair],
        expiry_days=1,
    )
    print(f"Session created, expires: {session.session_expiry}")

    # 6. Place a spot buy order using high-level create_order
    depth = await client.get_depth(market.pair, precision=10)
    price = market.format_price(int(depth.best_ask.price)) * 0.5 if depth.best_ask else 0.01

    quantity = max(
        int(market.min_order) / market.scale_price(price) * 1.1,
        1.0,
    )

    print(f"Placing buy order: price={price}, quantity={quantity}")
    result = await client.create_order(
        session=session,
        market=market.pair,
        side=OrderSide.BUY,
        price=price,
        quantity=quantity,
        order_type=OrderType.SPOT,
        settle_first=True,
        collect_orders=True,
    )

    if result.success:
        print(f"Order placed! tx_id: {result.tx_id}")
        if result.orders:
            order = result.orders[0]
            print(f"Order ID: {order.order_id}")

            # 7. Check order status
            orders = await client.get_orders(account.trade_account_id, market.pair, is_open=True)
            print(f"Open orders: {len(orders)}")

            # 8. Build and submit a typed batch with the fluent builder
            batch = (
                client.actions_for(market)
                .settle_balance()
                .cancel_order(order.order_id)
                .create_order(OrderSide.BUY, "0.01", "1", OrderType.POST_ONLY)
                .build()
            )
            batch_result = await client.batch_actions(actions=[batch], session=session)
            print(f"Batch submitted: {batch_result.success}")
    else:
        print(f"Order failed: {result.message}")

    # 9. Check balances
    balances = await client.get_balances(account.trade_account_id)
    for symbol, balance in balances.items():
        print(f"  {symbol}: available={balance.trading_account_balance}")

    await client.close()
    print("Done!")


if __name__ == "__main__":
    asyncio.run(main())
