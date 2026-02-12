``O2Client`` — High-level client
=================================

.. module:: o2_sdk.client
   :synopsis: High-level O2 Exchange client.

The :class:`O2Client` class is the primary entry point for interacting with
the O2 Exchange. It orchestrates wallet management, account lifecycle,
session management, trading, market data retrieval, and WebSocket streaming.

.. seealso::

   The O2 Exchange platform documentation at `<https://docs.o2.app>`_
   covers the underlying REST and WebSocket APIs that this client wraps.


Construction and lifecycle
--------------------------

.. class:: O2Client(network=Network.TESTNET, custom_config=None)

   High-level client for the O2 Exchange.

   :param network: Which network to connect to.
   :type network: :class:`~o2_sdk.config.Network`
   :param custom_config: Optional custom network configuration, overriding
       the built-in config for the selected network.
   :type custom_config: :class:`~o2_sdk.config.NetworkConfig` | None

   The client manages an HTTP session (via ``aiohttp``) and an optional
   WebSocket connection for streaming. Always call :meth:`close` when done,
   or use the async context manager:

   .. code-block:: python

      async with O2Client(network=Network.TESTNET) as client:
          ...

   .. attribute:: api
      :type: O2Api

      The low-level REST API client. Exposed for advanced use cases where
      you need direct access to individual API endpoints.

.. method:: O2Client.close()
   :async:

   Close all HTTP and WebSocket connections.

   Always call this method when you are done using the client.


Wallet management
-----------------

These static methods create or load wallet objects. No network calls
are required.

.. staticmethod:: O2Client.generate_wallet()

   Generate a new Fuel-native wallet with a random private key.

   :returns: A new wallet with ``private_key``, ``public_key``, and
       ``b256_address`` populated.
   :rtype: :class:`~o2_sdk.crypto.Wallet`

   .. code-block:: python

      owner = O2Client.generate_wallet()
      # or equivalently:
      owner = client.generate_wallet()

.. staticmethod:: O2Client.generate_evm_wallet()

   Generate a new EVM-compatible wallet with a random private key.

   The wallet derives both an Ethereum-style address (keccak-256) and
   a Fuel B256 address (the EVM address zero-padded to 32 bytes).

   :returns: A new wallet with ``private_key``, ``public_key``,
       ``evm_address``, and ``b256_address`` populated.
   :rtype: :class:`~o2_sdk.crypto.EvmWallet`

   .. code-block:: python

      evm_owner = client.generate_evm_wallet()
      print(evm_owner.evm_address)   # 0x-prefixed, 42 chars
      print(evm_owner.b256_address)  # 0x-prefixed, 66 chars (zero-padded)

.. staticmethod:: O2Client.load_wallet(private_key_hex)

   Load a Fuel-native wallet from an existing private key.

   :param private_key_hex: The private key as a hex string (with or
       without ``0x`` prefix).
   :type private_key_hex: str
   :returns: The reconstructed wallet.
   :rtype: :class:`~o2_sdk.crypto.Wallet`

.. staticmethod:: O2Client.load_evm_wallet(private_key_hex)

   Load an EVM-compatible wallet from an existing private key.

   :param private_key_hex: The private key as a hex string (with or
       without ``0x`` prefix).
   :type private_key_hex: str
   :returns: The reconstructed wallet.
   :rtype: :class:`~o2_sdk.crypto.EvmWallet`


Account lifecycle
-----------------

.. method:: O2Client.setup_account(wallet)
   :async:

   Set up a trading account idempotently.

   This method performs the complete account setup flow:

   1. **Check** if a trading account already exists for the wallet address.
   2. **Create** a new account if needed (``POST /v1/accounts``).
   3. **Mint** test tokens via the faucet (testnet/devnet only; non-fatal
      if the faucet is on cooldown).
   4. **Whitelist** the account for trading (idempotent; non-fatal on error).

   Safe to call on every bot startup.

   :param wallet: The owner wallet (Fuel or EVM).
   :type wallet: :class:`~o2_sdk.crypto.Signer`
   :returns: Account info including the ``trade_account_id``.
   :rtype: :class:`~o2_sdk.models.AccountInfo`

   .. code-block:: python

      account = await client.setup_account(owner)
      print(account.trade_account_id)
      print(account.exists)  # True


Session management
------------------

.. method:: O2Client.create_session(owner, markets, expiry_days=30)
   :async:

   Create a new trading session.

   A session delegates signing authority from the ``owner`` wallet to a
   temporary session key, scoped to specific market contracts. The session
   key is used to sign all subsequent trade actions.

   :param owner: The owner wallet or external signer.
   :type owner: :class:`~o2_sdk.crypto.Signer`
   :param markets: List of market pair strings (e.g., ``["FUEL/USDC"]``)
       or contract IDs.
   :type markets: list[str]
   :param expiry_days: Session expiry in days (default 30).
   :type expiry_days: int
   :returns: Session info with the session key, account ID, and authorised
       contract IDs.
   :rtype: :class:`~o2_sdk.models.SessionInfo`
   :raises O2Error: If the account does not exist (call
       :meth:`setup_account` first).

   .. code-block:: python

      session = await client.create_session(
          owner=owner,
          markets=["fFUEL/fUSDC"],
          expiry_days=7,
      )


Trading
-------

.. method:: O2Client.create_order(session, market, side, price, quantity, order_type="Spot", order_type_data=None, settle_first=True, collect_orders=True)
   :async:

   Place an order with automatic encoding, signing, and nonce management.

   Prices and quantities are specified as human-readable floats and are
   automatically scaled to on-chain integers based on the market's
   decimal configuration. The SDK also validates orders against on-chain
   constraints (price precision, fractional price, minimum order size).

   :param session: An active trading session.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :param market: Market pair (e.g., ``"FUEL/USDC"``) or ``market_id``.
   :type market: str
   :param side: ``"Buy"`` or ``"Sell"``.
   :type side: str
   :param price: Human-readable price.
   :type price: float
   :param quantity: Human-readable quantity.
   :type quantity: float
   :param order_type: Order type. One of ``"Spot"``, ``"Market"``,
       ``"Limit"``, ``"FillOrKill"``, ``"PostOnly"``, ``"BoundedMarket"``.
   :type order_type: str
   :param order_type_data: Additional data required for ``"Limit"``
       (``{"price": float, "timestamp": int}``) and ``"BoundedMarket"``
       (``{"max_price": float, "min_price": float}``).
   :type order_type_data: dict | None
   :param settle_first: If ``True`` (default), prepend a
       ``SettleBalance`` action to reclaim filled proceeds before placing
       the order.
   :type settle_first: bool
   :param collect_orders: If ``True`` (default), the response includes
       details of the created order.
   :type collect_orders: bool
   :returns: The action result including ``tx_id`` and optional ``orders``.
   :rtype: :class:`~o2_sdk.models.ActionsResponse`

   **Order types:**

   .. code-block:: python

      # Spot (default) — rests on the book
      await client.create_order(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0)

      # PostOnly — rejected if it would match immediately
      await client.create_order(
          session, "fFUEL/fUSDC", "Buy", 0.02, 100.0,
          order_type="PostOnly",
      )

      # BoundedMarket — market order with price bounds
      await client.create_order(
          session, "fFUEL/fUSDC", "Buy", 0.025, 100.0,
          order_type="BoundedMarket",
          order_type_data={"max_price": 0.03, "min_price": 0.01},
      )

.. method:: O2Client.cancel_order(session, order_id, market=None, market_id=None)
   :async:

   Cancel a specific order.

   Either ``market`` (pair string) or ``market_id`` (hex ID) must be
   provided.

   :param session: An active trading session.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :param order_id: The ``0x``-prefixed order ID to cancel.
   :type order_id: str
   :param market: Market pair string (e.g., ``"FUEL/USDC"``).
   :type market: str | None
   :param market_id: Market ID (hex string).
   :type market_id: str | None
   :returns: The action result.
   :rtype: :class:`~o2_sdk.models.ActionsResponse`
   :raises ValueError: If neither ``market`` nor ``market_id`` is
       provided.

.. method:: O2Client.cancel_all_orders(session, market)
   :async:

   Cancel all open orders for a market (up to 5 per batch).

   Fetches the most recent open orders and cancels them in a single
   batch transaction. If you have more than 5 open orders, call this
   method repeatedly.

   :param session: An active trading session.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :param market: Market pair string.
   :type market: str
   :returns: The action result, or a no-op response if there are no
       open orders.
   :rtype: :class:`~o2_sdk.models.ActionsResponse`

.. method:: O2Client.settle_balance(session, market)
   :async:

   Settle filled order proceeds for a market.

   After your orders are filled, the proceeds remain locked in the order
   book contract until you settle them back to your trading account.
   The :meth:`create_order` method does this automatically when
   ``settle_first=True`` (the default).

   :param session: An active trading session.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :param market: Market pair string.
   :type market: str
   :returns: The action result.
   :rtype: :class:`~o2_sdk.models.ActionsResponse`

.. method:: O2Client.batch_actions(session, actions, collect_orders=False)
   :async:

   Submit a batch of raw actions with automatic signing and nonce
   management.

   This is the lowest-level trading method. Actions are grouped by market
   and signed as a single transaction. The O2 Exchange supports a maximum
   of **5 actions** per request.

   :param session: An active trading session.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :param actions: A list of market-grouped action dicts. Each entry
       has a ``"market_id"`` key and an ``"actions"`` list.
   :type actions: list[dict]
   :param collect_orders: If ``True``, return created order details.
   :type collect_orders: bool
   :returns: The action result.
   :rtype: :class:`~o2_sdk.models.ActionsResponse`
   :raises SessionExpired: If the session has expired.

   .. code-block:: python

      result = await client.batch_actions(
          session,
          actions=[{
              "market_id": market.market_id,
              "actions": [
                  {"SettleBalance": {"to": {"ContractId": session.trade_account_id}}},
                  {"CancelOrder": {"order_id": "0xabc..."}},
                  {"CreateOrder": {
                      "side": "Buy",
                      "price": "25000",
                      "quantity": "100000000000",
                      "order_type": "Spot",
                  }},
              ],
          }],
          collect_orders=True,
      )


Market data
-----------

.. method:: O2Client.get_markets()
   :async:

   Get all available markets on the exchange.

   Results are cached for the lifetime of the client.

   :returns: List of all market definitions.
   :rtype: list[:class:`~o2_sdk.models.Market`]

.. method:: O2Client.get_market(symbol_pair)
   :async:

   Get a specific market by its pair symbol.

   :param symbol_pair: The trading pair (e.g., ``"FUEL/USDC"`` or
       ``"fFUEL/fUSDC"``).
   :type symbol_pair: str
   :returns: The market definition.
   :rtype: :class:`~o2_sdk.models.Market`
   :raises O2Error: If the market is not found.

.. method:: O2Client.get_depth(market, precision=10)
   :async:

   Get the current order book depth snapshot for a market.

   :param market: Market pair string or market ID.
   :type market: str
   :param precision: Price aggregation precision (default 10).
   :type precision: int
   :returns: The depth snapshot with ``buys``, ``sells``, ``best_bid``,
       and ``best_ask``.
   :rtype: :class:`~o2_sdk.models.DepthSnapshot`

   .. code-block:: python

      depth = await client.get_depth("fFUEL/fUSDC", precision=10)
      if depth.best_bid:
          print(f"Best bid: {depth.best_bid.price}")
      if depth.best_ask:
          print(f"Best ask: {depth.best_ask.price}")

.. method:: O2Client.get_trades(market, count=50)
   :async:

   Get recent trades for a market.

   :param market: Market pair string or market ID.
   :type market: str
   :param count: Number of trades to retrieve (default 50).
   :type count: int
   :returns: List of recent trades, most recent first.
   :rtype: list[:class:`~o2_sdk.models.Trade`]

.. method:: O2Client.get_bars(market, resolution, from_ts, to_ts)
   :async:

   Get OHLCV candlestick bars for a market.

   :param market: Market pair string or market ID.
   :type market: str
   :param resolution: Candle resolution (e.g., ``"1m"``, ``"5m"``,
       ``"1h"``, ``"1d"``).
   :type resolution: str
   :param from_ts: Start timestamp (Unix seconds).
   :type from_ts: int
   :param to_ts: End timestamp (Unix seconds).
   :type to_ts: int
   :returns: List of OHLCV bars.
   :rtype: list[:class:`~o2_sdk.models.Bar`]

   .. code-block:: python

      import time
      bars = await client.get_bars(
          "fFUEL/fUSDC",
          resolution="1h",
          from_ts=int(time.time()) - 86400,
          to_ts=int(time.time()),
      )
      for bar in bars:
          print(f"{bar.time}: O={bar.open} H={bar.high} L={bar.low} C={bar.close} V={bar.volume}")

.. method:: O2Client.get_ticker(market)
   :async:

   Get real-time ticker data for a market.

   :param market: Market pair string or market ID.
   :type market: str
   :returns: Raw ticker data dict.
   :rtype: dict


Account data
------------

.. method:: O2Client.get_balances(account)
   :async:

   Get balances for all known assets, keyed by asset symbol.

   Iterates over all markets to discover assets, then queries the balance
   for each unique asset.

   :param account: An :class:`~o2_sdk.models.AccountInfo` object or a
       ``trade_account_id`` string.
   :type account: :class:`~o2_sdk.models.AccountInfo` | str
   :returns: A dict mapping asset symbol to balance info.
   :rtype: dict[str, :class:`~o2_sdk.models.Balance`]

   .. code-block:: python

      balances = await client.get_balances(account)
      for symbol, bal in balances.items():
          print(f"{symbol}: available={bal.trading_account_balance}")

.. method:: O2Client.get_orders(account, market, is_open=None, count=20)
   :async:

   Get orders for an account on a market.

   :param account: An :class:`~o2_sdk.models.AccountInfo` object or a
       ``trade_account_id`` string.
   :type account: :class:`~o2_sdk.models.AccountInfo` | str
   :param market: Market pair string.
   :type market: str
   :param is_open: Filter by open/closed status. ``None`` returns all.
   :type is_open: bool | None
   :param count: Maximum number of orders to return (default 20).
   :type count: int
   :returns: List of orders, most recent first.
   :rtype: list[:class:`~o2_sdk.models.Order`]

.. method:: O2Client.get_order(market, order_id)
   :async:

   Get a specific order by its ID.

   :param market: Market pair string.
   :type market: str
   :param order_id: The ``0x``-prefixed order ID.
   :type order_id: str
   :returns: The order details.
   :rtype: :class:`~o2_sdk.models.Order`


WebSocket streaming
-------------------

All streaming methods return async iterators that yield typed update objects.
The underlying WebSocket connection is created lazily on first use and
supports automatic reconnection with exponential backoff.

.. method:: O2Client.stream_depth(market, precision=10)
   :async:

   Stream real-time order book depth updates.

   The first message is a full snapshot; subsequent messages are
   incremental updates.

   :param market: Market pair string.
   :type market: str
   :param precision: Price aggregation precision (default 10).
   :type precision: int
   :returns: An async iterator of depth updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.DepthUpdate`]

   .. code-block:: python

      async for update in client.stream_depth("fFUEL/fUSDC"):
          if update.is_snapshot:
              print(f"Snapshot: {len(update.changes.buys)} bids, {len(update.changes.sells)} asks")
          else:
              print(f"Update: best_bid={update.changes.best_bid}")

.. method:: O2Client.stream_orders(account)
   :async:

   Stream real-time order updates for an account.

   :param account: An :class:`~o2_sdk.models.AccountInfo` object or a
       ``trade_account_id`` string.
   :type account: :class:`~o2_sdk.models.AccountInfo` | str
   :returns: An async iterator of order updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.OrderUpdate`]

.. method:: O2Client.stream_trades(market)
   :async:

   Stream real-time trade updates for a market.

   :param market: Market pair string.
   :type market: str
   :returns: An async iterator of trade updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.TradeUpdate`]

.. method:: O2Client.stream_balances(account)
   :async:

   Stream real-time balance updates for an account.

   :param account: An :class:`~o2_sdk.models.AccountInfo` object or a
       ``trade_account_id`` string.
   :type account: :class:`~o2_sdk.models.AccountInfo` | str
   :returns: An async iterator of balance updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.BalanceUpdate`]

.. method:: O2Client.stream_nonce(account)
   :async:

   Stream real-time nonce updates for an account.

   Useful for monitoring nonce changes caused by other sessions or
   external transactions.

   :param account: An :class:`~o2_sdk.models.AccountInfo` object or a
       ``trade_account_id`` string.
   :type account: :class:`~o2_sdk.models.AccountInfo` | str
   :returns: An async iterator of nonce updates.
   :rtype: AsyncIterator[:class:`~o2_sdk.models.NonceUpdate`]


Withdrawals
-----------

.. method:: O2Client.withdraw(owner, asset, amount, to=None)
   :async:

   Withdraw funds from the trading account to an external address.

   This method signs the withdrawal with the **owner** key (using
   ``personalSign``), not the session key.

   :param owner: The owner wallet or external signer.
   :type owner: :class:`~o2_sdk.crypto.Signer`
   :param asset: Asset symbol (e.g., ``"USDC"``) or asset ID.
   :type asset: str
   :param amount: Human-readable amount to withdraw.
   :type amount: float
   :param to: Destination address. Defaults to the owner's address.
   :type to: str | None
   :returns: The withdrawal result.
   :rtype: :class:`~o2_sdk.models.WithdrawResponse`

   .. code-block:: python

      result = await client.withdraw(owner=owner, asset="fUSDC", amount=10.0)
      if result.success:
          print(f"Withdrawal tx: {result.tx_id}")


Nonce management
----------------

.. method:: O2Client.get_nonce(trade_account_id)
   :async:

   Get the current nonce for a trading account.

   Returns the cached value if available; otherwise fetches from the API.

   :param trade_account_id: The trading account contract ID.
   :type trade_account_id: str
   :returns: The current nonce.
   :rtype: int

.. method:: O2Client.refresh_nonce(session)
   :async:

   Re-fetch the nonce from the API and update the local cache.

   Call this after catching an error from :meth:`batch_actions` if you
   suspect the nonce is out of sync (the SDK does this automatically on
   error).

   :param session: The session whose nonce to refresh.
   :type session: :class:`~o2_sdk.models.SessionInfo`
   :returns: The refreshed nonce.
   :rtype: int
