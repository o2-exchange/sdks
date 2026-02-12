Market Data Guide
=================

This guide covers how to fetch market data from the O2 Exchange using
the Python SDK.

.. seealso::

   For real-time streaming, see :doc:`websocket_streams`. For complete
   method signatures, see :doc:`../api/client`.


Listing markets
---------------

.. code-block:: python

   markets = await client.get_markets()
   for m in markets:
       print(f"{m.pair}: base={m.base.symbol} ({m.base.decimals} decimals)")

   # Get a specific market
   market = await client.get_market("fFUEL/fUSDC")
   print(f"Min order: {market.min_order}")
   print(f"Maker fee: {market.maker_fee}")


Order book depth
-----------------

Fetch a snapshot of the order book:

.. code-block:: python

   depth = await client.get_depth("fFUEL/fUSDC", precision=10)

   print(f"Best bid: {depth.best_bid.price if depth.best_bid else 'empty'}")
   print(f"Best ask: {depth.best_ask.price if depth.best_ask else 'empty'}")

   # Iterate price levels
   for level in depth.buys[:5]:
       print(f"  BID {level.price} x {level.quantity}")
   for level in depth.sells[:5]:
       print(f"  ASK {level.price} x {level.quantity}")

The ``precision`` parameter controls price aggregation — lower values
produce fewer, wider price levels.


Recent trades
--------------

.. code-block:: python

   trades = await client.get_trades("fFUEL/fUSDC", count=20)
   for trade in trades:
       print(f"{trade.side} {trade.quantity} @ {trade.price} (id={trade.trade_id})")


OHLCV candles
--------------

.. code-block:: python

   import time

   now = int(time.time())
   bars = await client.get_bars(
       "fFUEL/fUSDC",
       resolution="1h",
       from_ts=now - 86400,  # last 24 hours
       to_ts=now,
   )

   for bar in bars:
       print(
           f"{bar.time}: O={bar.open} H={bar.high} "
           f"L={bar.low} C={bar.close} V={bar.volume}"
       )

Supported resolutions: ``"1m"``, ``"5m"``, ``"15m"``, ``"30m"``,
``"1h"``, ``"4h"``, ``"1d"``, ``"1w"``.


Ticker data
-----------

.. code-block:: python

   ticker = await client.get_ticker("fFUEL/fUSDC")
   print(ticker)  # Raw dict with current market stats


Price conversion
-----------------

Market data is returned in on-chain integer format. Use the
:class:`~o2_sdk.models.Market` helper methods to convert to/from
human-readable floats:

.. code-block:: python

   market = await client.get_market("fFUEL/fUSDC")
   depth = await client.get_depth("fFUEL/fUSDC")

   if depth.best_ask:
       chain_price = int(depth.best_ask.price)
       human_price = market.format_price(chain_price)
       print(f"Best ask: {human_price}")


Balances
--------

.. code-block:: python

   balances = await client.get_balances(account)
   for symbol, bal in balances.items():
       print(f"{symbol}:")
       print(f"  Trading account: {bal.trading_account_balance}")
       print(f"  Locked in orders: {bal.total_locked}")
       print(f"  Unlocked: {bal.total_unlocked}")


Aggregated endpoints
--------------------

The O2 API also provides aggregated market data in a format compatible
with standard crypto data aggregators. These are available on the
low-level :class:`~o2_sdk.api.O2Api` client:

.. code-block:: python

   # Aggregated assets
   assets = await client.api.get_aggregated_assets()

   # Aggregated order book
   book = await client.api.get_aggregated_orderbook("FUEL_USDC")

   # Market summaries
   summaries = await client.api.get_aggregated_summary()

   # All tickers
   tickers = await client.api.get_aggregated_ticker()
