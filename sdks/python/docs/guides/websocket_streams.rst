WebSocket Streams Guide
=======================

The O2 Exchange provides real-time data streams via WebSocket. The SDK
exposes these as ``async for`` iterators on the
:class:`~o2_sdk.client.O2Client`.

.. seealso::

   The O2 WebSocket protocol is documented at `<https://docs.o2.app>`_.


Overview
--------

All streaming methods:

- Return an :class:`~collections.abc.AsyncIterator` of typed update objects.
- Automatically connect the WebSocket on first use.
- Support automatic reconnection with exponential backoff.
- Re-subscribe to channels on reconnect.


Order book depth
-----------------

Stream real-time order book updates:

.. code-block:: python

   async for update in client.stream_depth("fFUEL/fUSDC", precision=10):
       if update.is_snapshot:
           # First message is a full snapshot
           print(f"Snapshot: {len(update.changes.buys)} bids, {len(update.changes.sells)} asks")
       else:
           # Subsequent messages are incremental updates
           if update.changes.best_bid:
               print(f"Best bid: {update.changes.best_bid.price}")
           if update.changes.best_ask:
               print(f"Best ask: {update.changes.best_ask.price}")

The ``precision`` parameter controls price aggregation, matching the
REST :meth:`~o2_sdk.client.O2Client.get_depth` endpoint.


Order updates
--------------

Monitor your orders in real time:

.. code-block:: python

   async for update in client.stream_orders(account):
       for order in update.orders:
           status = "OPEN" if order.is_open else "CLOSED"
           filled = f"{order.quantity_fill}/{order.quantity}"
           print(f"[{status}] {order.side} {order.order_id}: {filled}")
           if order.cancel:
               print(f"  Canceled")


Trade feed
----------

Stream all trades for a market:

.. code-block:: python

   async for update in client.stream_trades("fFUEL/fUSDC"):
       for trade in update.trades:
           print(f"{trade.side} {trade.quantity} @ {trade.price}")


Balance updates
----------------

Monitor balance changes in real time:

.. code-block:: python

   async for update in client.stream_balances(account):
       for entry in update.balance:
           print(f"Balance change: {entry}")


Nonce monitoring
-----------------

Useful for detecting nonce changes from other sessions or external
transactions:

.. code-block:: python

   async for update in client.stream_nonce(account):
       print(f"Nonce changed: {update.nonce} (account={update.contract_id})")


Running multiple streams
------------------------

Use :func:`asyncio.gather` or task groups to run multiple streams
concurrently:

.. code-block:: python

   import asyncio

   async def watch_depth():
       async for update in client.stream_depth("fFUEL/fUSDC"):
           if update.changes.best_bid:
               print(f"Best bid: {update.changes.best_bid.price}")

   async def watch_orders():
       async for update in client.stream_orders(account):
           for order in update.orders:
               print(f"Order {order.order_id}: {'open' if order.is_open else 'closed'}")

   async def watch_trades():
       async for update in client.stream_trades("fFUEL/fUSDC"):
           for trade in update.trades:
               print(f"Trade: {trade.quantity} @ {trade.price}")

   # Run all streams concurrently
   await asyncio.gather(
       watch_depth(),
       watch_orders(),
       watch_trades(),
   )

.. note::

   All streams share a single WebSocket connection, managed internally by
   the :class:`~o2_sdk.websocket.O2WebSocket` client.


Graceful shutdown
-----------------

Always close the client when done to cleanly disconnect the WebSocket:

.. code-block:: python

   await client.close()

Or use the async context manager:

.. code-block:: python

   async with O2Client(network=Network.TESTNET) as client:
       async for update in client.stream_depth("fFUEL/fUSDC"):
           ...
