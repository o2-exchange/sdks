``websocket`` — WebSocket client
================================

.. module:: o2_sdk.websocket
   :synopsis: WebSocket client for real-time O2 Exchange data streams.

The :class:`O2WebSocket` class provides a low-level WebSocket client with
automatic reconnection and subscription management. For most use cases, use
the streaming methods on :class:`~o2_sdk.client.O2Client` instead, which
manage the WebSocket connection automatically.

.. seealso::

   The O2 Exchange WebSocket protocol is documented at
   `<https://docs.o2.app>`_. The high-level streaming methods are
   documented in :doc:`client`.


O2WebSocket
-----------

.. class:: O2WebSocket(config)

   Async WebSocket client for O2 Exchange real-time data.

   Features:

   - **Auto-reconnect** with exponential backoff (1s to 60s).
   - **Subscription persistence** — subscriptions are re-sent on
     reconnect.
   - **Per-channel queues** — messages are dispatched to typed queues
     by action type.

   :param config: Network configuration with WebSocket URL.
   :type config: :class:`~o2_sdk.config.NetworkConfig`

   .. method:: connect()
      :async:

      Connect to the WebSocket endpoint.

      :returns: The connected client (for chaining).
      :rtype: O2WebSocket

   .. method:: disconnect()
      :async:

      Disconnect from the WebSocket and signal all subscription iterators
      to stop.


Subscription methods
~~~~~~~~~~~~~~~~~~~~

Each subscription method returns an :class:`~collections.abc.AsyncIterator`
that yields typed update objects. The first message may be a full snapshot
(for depth subscriptions), followed by incremental updates.

.. method:: O2WebSocket.stream_depth(market_id, precision="10")
   :async:

   Subscribe to order book depth updates.

   :param market_id: The market ID (hex string).
   :type market_id: str
   :param precision: Price aggregation precision (default ``"10"``).
   :type precision: str
   :returns: Async iterator of depth updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.DepthUpdate`]

.. method:: O2WebSocket.stream_orders(identities)
   :async:

   Subscribe to order updates for the given identities.

   :param identities: List of identity dicts
       (e.g., ``[{"ContractId": "0x..."}]``).
   :type identities: list[dict]
   :returns: Async iterator of order updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.OrderUpdate`]

.. method:: O2WebSocket.stream_trades(market_id)
   :async:

   Subscribe to trade updates for a market.

   :param market_id: The market ID (hex string).
   :type market_id: str
   :returns: Async iterator of trade updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.TradeUpdate`]

.. method:: O2WebSocket.stream_balances(identities)
   :async:

   Subscribe to balance updates for the given identities.

   :param identities: List of identity dicts.
   :type identities: list[dict]
   :returns: Async iterator of balance updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.BalanceUpdate`]

.. method:: O2WebSocket.stream_nonce(identities)
   :async:

   Subscribe to nonce updates for the given identities.

   :param identities: List of identity dicts.
   :type identities: list[dict]
   :returns: Async iterator of nonce updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.NonceUpdate`]


Unsubscribe methods
~~~~~~~~~~~~~~~~~~~

.. method:: O2WebSocket.unsubscribe_depth(market_id)
   :async:

   Unsubscribe from depth updates for a market.

.. method:: O2WebSocket.unsubscribe_orders()
   :async:

   Unsubscribe from all order updates.

.. method:: O2WebSocket.unsubscribe_trades(market_id)
   :async:

   Unsubscribe from trade updates for a market.

.. method:: O2WebSocket.unsubscribe_balances(identities)
   :async:

   Unsubscribe from balance updates.

.. method:: O2WebSocket.unsubscribe_nonce(identities)
   :async:

   Unsubscribe from nonce updates.
