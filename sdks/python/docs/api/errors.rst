``errors`` — Error types
========================

.. module:: o2_sdk.errors
   :synopsis: Error types for O2 Exchange API responses.

All errors raised by the SDK are subclasses of :class:`O2Error`. The error
hierarchy maps directly to the error codes defined in the
`O2 Exchange API <https://docs.o2.app>`_.


Base exception
--------------

.. class:: O2Error(message, code=None, reason=None, receipts=None)

   Base exception for all O2 Exchange API errors.

   :param message: Human-readable error description.
   :type message: str
   :param code: Numeric error code (see table below), or ``None`` for
       on-chain reverts.
   :type code: int | None
   :param reason: On-chain revert reason string.
   :type reason: str | None
   :param receipts: Raw transaction receipts (for on-chain errors).
   :type receipts: list | None

   .. attribute:: message
      :type: str

   .. attribute:: code
      :type: int | None

   .. attribute:: reason
      :type: str | None

   .. attribute:: receipts
      :type: list | None


Error code reference
--------------------

.. list-table::
   :header-rows: 1
   :widths: 10 25 30 35

   * - Code
     - Exception class
     - Category
     - Recovery strategy
   * - 1000
     - :class:`InternalError`
     - General
     - Retry with exponential backoff.
   * - 1001
     - :class:`InvalidRequest`
     - General
     - Fix the request format.
   * - 1002
     - :class:`ParseError`
     - General
     - Fix the request body.
   * - 1003
     - :class:`RateLimitExceeded`
     - General
     - Wait 3–5 seconds, then retry. The SDK handles this automatically
       with up to 3 retries.
   * - 1004
     - :class:`GeoRestricted`
     - General
     - Region not allowed.
   * - 2000
     - :class:`MarketNotFound`
     - Market
     - Verify the market ID or pair string.
   * - 2001
     - :class:`MarketPaused`
     - Market
     - Wait for the market to resume.
   * - 2002
     - :class:`MarketAlreadyExists`
     - Market
     - Market already exists.
   * - 3000
     - :class:`OrderNotFound`
     - Order
     - Verify the order ID.
   * - 3001
     - :class:`OrderNotActive`
     - Order
     - The order is already closed or canceled.
   * - 3002
     - :class:`InvalidOrderParams`
     - Order
     - Check price, quantity, and order type.
   * - 4000
     - :class:`InvalidSignature`
     - Account/Session
     - Check your signing method (``personalSign`` vs ``rawSign``).
   * - 4001
     - :class:`InvalidSession`
     - Account/Session
     - Create a new session.
   * - 4002
     - :class:`AccountNotFound`
     - Account/Session
     - Call :meth:`~o2_sdk.client.O2Client.setup_account`.
   * - 4003
     - :class:`WhitelistNotConfigured`
     - Account/Session
     - Account needs whitelisting (done automatically by
       :meth:`~o2_sdk.client.O2Client.setup_account`).
   * - 5000
     - :class:`TradeNotFound`
     - Trade
     - Verify the trade ID.
   * - 5001
     - :class:`InvalidTradeCount`
     - Trade
     - Invalid trade count parameter.
   * - 6000
     - :class:`AlreadySubscribed`
     - WebSocket
     - Already subscribed to this topic.
   * - 6001
     - :class:`TooManySubscriptions`
     - WebSocket
     - Reduce the number of active subscriptions.
   * - 6002
     - :class:`SubscriptionError`
     - WebSocket
     - General subscription error.
   * - 7000
     - :class:`InvalidAmount`
     - Validation
     - Check the amount value.
   * - 7001
     - :class:`InvalidTimeRange`
     - Validation
     - Check the time range parameters.
   * - 7002
     - :class:`InvalidPagination`
     - Validation
     - Check pagination parameters.
   * - 7003
     - :class:`NoActionsProvided`
     - Validation
     - Include at least one action.
   * - 7004
     - :class:`TooManyActions`
     - Validation
     - Maximum 5 actions per request.
   * - 8000
     - :class:`BlockNotFound`
     - Block/Events
     - Block not found.
   * - 8001
     - :class:`EventsNotFound`
     - Block/Events
     - Events not found for the specified block.


Special error types
-------------------

.. class:: SessionExpired

   Client-side error raised when the session has expired before
   submitting an action. Create a new session.

   This is detected locally by the SDK (no network call needed) by
   comparing the session's expiry timestamp against the current time.

.. class:: OnChainRevert

   An on-chain transaction revert.

   This error has **no error code** — it is distinguished by having a
   ``message`` and ``reason`` but no ``code`` field. Common revert
   reasons include:

   - ``NotEnoughBalance`` — Insufficient funds for the operation.
   - ``TraderNotWhiteListed`` — Account is not whitelisted.
   - ``InvalidPrice`` — Price violates on-chain constraints.

   .. code-block:: python

      from o2_sdk import OnChainRevert

      try:
          result = await client.create_order(...)
      except OnChainRevert as e:
          print(f"Revert: {e.message}, reason: {e.reason}")


Error handling patterns
-----------------------

.. code-block:: python

   from o2_sdk import (
       O2Error,
       InvalidSignature,
       RateLimitExceeded,
       OnChainRevert,
       SessionExpired,
   )

   try:
       result = await client.create_order(
           session, "fFUEL/fUSDC", "Buy", 0.02, 100.0
       )
   except SessionExpired:
       # Create a new session
       session = await client.create_session(owner=owner, markets=["fFUEL/fUSDC"])
       result = await client.create_order(
           session, "fFUEL/fUSDC", "Buy", 0.02, 100.0
       )
   except InvalidSignature:
       # Check signing logic
       print("Signature verification failed")
   except RateLimitExceeded:
       # SDK retries automatically, but you can add extra backoff
       await asyncio.sleep(5)
   except OnChainRevert as e:
       print(f"On-chain revert: {e.reason}")
   except O2Error as e:
       print(f"Error {e.code}: {e.message}")


Helper function
---------------

.. function:: raise_for_error(data)

   Inspect a raw API response dict and raise the appropriate exception.

   Handles both pre-flight validation errors (with ``code``) and
   on-chain revert errors (with ``message`` + ``reason``, no ``code``).
   Does nothing if the response contains a ``tx_id`` (success).

   :param data: Raw API response dict.
   :type data: dict
