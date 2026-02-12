Trading Guide
=============

This guide covers common trading patterns using the O2 Python SDK.

.. seealso::

   For complete method signatures, see :doc:`../api/client`.


Order types
-----------

The O2 Exchange supports six order types, specified via the ``order_type``
parameter of :meth:`~o2_sdk.client.O2Client.create_order`. Simple types use
the :class:`~o2_sdk.models.OrderType` enum, while ``Limit`` and
``BoundedMarket`` use dedicated dataclasses.

.. code-block:: python

   from o2_sdk import OrderSide, OrderType, LimitOrder, BoundedMarketOrder

**Spot** (default)
   A standard limit order that rests on the book if not immediately filled.

   .. code-block:: python

      await client.create_order(session, "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0)

**PostOnly**
   Guaranteed to be a maker order. Rejected immediately if it would cross
   the spread and match an existing order.

   .. code-block:: python

      await client.create_order(
          session, "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0,
          order_type=OrderType.POST_ONLY,
      )

**Market**
   Executes immediately at the best available price. Fails if the order
   book is empty.

   .. code-block:: python

      await client.create_order(
          session, "fFUEL/fUSDC", OrderSide.BUY, 0.03, 100.0,
          order_type=OrderType.MARKET,
      )

**FillOrKill**
   Must be filled entirely in a single match, or the entire order is
   rejected.

   .. code-block:: python

      await client.create_order(
          session, "fFUEL/fUSDC", OrderSide.BUY, 0.03, 100.0,
          order_type=OrderType.FILL_OR_KILL,
      )

**Limit**
   Like Spot, but includes a limit price and timestamp for time-in-force
   semantics. Use the :class:`~o2_sdk.models.LimitOrder` class:

   .. code-block:: python

      import time

      await client.create_order(
          session, "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0,
          order_type=LimitOrder(price=0.025, timestamp=int(time.time())),
      )

**BoundedMarket**
   A market order with price bounds — executes at market price but only
   within the specified range. Use the
   :class:`~o2_sdk.models.BoundedMarketOrder` class:

   .. code-block:: python

      await client.create_order(
          session, "fFUEL/fUSDC", OrderSide.BUY, 0.025, 100.0,
          order_type=BoundedMarketOrder(max_price=0.03, min_price=0.01),
      )


Cancel and replace
-------------------

To cancel an existing order and place a new one:

.. code-block:: python

   # Cancel by order ID
   await client.cancel_order(session, order_id="0xabc...", market="fFUEL/fUSDC")

   # Cancel all open orders
   await client.cancel_all_orders(session, "fFUEL/fUSDC")

To atomically cancel-and-replace in a single transaction, use
:meth:`~o2_sdk.client.O2Client.batch_actions` with typed action objects:

.. code-block:: python

   from o2_sdk import (
       CancelOrderAction, CreateOrderAction, SettleBalanceAction,
       MarketActions, OrderSide, OrderType,
   )

   result = await client.batch_actions(
       session,
       actions=[MarketActions(
           market_id=market.market_id,
           actions=[
               CancelOrderAction(order_id=old_order_id),
               SettleBalanceAction(to=session.trade_account_id),
               CreateOrderAction(
                   side=OrderSide.BUY,
                   price=str(new_price),
                   quantity=str(new_qty),
                   order_type=OrderType.SPOT,
               ),
           ],
       )],
       collect_orders=True,
   )

.. important::

   When using :meth:`~o2_sdk.client.O2Client.batch_actions`, prices and
   quantities in :class:`~o2_sdk.models.CreateOrderAction` must be
   **pre-scaled on-chain integers** (as strings). Use
   :meth:`~o2_sdk.models.Market.scale_price` and
   :meth:`~o2_sdk.models.Market.scale_quantity` to convert from
   human-readable values.


Settling balances
-----------------

When your orders are filled, the proceeds remain locked in the order book
contract until they are settled back to your trading account.

:meth:`~o2_sdk.client.O2Client.create_order` handles this automatically
when ``settle_first=True`` (the default). You can also settle manually:

.. code-block:: python

   await client.settle_balance(session, "fFUEL/fUSDC")


Market maker pattern
---------------------

A simple two-sided quoting loop using typed actions:

.. code-block:: python

   import asyncio
   from o2_sdk import (
       CancelOrderAction, CreateOrderAction, SettleBalanceAction,
       MarketActions, OrderSide, OrderType,
   )

   market = await client.get_market("fFUEL/fUSDC")
   spread = 0.001
   qty = 50.0
   active_buy = None
   active_sell = None

   while True:
       # Get current mid price
       depth = await client.get_depth("fFUEL/fUSDC")
       if depth.best_bid and depth.best_ask:
           mid = (float(depth.best_bid.price) + float(depth.best_ask.price)) / 2
           mid = market.format_price(int(mid))
       else:
           await asyncio.sleep(5)
           continue

       buy_price = mid - spread / 2
       sell_price = mid + spread / 2

       # Build batch: cancel old + settle + place new
       actions = []
       if active_buy:
           actions.append(CancelOrderAction(order_id=active_buy))
       if active_sell:
           actions.append(CancelOrderAction(order_id=active_sell))
       actions.append(SettleBalanceAction(to=session.trade_account_id))
       actions.append(CreateOrderAction(
           side=OrderSide.BUY,
           price=str(market.scale_price(buy_price)),
           quantity=str(market.scale_quantity(qty)),
           order_type=OrderType.POST_ONLY,
       ))
       actions.append(CreateOrderAction(
           side=OrderSide.SELL,
           price=str(market.scale_price(sell_price)),
           quantity=str(market.scale_quantity(qty)),
           order_type=OrderType.POST_ONLY,
       ))

       result = await client.batch_actions(
           session,
           [MarketActions(market_id=market.market_id, actions=actions)],
           collect_orders=True,
       )

       if result.orders:
           active_buy = result.orders[0].order_id if len(result.orders) > 0 else None
           active_sell = result.orders[1].order_id if len(result.orders) > 1 else None

       await asyncio.sleep(15)


Order monitoring
-----------------

Query order status:

.. code-block:: python

   # All orders for an account
   orders = await client.get_orders(account, "fFUEL/fUSDC")

   # Open orders only
   open_orders = await client.get_orders(account, "fFUEL/fUSDC", is_open=True)

   # Single order by ID
   order = await client.get_order("fFUEL/fUSDC", order_id="0xabc...")
   print(f"Status: {'open' if order.is_open else 'closed'}")
   print(f"Filled: {order.quantity_fill} / {order.quantity}")

For real-time order updates, use :meth:`~o2_sdk.client.O2Client.stream_orders`:

.. code-block:: python

   async for update in client.stream_orders(account):
       for order in update.orders:
           print(f"Order {order.order_id}: {'open' if order.is_open else 'closed'}")


Withdrawals
-----------

Withdraw funds from the trading account:

.. code-block:: python

   result = await client.withdraw(owner=owner, asset="fUSDC", amount=10.0)
   if result.success:
       print(f"Withdrawal tx: {result.tx_id}")

.. note::

   Withdrawals require the **owner** key (not the session key) and use
   ``personalSign``.
