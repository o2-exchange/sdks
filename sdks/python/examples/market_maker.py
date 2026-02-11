"""Full market maker bot for the O2 Exchange.

Implements the market maker skeleton from the O2 integration guide:
- Places symmetric buy/sell orders around a reference price
- Cancels stale orders and replaces atomically each cycle
- Uses WebSocket for real-time order fill tracking
- Handles filled-order detection (skip cancel for closed orders)
- Atomic cancel+settle+replace pattern (5 actions per batch)
"""

import asyncio
import contextlib
import logging
import signal

from o2_sdk import Network, O2Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("market_maker")

# Configuration
PRIVATE_KEY = None  # Set to your owner private key hex, or None to generate
MARKET_PAIR = "fFUEL/fUSDC"
SPREAD_PCT = 0.02  # 2% spread
ORDER_SIZE_USD = 2.0  # USD value per side
CYCLE_INTERVAL = 15  # seconds between cycles
REFERENCE_PRICE = 0.025  # Fallback reference price


async def main():
    client = O2Client(network=Network.TESTNET)
    shutdown_event = asyncio.Event()

    def handle_signal():
        logger.info("Shutdown signal received")
        shutdown_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    # Setup wallet
    if PRIVATE_KEY:
        owner = client.load_wallet(PRIVATE_KEY)
    else:
        owner = client.generate_wallet()
        logger.info("Generated wallet: %s", owner.b256_address)

    # Setup account (idempotent)
    account = await client.setup_account(owner)
    logger.info("Trade account: %s", account.trade_account_id)

    # Get market info
    market = await client.get_market(MARKET_PAIR)
    logger.info("Market: %s (contract: %s)", market.pair, market.contract_id)

    # Create session
    session = await client.create_session(owner=owner, markets=[market.pair], expiry_days=7)
    logger.info("Session created, expires: %s", session.session_expiry)

    # Track active orders
    active_buy_id = None
    active_sell_id = None

    # Start WebSocket order monitoring in background
    filled_orders: set[str] = set()

    async def monitor_orders():
        try:
            async for update in client.stream_orders(account.trade_account_id):
                for order in update.orders:
                    if order.close:
                        filled_orders.add(order.order_id)
                        logger.info("Order %s closed (filled/cancelled)", order.order_id)
        except asyncio.CancelledError:
            return

    monitor_task = asyncio.create_task(monitor_orders())

    try:
        while not shutdown_event.is_set():
            try:
                # 1. Get reference price (use depth or fallback)
                ref_price = REFERENCE_PRICE
                try:
                    depth = await client.get_depth(market.pair, precision=10)
                    if depth.best_bid and depth.best_ask:
                        bid = market.format_price(int(depth.best_bid.price))
                        ask = market.format_price(int(depth.best_ask.price))
                        ref_price = (bid + ask) / 2
                        logger.info("Mid price: %.6f", ref_price)
                except Exception:
                    pass

                # 2. Calculate spread prices
                buy_price = ref_price * (1 - SPREAD_PCT)
                sell_price = ref_price * (1 + SPREAD_PCT)

                # 3. Calculate quantity
                quantity = ORDER_SIZE_USD / ref_price

                # 4. Build actions
                actions_list = []

                # Cancel stale orders (skip if filled)
                if active_buy_id and active_buy_id not in filled_orders:
                    actions_list.append({"CancelOrder": {"order_id": active_buy_id}})
                if active_sell_id and active_sell_id not in filled_orders:
                    actions_list.append({"CancelOrder": {"order_id": active_sell_id}})

                # Settle
                actions_list.append(
                    {"SettleBalance": {"to": {"ContractId": session.trade_account_id}}}
                )

                # Place new orders
                scaled_buy_price = market.scale_price(buy_price)
                scaled_sell_price = market.scale_price(sell_price)
                scaled_quantity = market.scale_quantity(quantity)
                scaled_quantity = market.adjust_quantity(scaled_buy_price, scaled_quantity)

                actions_list.append(
                    {
                        "CreateOrder": {
                            "side": "Buy",
                            "price": str(scaled_buy_price),
                            "quantity": str(scaled_quantity),
                            "order_type": "Spot",
                        }
                    }
                )

                scaled_sell_qty = market.adjust_quantity(scaled_sell_price, scaled_quantity)
                actions_list.append(
                    {
                        "CreateOrder": {
                            "side": "Sell",
                            "price": str(scaled_sell_price),
                            "quantity": str(scaled_sell_qty),
                            "order_type": "Spot",
                        }
                    }
                )

                # Limit to 5 actions
                actions_list = actions_list[:5]

                # 5. Submit
                result = await client.batch_actions(
                    session=session,
                    actions=[{"market_id": market.market_id, "actions": actions_list}],
                    collect_orders=True,
                )

                if result.success:
                    logger.info("Cycle complete, tx: %s", result.tx_id)
                    active_buy_id = None
                    active_sell_id = None
                    filled_orders.clear()
                    if result.orders:
                        for order in result.orders:
                            if order.side == "Buy":
                                active_buy_id = order.order_id
                            else:
                                active_sell_id = order.order_id
                        logger.info("Buy: %s, Sell: %s", active_buy_id, active_sell_id)
                else:
                    logger.error("Cycle failed: %s", result.message)
                    # Re-fetch nonce on failure
                    await client.refresh_nonce(session)

            except Exception as e:
                logger.error("Cycle error: %s", e)
                await client.refresh_nonce(session)

            # Wait for next cycle
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=CYCLE_INTERVAL)
                break
            except asyncio.TimeoutError:
                pass

    finally:
        monitor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await monitor_task
        await client.close()
        logger.info("Market maker stopped")


if __name__ == "__main__":
    asyncio.run(main())
