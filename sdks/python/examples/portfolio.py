"""Balance monitoring and order tracking via WebSocket streams."""

import asyncio
import logging
import signal

from o2_sdk import O2Client, Network

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("portfolio")

PRIVATE_KEY = None  # Set to your owner private key hex, or None to generate
MARKET_PAIR = "fFUEL/fUSDC"


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
    trade_id = account.trade_account_id
    logger.info("Trade account: %s", trade_id)

    # Initial balance snapshot
    balances = await client.get_balances(trade_id)
    logger.info("=== Initial Balances ===")
    for symbol, bal in balances.items():
        logger.info(
            "  %s: available=%s locked=%s unlocked=%s",
            symbol,
            bal.trading_account_balance,
            bal.total_locked,
            bal.total_unlocked,
        )

    # Check open orders
    market = await client.get_market(MARKET_PAIR)
    orders = await client.get_orders(trade_id, market.pair, is_open=True)
    logger.info("=== Open Orders ===")
    for order in orders:
        logger.info(
            "  %s %s @ %s qty=%s/%s",
            order.side,
            market.pair,
            order.price,
            order.quantity_fill,
            order.quantity,
        )
    if not orders:
        logger.info("  (none)")

    # Trade history for P&L
    trades = await client.get_trades(market.pair, count=20)
    logger.info("=== Recent Trades ===")
    total_bought = 0
    total_sold = 0
    for trade in trades[:10]:
        logger.info(
            "  %s %s qty=%s @ %s total=%s",
            trade.side,
            market.pair,
            trade.quantity,
            trade.price,
            trade.total,
        )

    # Stream balance updates
    logger.info("=== Streaming balance updates (Ctrl+C to stop) ===")

    async def stream_balances():
        try:
            async for update in client.stream_balances(trade_id):
                for entry in update.balance:
                    asset_id = entry.get("asset_id", "?")
                    trading = entry.get("trading_account_balance", "0")
                    locked = entry.get("total_locked", "0")
                    unlocked = entry.get("total_unlocked", "0")
                    logger.info(
                        "Balance update: asset=%s available=%s locked=%s unlocked=%s",
                        asset_id[:18] + "...",
                        trading,
                        locked,
                        unlocked,
                    )
        except asyncio.CancelledError:
            return

    async def stream_orders_monitor():
        try:
            async for update in client.stream_orders(trade_id):
                for order in update.orders:
                    status = "OPEN"
                    if order.close:
                        status = "FILLED" if not order.cancel else "CANCELLED"
                    elif order.partially_filled:
                        status = "PARTIAL"
                    logger.info(
                        "Order update: %s %s %s @ %s [%s]",
                        order.side,
                        market.pair,
                        order.quantity,
                        order.price,
                        status,
                    )
        except asyncio.CancelledError:
            return

    balance_task = asyncio.create_task(stream_balances())
    orders_task = asyncio.create_task(stream_orders_monitor())

    await shutdown_event.wait()

    balance_task.cancel()
    orders_task.cancel()
    try:
        await balance_task
    except asyncio.CancelledError:
        pass
    try:
        await orders_task
    except asyncio.CancelledError:
        pass

    await client.close()
    logger.info("Portfolio monitor stopped")


if __name__ == "__main__":
    asyncio.run(main())
