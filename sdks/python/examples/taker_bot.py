"""WebSocket-driven taker/sniper bot for the O2 Exchange.

Monitors order book depth via WebSocket and executes BoundedMarket orders
when price crosses a configurable threshold.
"""

import asyncio
import logging
import signal

from o2_sdk import BoundedMarketOrder, Network, O2Client, OrderSide

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("taker_bot")

# Configuration
PRIVATE_KEY = None  # Set to your owner private key hex, or None to generate
MARKET_PAIR = "FUEL/USDC"
BUY_BELOW_PRICE = 0.020  # Buy when best ask drops below this price
MAX_QUANTITY = 50.0  # Maximum quantity per trade
SLIPPAGE_PCT = 0.005  # 0.5% slippage tolerance


async def main():
    client = O2Client(network=Network.TESTNET)
    shutdown_event = asyncio.Event()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: shutdown_event.set())

    # Setup
    if PRIVATE_KEY:
        owner = client.load_wallet(PRIVATE_KEY)
    else:
        owner = client.generate_wallet()
        logger.info("Generated wallet: %s", owner.b256_address)

    account = await client.setup_account(owner)
    logger.info("Trade account: %s", account.trade_account_id)

    market = await client.get_market(MARKET_PAIR)
    logger.info("Monitoring: %s", market.pair)

    session = await client.create_session(owner=owner, markets=[market.pair], expiry_days=7)

    # Wait for funds
    await asyncio.sleep(5)

    logger.info("Watching for asks below %.6f...", BUY_BELOW_PRICE)

    try:
        async for update in client.stream_depth(market.pair, precision=1):
            if shutdown_event.is_set():
                break

            best_ask = update.changes.best_ask
            if not best_ask:
                continue

            ask_price = market.format_price(int(best_ask.price))
            logger.debug("Best ask: %.6f", ask_price)

            if ask_price <= BUY_BELOW_PRICE:
                logger.info("Price %.6f <= %.6f, executing buy!", ask_price, BUY_BELOW_PRICE)

                max_price = ask_price * (1 + SLIPPAGE_PCT)
                quantity = min(
                    MAX_QUANTITY,
                    market.format_quantity(int(best_ask.quantity)),
                )

                try:
                    result = await client.create_order(
                        session=session,
                        market=market.pair,
                        side=OrderSide.BUY,
                        price=ask_price,
                        quantity=quantity,
                        order_type=BoundedMarketOrder(
                            max_price=max_price,
                            min_price=0.0,
                        ),
                        settle_first=True,
                        collect_orders=True,
                    )

                    if result.success:
                        logger.info("Buy executed! tx: %s", result.tx_id)
                        if result.orders:
                            for order in result.orders:
                                logger.info(
                                    "  %s %s @ %s qty=%s",
                                    order.side,
                                    market.pair,
                                    order.price,
                                    order.quantity,
                                )
                    else:
                        logger.error("Buy failed: %s", result.message)

                except Exception as e:
                    logger.error("Trade error: %s", e)
                    await client.refresh_nonce(session)

    finally:
        await client.close()
        logger.info("Taker bot stopped")


if __name__ == "__main__":
    asyncio.run(main())
