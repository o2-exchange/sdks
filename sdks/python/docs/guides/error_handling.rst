Error Handling Guide
====================

This guide covers error handling patterns for the O2 Python SDK.

.. seealso::

   For the complete error reference, see :doc:`../api/errors`.


Error hierarchy
---------------

All SDK errors inherit from :class:`~o2_sdk.errors.O2Error`:

.. code-block:: text

   O2Error
   ├── InternalError        (1000)
   ├── InvalidRequest       (1001)
   ├── ParseError           (1002)
   ├── RateLimitExceeded    (1003)
   ├── GeoRestricted        (1004)
   ├── MarketNotFound       (2000)
   ├── MarketPaused         (2001)
   ├── MarketAlreadyExists  (2002)
   ├── OrderNotFound        (3000)
   ├── OrderNotActive       (3001)
   ├── InvalidOrderParams   (3002)
   ├── InvalidSignature     (4000)
   ├── InvalidSession       (4001)
   ├── AccountNotFound      (4002)
   ├── WhitelistNotConfigured (4003)
   ├── TradeNotFound        (5000)
   ├── InvalidTradeCount    (5001)
   ├── AlreadySubscribed    (6000)
   ├── TooManySubscriptions (6001)
   ├── SubscriptionError    (6002)
   ├── InvalidAmount        (7000)
   ├── InvalidTimeRange     (7001)
   ├── InvalidPagination    (7002)
   ├── NoActionsProvided    (7003)
   ├── TooManyActions       (7004)
   ├── BlockNotFound        (8000)
   ├── EventsNotFound       (8001)
   ├── SessionExpired       (client-side)
   └── OnChainRevert        (on-chain)


Basic error handling
--------------------

.. code-block:: python

   from o2_sdk import O2Error, OrderSide

   try:
       result = await client.create_order(
           "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0
       )
   except O2Error as e:
       print(f"Error: {e.message} (code={e.code})")


Catching specific errors
-------------------------

.. code-block:: python

   from o2_sdk import (
       InvalidSignature,
       RateLimitExceeded,
       SessionExpired,
       OnChainRevert,
       AccountNotFound,
       O2Error,
   )

   try:
       result = await client.create_order(
           "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0
       )
   except SessionExpired:
       # The session has expired — create a new one
       session = await client.create_session(
           owner=owner, markets=["fFUEL/fUSDC"]
       )
       result = await client.create_order(
           "fFUEL/fUSDC", OrderSide.BUY, 0.02, 100.0
       )
   except InvalidSignature:
       # Signing verification failed — check your key/signer setup
       raise
   except AccountNotFound:
       # Account doesn't exist — set it up first
       account = await client.setup_account(owner)
       raise
   except OnChainRevert as e:
       # On-chain transaction reverted
       print(f"Revert: {e.message}")
       print(f"Reason: {e.reason}")  # e.g. "NotEnoughBalance"
   except O2Error as e:
       # Catch-all for any other O2 error
       print(f"Error {e.code}: {e.message}")


Rate limiting
--------------

The SDK automatically retries rate-limited requests (error code 1003)
with exponential backoff, up to 3 attempts. If all retries are exhausted,
:class:`~o2_sdk.errors.RateLimitExceeded` is raised:

.. code-block:: python

   import asyncio
   from o2_sdk import RateLimitExceeded

   try:
       result = await client.create_order(...)
   except RateLimitExceeded:
       # SDK already retried 3 times with backoff
       # Add additional delay if needed
       await asyncio.sleep(10)


On-chain reverts
-----------------

When a transaction is submitted successfully but reverts on-chain, the
SDK raises :class:`~o2_sdk.errors.OnChainRevert`. These errors have no
``code`` field but include a ``message`` and ``reason``:

.. code-block:: python

   from o2_sdk import OnChainRevert

   try:
       result = await client.create_order(...)
   except OnChainRevert as e:
       if e.reason == "NotEnoughBalance":
           # Need more funds
           pass
       elif e.reason == "TraderNotWhiteListed":
           # Re-whitelist
           await client.api.whitelist_account(session.trade_account_id)
       else:
           print(f"Revert: {e.reason}")

Common revert reasons:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Reason
     - Description
   * - ``NotEnoughBalance``
     - Insufficient funds for the operation.
   * - ``TraderNotWhiteListed``
     - The trading account is not whitelisted.
   * - ``InvalidPrice``
     - Price violates on-chain constraints.
   * - ``OrderNotFound``
     - The order to cancel does not exist.


Nonce errors
-------------

The on-chain nonce increments **even on reverted transactions**. The SDK
handles this automatically by calling
:meth:`~o2_sdk.client.O2Client.refresh_nonce` after any action failure.

If you manage nonces manually, always re-fetch after errors:

.. code-block:: python

   try:
       result = await client.batch_actions(actions)
   except O2Error:
       # Nonce was already refreshed by the SDK
       # The next call will use the correct nonce
       pass


Robust trading loop
--------------------

A production-grade pattern with error recovery:

.. code-block:: python

   import asyncio
   import os
   from o2_sdk import (
       O2Client, Network, O2Error, OrderSide, OrderType,
       SessionExpired, OnChainRevert, RateLimitExceeded,
   )

   async def trading_loop():
       client = O2Client(network=Network.MAINNET)
       owner = client.load_wallet(os.environ["O2_PRIVATE_KEY"])
       account = await client.setup_account(owner)
       session = await client.create_session(
           owner=owner, markets=["FUEL/USDC"]
       )

       while True:
           try:
               result = await client.create_order(
                   "FUEL/USDC", OrderSide.BUY, 0.02, 100.0,
                   order_type=OrderType.POST_ONLY,
               )
               print(f"Order placed: {result.tx_id}")

           except SessionExpired:
               session = await client.create_session(
                   owner=owner, markets=["FUEL/USDC"]
               )
               continue

           except RateLimitExceeded:
               await asyncio.sleep(10)
               continue

           except OnChainRevert as e:
               print(f"Revert: {e.reason}")
               if e.reason == "NotEnoughBalance":
                   break  # Stop trading
               await asyncio.sleep(5)
               continue

           except O2Error as e:
               print(f"Error: {e}")
               await asyncio.sleep(5)
               continue

           await asyncio.sleep(15)

       await client.close()
