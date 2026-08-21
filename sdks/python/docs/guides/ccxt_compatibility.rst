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
     - Limit and bounded FOK market
     - Market orders require ``maxPrice`` and ``minPrice``
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

The adapter executes this as an O2 ``FillOrKill`` at ``maxPrice`` for buys or
``minPrice`` for sells. The complete amount must fill within the bound; no
residual market order is left resting.
If the optional CCXT ``price`` argument is supplied, it must fall between
``minPrice`` and ``maxPrice`` and cannot bypass the configured protection.

O2 matching is asynchronous. The create response may initially have
``status="open"``; poll ``fetch_order(order["id"], symbol)`` until it becomes
closed or canceled before treating execution as final. Because the indexed
native order is an O2 FOK, a later fetch currently reports ``type="limit"`` and
``timeInForce="FOK"``. This create/fetch type difference is an alpha limitation.

All network methods are async. Normalized dictionaries retain a JSON-compatible
representation of their parsed O2 model under ``info``, so complete responses
can be passed directly to ``json.dumps``. Prices, quantities, balances, and
timestamps follow CCXT units and shapes. ``total_unlocked`` maps to ``free`` and
already includes the trading-account balance, so it is not counted twice.

Gotchas and known gaps
----------------------

* This is an O2-maintained public alpha, not an upstream ``ccxt.o2`` exchange.
  The adapter has passed limit and bounded-market lifecycle and soak testing on
  O2 testnet, but it has not been certified by CCXT or production-canary tested
  on mainnet. Start with capped balances and independent risk limits.
* Python support is async-only and extends ``ccxt.async_support.Exchange``.
  There is no synchronous facade in the alpha.
* A CCXT ``market`` order is a price-protected native O2 FOK order, not an
  unbounded market order. Both ``maxPrice`` and ``minPrice`` are required;
  ``maxPrice`` protects a buy and ``minPrice`` protects a sell. The whole amount
  fills inside the bound or the order fails.
* Matching and API indexing are asynchronous. A successful create can initially
  appear open, and a created, filled, or canceled order may not be visible to a
  read immediately. Poll ``fetch_order(id, symbol)`` with bounded backoff before
  deciding the final state. A temporary missing or stale read is not proof that
  a private submission failed.
* The immediate response for a bounded market order reports ``type="market"``;
  a later indexed fetch reports its native representation as ``type="limit"``
  with ``timeInForce="FOK"``.
* The adapter never retries a private submission. A timeout or lost response can
  leave the outcome unknown even if O2 accepted it. On
  ``O2AmbiguousSubmission``, reconcile orders and the account nonce before
  taking another action; never blindly submit the same order again.
* Account setup and session creation are explicit. Restore a saved session when
  possible, and keep its expiry and permitted markets in mind. ``create_order``
  defaults ``settleFirst`` to ``True``, which may add a settlement action and
  latency before order placement.
* Check a restored session's permitted contract IDs before submitting. Testnet
  currently reports some unauthorized-market actions only as a generic
  ``FAILED_REQUIRE`` revert, so the adapter must surface ``ExchangeError`` when
  O2 provides no semantic session error to map more precisely.
* CCXT results use Python ``float`` values; native chain accounting uses scaled
  integers and ``Decimal`` values. Use CCXT precision helpers before submission,
  and use ``info`` or the native SDK when exact amounts are required for
  accounting.
* ``since`` and ``limit`` are accepted where CCXT expects them, but the adapter
  does not automatically paginate unlimited history. Trade requests are capped
  at 50 results per market, and multi-market results are bounded snapshots.
* Complete ticker statistics, market fee schedules, and per-result fee data are
  not currently available. Unsupported normalized fields are ``None``; do not
  use them as the sole source for fee or P&L accounting.
* ``fetch_order`` and ``cancel_order`` require ``symbol``. Self-trades are
  returned once with ``side=None``, with both-side information retained in
  ``info``.
* CCXT Pro ``watch*``, unified deposit, and unified transfer methods are not
  implemented. Use native O2 streams and account methods, and always await
  ``close()`` when finished to release client resources.

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

The limit-order create/fetch/cancel lifecycle and a bounded FOK market fill against
controlled liquidity are verified through this Python adapter on O2 testnet.
Live CCXT tests require ``O2_INTEGRATION=1`` in addition to selecting the
``integration`` marker, preventing an ordinary adapter test run from placing
orders.
