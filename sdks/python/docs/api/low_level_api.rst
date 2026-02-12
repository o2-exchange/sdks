``api`` — Low-level REST client
================================

.. module:: o2_sdk.api
   :synopsis: Low-level typed REST API client for the O2 Exchange.

The :class:`O2Api` class provides typed wrappers for every REST endpoint
exposed by the O2 Exchange. All methods return typed response objects and
raise :class:`~o2_sdk.errors.O2Error` on failures.

For most use cases, use :class:`~o2_sdk.client.O2Client` instead, which
provides a higher-level interface with automatic market resolution, signing,
and nonce management.

The ``O2Api`` instance is accessible on the client as ``client.api`` for
advanced use cases.

.. seealso::

   The O2 Exchange REST API is documented at `<https://docs.o2.app>`_.


O2Api
-----

.. class:: O2Api(config, session=None)

   Low-level REST API client for the O2 Exchange.

   Includes automatic rate-limit handling with exponential backoff retries
   and network error retries (up to 3 attempts).

   :param config: Network configuration.
   :type config: :class:`~o2_sdk.config.NetworkConfig`
   :param session: Optional ``aiohttp.ClientSession`` to reuse. If
       ``None``, a new session is created automatically.
   :type session: aiohttp.ClientSession | None

   .. method:: close()
      :async:

      Close the HTTP session (if owned by this instance).


Market data endpoints
~~~~~~~~~~~~~~~~~~~~~

.. method:: O2Api.get_markets()
   :async:

   ``GET /v1/markets`` — Get all available markets and exchange metadata.

   :returns: Exchange metadata and market definitions.
   :rtype: :class:`~o2_sdk.models.MarketsResponse`

.. method:: O2Api.get_market_summary(market_id)
   :async:

   ``GET /v1/markets/summary`` — Get summary data for a market.

   :param market_id: The market ID.
   :type market_id: str
   :rtype: :class:`~o2_sdk.models.MarketSummary`

.. method:: O2Api.get_market_ticker(market_id)
   :async:

   ``GET /v1/markets/ticker`` — Get ticker data for a market.

   :param market_id: The market ID.
   :type market_id: str
   :rtype: :class:`~o2_sdk.models.MarketTicker`

.. method:: O2Api.get_depth(market_id, precision=10)
   :async:

   ``GET /v1/depth`` — Get order book depth snapshot.

   :param market_id: The market ID.
   :type market_id: str
   :param precision: Price aggregation precision (default 10).
   :type precision: int
   :rtype: :class:`~o2_sdk.models.DepthSnapshot`

.. method:: O2Api.get_trades(market_id, direction="desc", count=50, start_timestamp=None, start_trade_id=None)
   :async:

   ``GET /v1/trades`` — Get recent trades for a market.

   :param market_id: The market ID.
   :type market_id: str
   :param direction: Sort direction (``"desc"`` or ``"asc"``).
   :type direction: str
   :param count: Number of trades to return (default 50).
   :type count: int
   :param start_timestamp: Pagination cursor — start timestamp.
   :type start_timestamp: int | None
   :param start_trade_id: Pagination cursor — start trade ID.
   :type start_trade_id: str | None
   :rtype: list[:class:`~o2_sdk.models.Trade`]

.. method:: O2Api.get_trades_by_account(market_id, contract, direction="desc", count=50)
   :async:

   ``GET /v1/trades_by_account`` — Get trades for a specific account.

   :param market_id: The market ID.
   :type market_id: str
   :param contract: The trading account contract ID.
   :type contract: str
   :param direction: Sort direction.
   :type direction: str
   :param count: Number of trades to return.
   :type count: int
   :rtype: list[:class:`~o2_sdk.models.Trade`]

.. method:: O2Api.get_bars(market_id, from_ts, to_ts, resolution="1h")
   :async:

   ``GET /v1/bars`` — Get OHLCV candlestick bars.

   :param market_id: The market ID.
   :type market_id: str
   :param from_ts: Start timestamp (Unix seconds).
   :type from_ts: int
   :param to_ts: End timestamp (Unix seconds).
   :type to_ts: int
   :param resolution: Candle resolution (e.g., ``"1m"``, ``"5m"``,
       ``"1h"``, ``"1d"``). Default ``"1h"``.
   :type resolution: str
   :rtype: list[:class:`~o2_sdk.models.Bar`]


Account and balance endpoints
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. method:: O2Api.create_account(owner_address)
   :async:

   ``POST /v1/accounts`` — Create a new trading account.

   :param owner_address: The owner's B256 address.
   :type owner_address: str
   :rtype: :class:`~o2_sdk.models.AccountCreateResponse`

.. method:: O2Api.get_account(owner=None, trade_account_id=None)
   :async:

   ``GET /v1/accounts`` — Get account information.

   Provide either ``owner`` (B256 address) or ``trade_account_id``.

   :param owner: The owner's B256 address.
   :type owner: str | None
   :param trade_account_id: The trading account contract ID.
   :type trade_account_id: str | None
   :rtype: :class:`~o2_sdk.models.AccountInfo`

.. method:: O2Api.get_balance(asset_id, contract=None, address=None)
   :async:

   ``GET /v1/balance`` — Get balance for a specific asset.

   Provide either ``contract`` (trading account ID) or ``address``.

   :param asset_id: The asset ID.
   :type asset_id: str
   :param contract: The trading account contract ID.
   :type contract: str | None
   :param address: The owner address.
   :type address: str | None
   :rtype: :class:`~o2_sdk.models.Balance`


Order endpoints
~~~~~~~~~~~~~~~

.. method:: O2Api.get_orders(market_id, contract=None, account=None, direction="desc", count=20, is_open=None, start_timestamp=None, start_order_id=None)
   :async:

   ``GET /v1/orders`` — Get orders for a market and account.

   :param market_id: The market ID.
   :type market_id: str
   :param contract: The trading account contract ID.
   :type contract: str | None
   :param account: Alternative account identifier.
   :type account: str | None
   :param direction: Sort direction (``"desc"`` or ``"asc"``).
   :type direction: str
   :param count: Maximum number of orders (default 20).
   :type count: int
   :param is_open: Filter by open status (``True``/``False``/``None``).
   :type is_open: bool | None
   :param start_timestamp: Pagination cursor.
   :type start_timestamp: int | None
   :param start_order_id: Pagination cursor.
   :type start_order_id: str | None
   :rtype: :class:`~o2_sdk.models.OrdersResponse`

.. method:: O2Api.get_order(market_id, order_id)
   :async:

   ``GET /v1/order`` — Get a single order by ID.

   :param market_id: The market ID.
   :type market_id: str
   :param order_id: The order ID.
   :type order_id: str
   :rtype: :class:`~o2_sdk.models.Order`


Session endpoints
~~~~~~~~~~~~~~~~~

.. method:: O2Api.create_session(owner_id, session_request)
   :async:

   ``PUT /v1/session`` — Create a new trading session.

   Sends the ``O2-Owner-Id`` header with the owner address.

   :param owner_id: The owner's B256 address.
   :type owner_id: str
   :param session_request: The session creation payload.
   :type session_request: dict
   :rtype: :class:`~o2_sdk.models.SessionResponse`

.. method:: O2Api.submit_actions(owner_id, actions_request)
   :async:

   ``POST /v1/session/actions`` — Submit signed session actions.

   Sends the ``O2-Owner-Id`` header. Raises :func:`~o2_sdk.errors.raise_for_error`
   on failure.

   :param owner_id: The owner's B256 address.
   :type owner_id: str
   :param actions_request: The actions payload (signed).
   :type actions_request: dict
   :rtype: :class:`~o2_sdk.models.ActionsResponse`


Account operation endpoints
~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. method:: O2Api.withdraw(owner_id, withdraw_request)
   :async:

   ``POST /v1/accounts/withdraw`` — Submit a signed withdrawal.

   :param owner_id: The owner's B256 address.
   :type owner_id: str
   :param withdraw_request: The withdrawal payload (signed).
   :type withdraw_request: dict
   :rtype: :class:`~o2_sdk.models.WithdrawResponse`


Analytics endpoints
~~~~~~~~~~~~~~~~~~~

.. method:: O2Api.whitelist_account(trade_account_id)
   :async:

   ``POST /analytics/v1/whitelist`` — Whitelist a trading account.

   :param trade_account_id: The trading account contract ID.
   :type trade_account_id: str
   :rtype: :class:`~o2_sdk.models.WhitelistResponse`

.. method:: O2Api.get_referral_info(code)
   :async:

   ``GET /analytics/v1/referral/code-info`` — Get referral code info.

   :param code: The referral code.
   :type code: str
   :rtype: :class:`~o2_sdk.models.ReferralInfo`


Aggregated endpoints
~~~~~~~~~~~~~~~~~~~~

.. method:: O2Api.get_aggregated_assets()
   :async:

   ``GET /v1/aggregated/assets`` — Get all assets.

   :rtype: list[:class:`~o2_sdk.models.AggregatedAsset`]

.. method:: O2Api.get_aggregated_orderbook(market_pair, depth=500, level=2)
   :async:

   ``GET /v1/aggregated/orderbook`` — Get aggregated order book.

   :param market_pair: The trading pair (e.g., ``"FUEL_USDC"``).
   :type market_pair: str
   :param depth: Order book depth (default 500).
   :type depth: int
   :param level: Aggregation level (default 2).
   :type level: int
   :rtype: dict

.. method:: O2Api.get_aggregated_summary()
   :async:

   ``GET /v1/aggregated/summary`` — Get market summaries.

   :rtype: list[dict]

.. method:: O2Api.get_aggregated_ticker()
   :async:

   ``GET /v1/aggregated/ticker`` — Get all tickers.

   :rtype: list[dict]

.. method:: O2Api.get_aggregated_trades(market_pair)
   :async:

   ``GET /v1/aggregated/trades`` — Get aggregated trades.

   :param market_pair: The trading pair.
   :type market_pair: str
   :rtype: list[:class:`~o2_sdk.models.Trade`]


Faucet endpoints
~~~~~~~~~~~~~~~~

Available on testnet and devnet only.

.. method:: O2Api.mint_to_address(address)
   :async:

   Mint test tokens to an address (wallet).

   :param address: The B256 address.
   :type address: str
   :rtype: :class:`~o2_sdk.models.FaucetResponse`
   :raises O2Error: If the faucet is not available on this network.

.. method:: O2Api.mint_to_contract(contract_id)
   :async:

   Mint test tokens to a contract (trading account).

   :param contract_id: The trading account contract ID.
   :type contract_id: str
   :rtype: :class:`~o2_sdk.models.FaucetResponse`
   :raises O2Error: If the faucet is not available on this network.
