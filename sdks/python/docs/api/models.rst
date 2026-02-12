``models`` — Data models
========================

.. module:: o2_sdk.models
   :synopsis: Data models for O2 Exchange API request/response types.

All API response types are implemented as Python dataclasses with
``from_dict()`` class methods for JSON parsing.


Enums
-----

.. class:: OrderSide

   Side of an order.

   .. attribute:: BUY
      :value: "Buy"

   .. attribute:: SELL
      :value: "Sell"

.. class:: OrderType

   Type of an order (simple types without additional parameters).

   .. attribute:: SPOT
      :value: "Spot"

   .. attribute:: MARKET
      :value: "Market"

   .. attribute:: LIMIT
      :value: "Limit"

   .. attribute:: FILL_OR_KILL
      :value: "FillOrKill"

   .. attribute:: POST_ONLY
      :value: "PostOnly"

   .. attribute:: BOUNDED_MARKET
      :value: "BoundedMarket"


Order type parameter classes
----------------------------

.. class:: LimitOrder(price, timestamp=None)

   Limit order with expiry. In :meth:`~o2_sdk.client.O2Client.create_order`,
   *price* is human-readable and auto-scaled. In
   :class:`CreateOrderAction`, *price* should be the pre-scaled chain
   integer.

   .. attribute:: price
      :type: float

   .. attribute:: timestamp
      :type: int | None

      Unix timestamp for time-in-force. ``None`` defaults to the current
      time.

.. class:: BoundedMarketOrder(max_price, min_price)

   Bounded market order with price bounds. In
   :meth:`~o2_sdk.client.O2Client.create_order`, prices are
   human-readable and auto-scaled. In :class:`CreateOrderAction`, prices
   should be pre-scaled chain integers.

   .. attribute:: max_price
      :type: float

   .. attribute:: min_price
      :type: float


Scalar types
------------

.. class:: Id(value)

   A hex identifier that always displays with a ``0x`` prefix.

   The O2 API returns hex identifiers inconsistently — sometimes with the
   ``0x`` prefix and sometimes without. ``Id`` normalizes the value on
   construction so that ``str(id)`` always starts with ``0x``, and
   compares case-insensitively.

   ``Id`` is a :class:`str` subclass, so it works transparently in
   f-strings, comparisons, dict keys, and ``is not None`` checks.

   :param value: The hex string, with or without ``0x`` prefix.
   :type value: str

   .. code-block:: pycon

      >>> from o2_sdk import Id
      >>> Id("97edbbf5")
      Id('0x97edbbf5')
      >>> Id("0x97EDBBF5")
      Id('0x97edbbf5')


Market models
-------------

.. class:: MarketAsset

   An asset within a market (base or quote).

   .. attribute:: symbol
      :type: str

      The human-readable asset symbol (e.g., ``"FUEL"``, ``"USDC"``).

   .. attribute:: asset
      :type: str

      The on-chain asset ID (``0x``-prefixed hex).

   .. attribute:: decimals
      :type: int

      The number of decimal places for this asset.

   .. attribute:: max_precision
      :type: int

      Maximum price precision (number of significant digits).

.. class:: Market

   A trading market (order book) on the O2 Exchange.

   .. attribute:: contract_id
      :type: Id

      The on-chain contract ID managing this order book.

   .. attribute:: market_id
      :type: Id

      The unique market identifier within the contract.

   .. attribute:: maker_fee
      :type: str

      Maker fee rate (string representation).

   .. attribute:: taker_fee
      :type: str

      Taker fee rate (string representation).

   .. attribute:: min_order
      :type: str

      Minimum order size (in quote-scaled units).

   .. attribute:: dust
      :type: str

      Dust threshold.

   .. attribute:: price_window
      :type: int

      Price window constraint.

   .. attribute:: base
      :type: MarketAsset

      The base asset definition.

   .. attribute:: quote
      :type: MarketAsset

      The quote asset definition.

   .. property:: pair
      :type: str

      The human-readable pair string (e.g., ``"FUEL/USDC"``).

   .. method:: scale_price(human_value)

      Convert a human-readable price to an on-chain integer, truncated
      to the market's ``max_precision``.

      :param human_value: The price as a float (e.g., ``0.025``).
      :type human_value: float
      :returns: The scaled price integer.
      :rtype: int

   .. method:: format_price(chain_value)

      Convert an on-chain integer price back to a human-readable float.

      :param chain_value: The on-chain price integer.
      :type chain_value: int
      :returns: The human-readable price.
      :rtype: float

   .. method:: scale_quantity(human_value)

      Convert a human-readable quantity to an on-chain integer.

      :param human_value: The quantity as a float (e.g., ``100.0``).
      :type human_value: float
      :returns: The scaled quantity integer.
      :rtype: int

   .. method:: format_quantity(chain_value)

      Convert an on-chain integer quantity to a human-readable float.

      :param chain_value: The on-chain quantity integer.
      :type chain_value: int
      :returns: The human-readable quantity.
      :rtype: float

   .. method:: validate_order(price, quantity)

      Validate scaled price/quantity against on-chain constraints.

      Checks:

      - **PricePrecision**: price must be a multiple of the truncation factor.
      - **FractionalPrice**: ``(price * quantity) % 10^base_decimals == 0``.
      - **min_order**: forwarded quote amount must meet the minimum.

      :param price: The scaled price (on-chain integer).
      :type price: int
      :param quantity: The scaled quantity (on-chain integer).
      :type quantity: int
      :raises ValueError: If any constraint is violated.

   .. method:: adjust_quantity(price, quantity)

      Adjust a quantity to satisfy the FractionalPrice constraint.

      Returns the largest quantity ``<=`` the input such that
      ``(price * quantity) % 10^base_decimals == 0``.

      :param price: The scaled price.
      :type price: int
      :param quantity: The scaled quantity.
      :type quantity: int
      :returns: The adjusted quantity.
      :rtype: int


.. class:: MarketsResponse

   Response from ``GET /v1/markets``.

   .. attribute:: books_registry_id
      :type: Id

   .. attribute:: accounts_registry_id
      :type: Id

   .. attribute:: trade_account_oracle_id
      :type: Id

   .. attribute:: chain_id
      :type: str

   .. attribute:: base_asset_id
      :type: Id

   .. attribute:: markets
      :type: list[Market]

   .. property:: chain_id_int
      :type: int

      The chain ID as a plain integer.


Account models
--------------

.. class:: Identity

   Base identity type — either an ``Address`` or a ``ContractId``. Use
   :class:`AddressIdentity` or :class:`ContractIdentity` to construct
   instances directly, or :meth:`from_dict` to parse from API responses.

   .. attribute:: value
      :type: str

      The ``0x``-prefixed hex string.

   .. classmethod:: from_dict(d)

      Factory method that returns the appropriate subclass.

      :param d: A dict like ``{"Address": "0x..."}`` or
          ``{"ContractId": "0x..."}``.
      :type d: dict
      :returns: An :class:`AddressIdentity` or :class:`ContractIdentity`.
      :rtype: Identity
      :raises ValueError: If the dict format is not recognized.

   .. property:: address_bytes
      :type: bytes

      The address as raw bytes (32 bytes).

   .. method:: to_dict()

      Serialize to the API's JSON format. Implemented by subclasses.

      :rtype: dict

   .. property:: discriminant
      :type: int

      ``0`` for Address, ``1`` for ContractId. Implemented by subclasses.

.. class:: AddressIdentity(value)

   Identity for a Fuel Address. Subclass of :class:`Identity`.

   .. code-block:: python

      addr = AddressIdentity("0xabc...")
      addr.to_dict()      # {"Address": "0xabc..."}
      addr.discriminant    # 0

.. class:: ContractIdentity(value)

   Identity for a Fuel ContractId. Subclass of :class:`Identity`.

   .. code-block:: python

      contract = ContractIdentity("0xdef...")
      contract.to_dict()      # {"ContractId": "0xdef..."}
      contract.discriminant    # 1

.. class:: AccountInfo

   Trading account information.

   .. attribute:: trade_account_id
      :type: Id | None

      The trading account contract ID, or ``None`` if the account does
      not exist.

   .. attribute:: trade_account
      :type: TradeAccount | None

      Detailed account data (nonce, owner, etc.), or ``None``.

   .. attribute:: session
      :type: dict | None

      Active session data, if any.

   .. property:: exists
      :type: bool

      ``True`` if the account exists (i.e., ``trade_account_id`` is not
      ``None``).

   .. property:: nonce
      :type: int

      The current nonce for this account. Returns ``0`` if the account
      does not exist.

.. class:: AccountCreateResponse

   Response from ``POST /v1/accounts``.

   .. attribute:: trade_account_id
      :type: Id

   .. attribute:: nonce
      :type: str


Session models
--------------

.. class:: SessionInfo

   An active trading session, returned by
   :meth:`~o2_sdk.client.O2Client.create_session`.

   .. attribute:: session_id
      :type: Identity

      The session identity (the session wallet's address).

   .. attribute:: trade_account_id
      :type: Id

      The trading account this session operates on.

   .. attribute:: contract_ids
      :type: list[Id]

      The market contracts this session is authorised for.

   .. attribute:: session_expiry
      :type: str

      Unix timestamp (as string) when the session expires.

   .. attribute:: session_private_key
      :type: bytes | None

      The session wallet's private key (used internally for signing
      actions).

   .. attribute:: owner_address
      :type: str | None

      The owner wallet's B256 address.

   .. attribute:: nonce
      :type: int

      The current nonce, updated after each action.

.. class:: SessionResponse

   Raw response from ``PUT /v1/session``.

   .. attribute:: tx_id
      :type: Id

   .. attribute:: trade_account_id
      :type: Id

   .. attribute:: contract_ids
      :type: list[Id]

   .. attribute:: session_id
      :type: Identity

   .. attribute:: session_expiry
      :type: str


Order models
------------

.. class:: Order

   An order on the O2 Exchange.

   .. attribute:: order_id
      :type: Id

      The unique order identifier.

   .. attribute:: side
      :type: str

      ``"Buy"`` or ``"Sell"``.

   .. attribute:: order_type
      :type: Any

      The order type (string or dict for Limit/BoundedMarket).

   .. attribute:: quantity
      :type: str

      The order quantity (on-chain scaled, as string).

   .. attribute:: quantity_fill
      :type: str

      The filled quantity (on-chain scaled, as string).

   .. attribute:: price
      :type: str

      The order price (on-chain scaled, as string).

   .. attribute:: price_fill
      :type: str

      The fill price (on-chain scaled, as string).

   .. attribute:: timestamp
      :type: str

      The order creation timestamp.

   .. attribute:: close
      :type: bool

      ``True`` if the order is closed (fully filled or canceled).

   .. attribute:: partially_filled
      :type: bool

      ``True`` if the order has been partially filled.

   .. attribute:: cancel
      :type: bool

      ``True`` if the order was canceled.

   .. property:: is_open
      :type: bool

      ``True`` if the order is still active (not closed).

.. class:: OrdersResponse

   Response from ``GET /v1/orders``.

   .. attribute:: identity
      :type: Identity | None

   .. attribute:: market_id
      :type: Id

   .. attribute:: orders
      :type: list[Order]


Trade models
------------

.. class:: Trade

   A completed trade on the exchange.

   .. attribute:: trade_id
      :type: Id

      The unique trade identifier.

   .. attribute:: side
      :type: str

      The taker's side (``"Buy"`` or ``"Sell"``).

   .. attribute:: total
      :type: str

      The total quote value of the trade.

   .. attribute:: quantity
      :type: str

      The traded quantity (on-chain scaled).

   .. attribute:: price
      :type: str

      The trade price (on-chain scaled).

   .. attribute:: timestamp
      :type: str

      The trade timestamp.

   .. attribute:: maker
      :type: Identity | None

   .. attribute:: taker
      :type: Identity | None

   .. attribute:: market_id
      :type: Id | None


Balance models
--------------

.. class:: Balance

   Asset balance information for a trading account.

   .. attribute:: order_books
      :type: dict[str, OrderBookBalance]

      Per-order-book breakdown of locked and unlocked amounts.

   .. attribute:: total_locked
      :type: str

      Total amount locked in open orders (on-chain scaled).

   .. attribute:: total_unlocked
      :type: str

      Total unlocked (settled) amount (on-chain scaled).

   .. attribute:: trading_account_balance
      :type: str

      Total balance in the trading account (on-chain scaled).

   .. property:: available
      :type: int

      The trading account balance as an integer.

.. class:: OrderBookBalance

   Balance breakdown within a single order book.

   .. attribute:: locked
      :type: str

      Amount locked in open orders.

   .. attribute:: unlocked
      :type: str

      Amount unlocked (settled).


Depth models
------------

.. class:: DepthLevel

   A single price level in the order book.

   .. attribute:: price
      :type: str

      The price at this level (on-chain scaled).

   .. attribute:: quantity
      :type: str

      The total quantity at this level (on-chain scaled).

.. class:: DepthSnapshot

   A snapshot of order book depth.

   .. attribute:: buys
      :type: list[DepthLevel]

      Bid (buy) price levels, best first.

   .. attribute:: sells
      :type: list[DepthLevel]

      Ask (sell) price levels, best first.

   .. attribute:: market_id
      :type: Id | None

   .. property:: best_bid
      :type: DepthLevel | None

      The best (highest) bid price level, or ``None`` if the book is
      empty.

   .. property:: best_ask
      :type: DepthLevel | None

      The best (lowest) ask price level, or ``None`` if the book is
      empty.

.. class:: DepthUpdate

   A real-time depth update from the WebSocket stream.

   .. attribute:: changes
      :type: DepthSnapshot

      The depth changes (or full snapshot for the initial message).

   .. attribute:: market_id
      :type: Id

   .. attribute:: onchain_timestamp
      :type: str | None

   .. attribute:: seen_timestamp
      :type: str | None

   .. attribute:: is_snapshot
      :type: bool

      ``True`` if this is the initial full snapshot.


Bar models
----------

.. class:: Bar

   An OHLCV candlestick bar.

   .. attribute:: time
      :type: int

      The bar's opening time (Unix seconds).

   .. attribute:: open
      :type: str

      Opening price.

   .. attribute:: high
      :type: str

      Highest price.

   .. attribute:: low
      :type: str

      Lowest price.

   .. attribute:: close
      :type: str

      Closing price.

   .. attribute:: volume
      :type: str

      Trading volume.


Action response models
----------------------

.. class:: ActionsResponse

   Response from ``POST /v1/session/actions``.

   This is the primary result type returned by trading methods such as
   :meth:`~o2_sdk.client.O2Client.create_order`,
   :meth:`~o2_sdk.client.O2Client.cancel_order`, and
   :meth:`~o2_sdk.client.O2Client.batch_actions`.

   .. attribute:: tx_id
      :type: Id | None

      The on-chain transaction ID, or ``None`` on failure.

   .. attribute:: orders
      :type: list[Order] | None

      Created order details (only if ``collect_orders=True``).

   .. attribute:: message
      :type: str | None

      Error or status message.

   .. attribute:: reason
      :type: str | None

      On-chain revert reason, if applicable.

   .. attribute:: receipts
      :type: list | None

      Raw transaction receipts.

   .. attribute:: code
      :type: int | None

      Error code (see :doc:`../api/errors`).

   .. property:: success
      :type: bool

      ``True`` if the action succeeded (``tx_id`` is not ``None``).


Action input models
-------------------

These dataclasses are the typed inputs for
:meth:`~o2_sdk.client.O2Client.batch_actions`. Each has a ``to_dict()``
method that serializes to the wire format expected by the API.

.. class:: CreateOrderAction(side, price, quantity, order_type=OrderType.SPOT)

   Create a new order. Prices and quantities must be **pre-scaled on-chain
   integers** passed as strings.

   .. attribute:: side
      :type: OrderSide

   .. attribute:: price
      :type: str

      Pre-scaled chain integer as string.

   .. attribute:: quantity
      :type: str

      Pre-scaled chain integer as string.

   .. attribute:: order_type
      :type: OrderType | LimitOrder | BoundedMarketOrder

      Defaults to ``OrderType.SPOT``.

.. class:: CancelOrderAction(order_id)

   Cancel an existing order.

   .. attribute:: order_id
      :type: Id

      The normalised hex order ID.

.. class:: SettleBalanceAction(to)

   Settle balance to an identity. Accepts an :class:`Identity` subclass
   (e.g. :class:`ContractIdentity`) or an :class:`Id`, which is
   auto-wrapped as :class:`ContractIdentity` during serialisation.

   .. attribute:: to
      :type: Identity | Id

   .. code-block:: python

      # Pass session.trade_account_id directly (an Id):
      SettleBalanceAction(to=session.trade_account_id)

      # Or pass an explicit Identity:
      SettleBalanceAction(to=ContractIdentity("0xabc..."))

.. class:: RegisterRefererAction(to)

   Register a referer. Same auto-wrapping behaviour as
   :class:`SettleBalanceAction`.

   .. attribute:: to
      :type: Identity | Id

.. data:: Action

   Type alias: ``CreateOrderAction | CancelOrderAction | SettleBalanceAction | RegisterRefererAction``

.. class:: MarketActions(market_id, actions)

   Groups a list of actions for a specific market. This is the input
   type for :meth:`~o2_sdk.client.O2Client.batch_actions`.

   .. attribute:: market_id
      :type: str

      The market's hex ID.

   .. attribute:: actions
      :type: list[Action]

      The actions to execute on this market (max 5 per request).

   .. code-block:: python

      from o2_sdk import (
          CancelOrderAction, CreateOrderAction, SettleBalanceAction,
          MarketActions, OrderSide, OrderType,
      )

      batch = MarketActions(
          market_id=market.market_id,
          actions=[
              SettleBalanceAction(to=session.trade_account_id),
              CreateOrderAction(
                  side=OrderSide.BUY,
                  price=str(scaled_price),
                  quantity=str(scaled_qty),
              ),
          ],
      )
      result = await client.batch_actions(session, [batch], collect_orders=True)


WebSocket update models
-----------------------

.. class:: OrderUpdate

   Order update from the WebSocket stream.

   .. attribute:: orders
      :type: list[Order]

   .. attribute:: onchain_timestamp
      :type: str | None

   .. attribute:: seen_timestamp
      :type: str | None

.. class:: TradeUpdate

   Trade update from the WebSocket stream.

   .. attribute:: trades
      :type: list[Trade]

   .. attribute:: market_id
      :type: Id

   .. attribute:: onchain_timestamp
      :type: str | None

   .. attribute:: seen_timestamp
      :type: str | None

.. class:: BalanceUpdate

   Balance update from the WebSocket stream.

   .. attribute:: balance
      :type: list[dict]

   .. attribute:: onchain_timestamp
      :type: str | None

   .. attribute:: seen_timestamp
      :type: str | None

.. class:: NonceUpdate

   Nonce update from the WebSocket stream.

   .. attribute:: contract_id
      :type: Id

   .. attribute:: nonce
      :type: str

   .. attribute:: onchain_timestamp
      :type: str | None

   .. attribute:: seen_timestamp
      :type: str | None


Withdrawal models
-----------------

.. class:: WithdrawResponse

   Response from ``POST /v1/accounts/withdraw``.

   .. attribute:: tx_id
      :type: Id | None

   .. attribute:: message
      :type: str | None

   .. property:: success
      :type: bool

      ``True`` if the withdrawal succeeded.


Whitelist & faucet models
-------------------------

.. class:: WhitelistResponse

   Response from ``POST /analytics/v1/whitelist``.

   .. attribute:: success
      :type: bool

   .. attribute:: trade_account
      :type: str

   .. attribute:: already_whitelisted
      :type: bool

.. class:: FaucetResponse

   Response from the testnet/devnet faucet.

   .. attribute:: message
      :type: str | None

   .. attribute:: error
      :type: str | None

   .. property:: success
      :type: bool

      ``True`` if the mint succeeded.

.. class:: ReferralInfo

   Referral code information.

   .. attribute:: valid
      :type: bool

   .. attribute:: owner_address
      :type: str | None

   .. attribute:: is_active
      :type: bool | None


Aggregated models
-----------------

.. class:: AggregatedAsset

   An asset from the aggregated endpoints.

   .. attribute:: id
      :type: Id

   .. attribute:: symbol
      :type: str

   .. attribute:: name
      :type: str

.. class:: MarketSummary

   Market summary from the aggregated endpoints.

   .. attribute:: market_id
      :type: Id

   .. attribute:: data
      :type: dict

.. class:: MarketTicker

   Market ticker from the aggregated endpoints.

   .. attribute:: market_id
      :type: Id

   .. attribute:: data
      :type: dict
