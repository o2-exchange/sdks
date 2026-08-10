CCXT-Compatible API (Public Alpha)
==================================

The Python SDK includes an asynchronous exchange class that extends the
official ``ccxt.async_support.Exchange`` base class and returns CCXT unified
response shapes. It is maintained by O2 and is not registered as ``ccxt.o2``.

Install the optional dependency:

.. code-block:: console

   pip install "o2-sdk[ccxt]"

Importing ``o2_sdk`` does not import or require CCXT. Only the
``o2_sdk.ccxt`` entry point requires the optional extra.

.. warning::

   This is a public alpha. Validate trading with small amounts on testnet
   before using the adapter with production funds.

Setup
-----

Account setup and session creation are explicit O2 extensions. The constructor
never performs an on-chain operation.

.. code-block:: python

   import asyncio
   import os

   from o2_sdk.ccxt import O2CCXT

   async def main():
       exchange = O2CCXT({
           "network": "testnet",
           "privateKey": os.environ["O2_PRIVATE_KEY"],
       })
       try:
           await exchange.setup_account()
           await exchange.create_session(["fFUEL/fUSDC"])
           await exchange.load_markets()

           book = await exchange.fetch_order_book("fFUEL/fUSDC", 20)
           print(book["bids"][0], book["asks"][0])

           order = await exchange.create_order(
               "fFUEL/fUSDC",
               "limit",
               "buy",
               50,
               0.02,
               {"orderType": "PostOnly"},
           )
           print(order["id"], order["status"])
       finally:
           await exchange.close()

   asyncio.run(main())

An existing ``O2Client``, external signer, trade-account ID, or restored
``SessionInfo`` can be injected through the constructor. Signing, encoding,
session state, and nonce management remain owned by the native O2 client.

Method coverage
---------------

.. list-table::
   :header-rows: 1
   :widths: 35 20 45

   * - Unified method
     - Status
     - Notes
   * - ``load_markets``, ``fetch_markets``
     - Supported
     - Spot markets only
   * - ``fetch_order_book``, ``fetch_l2_order_book``
     - Supported
     - ``params["precision"]`` accepts O2 levels 1--18
   * - ``fetch_trades``, ``fetch_ticker``, ``fetch_ohlcv``
     - Supported
     - Trade pages are limited to 50; incomplete ticker fields are ``None``
   * - ``fetch_balance``
     - Supported
     - Requires a trade account or active session
   * - ``create_order``
     - Limit and bounded market
     - Bounded market orders require ``maxPrice`` and ``minPrice``
   * - ``fetch_order``, ``fetch_orders``, open/closed orders
     - Supported
     - A single-order lookup requires ``symbol``
   * - ``cancel_order``, ``cancel_all_orders``
     - Supported
     - Cancel-all may span loaded markets
   * - ``fetch_my_trades``
     - Supported
     - Self-trades return one item with ``side=None``
   * - ``withdraw``
     - Supported
     - Requires the owner signer
   * - CCXT Pro ``watch*`` methods
     - Not supported
     - Use native O2 ``stream_*`` methods

Bounded market orders
---------------------

O2 does not submit unbounded market orders. Both price bounds are required:

.. code-block:: python

   order = await exchange.create_order(
       "fFUEL/fUSDC",
       "market",
       "sell",
       25,
       None,
       {"maxPrice": 0.031, "minPrice": 0.029},
   )

All network methods are async. Normalized dictionaries retain a JSON-compatible
representation of their parsed O2 model under ``info``, so complete responses
can be passed directly to ``json.dumps``. Prices, quantities, balances, and
timestamps follow CCXT units and shapes. ``total_unlocked`` maps to ``free`` and
already includes the trading-account balance, so it is not counted twice.

O2 extensions
-------------

The adapter adds ``setup_account``, ``create_session``, ``restore_session``,
``settle_balance``, and ``batch_actions``. ``withdraw`` uses the standard CCXT
signature.

Errors and retries
------------------

The adapter raises official CCXT errors, including ``AuthenticationError``,
``InsufficientFunds``, ``InvalidOrder``, ``BadSymbol``,
``RateLimitExceeded``, ``OrderNotFound``, and ``NetworkError``.

``O2AmbiguousSubmission`` is an ``OperationFailed`` and means a private request
may have been accepted without a usable response. The adapter never retries
that request. Reconcile orders and the account nonce before submitting again.
The native exception is retained as ``original_error``.

The limit-order create/fetch/cancel lifecycle and a bounded-market fill against
controlled liquidity are verified through this Python adapter on O2 testnet.
Live CCXT tests require ``O2_INTEGRATION=1`` in addition to selecting the
``integration`` marker, preventing an ordinary adapter test run from placing
orders.
