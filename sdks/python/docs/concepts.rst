Key Concepts
============

This page covers the core concepts you need to understand when integrating
with the O2 Exchange via the Python SDK.

.. seealso::

   For a comprehensive overview of the O2 Exchange architecture, see the
   `O2 Exchange documentation <https://docs.o2.app>`_.

On-chain order book
-------------------

O2 is a **central limit order book (CLOB)** implemented entirely on-chain
using Sway smart contracts on the Fuel Network. Unlike AMM-based DEXs, O2
matches orders in a traditional price-time priority order book.

All order matching, settlement, and balance management happens on-chain.
The SDK communicates with an off-chain executor layer that sponsors gas and
forwards signed transactions to the Fuel blockchain.

Wallets and identities
----------------------

The SDK supports two types of wallets:

.. list-table::
   :header-rows: 1
   :widths: 20 40 40

   * - Type
     - Address format
     - Use case
   * - :class:`~o2_sdk.crypto.Wallet`
     - Fuel B256 (``sha256(pubkey)``, 32 bytes)
     - Fuel-native accounts
   * - :class:`~o2_sdk.crypto.EvmWallet`
     - EVM address zero-padded to 32 bytes
     - Ethereum/EVM accounts bridged to Fuel

Both wallet types implement the :class:`~o2_sdk.crypto.Signer` protocol and
can be used interchangeably throughout the SDK.

Trading accounts
----------------

A **trading account** is an on-chain contract that holds your balances and
tracks your nonce (action counter). It is identified by a ``trade_account_id``
(a ``0x``-prefixed hex contract ID).

Use :meth:`~o2_sdk.client.O2Client.setup_account` to create or verify a
trading account. This method is idempotent and safe to call on every startup.

Sessions
--------

The O2 Exchange uses a **session-based signing model** to avoid requiring
the owner's private key for every trade. When you create a session:

1. A temporary session keypair is generated.
2. The owner wallet signs a delegation that authorizes the session key to
   act on specific markets for a set duration.
3. Subsequent trade actions are signed with the lightweight session key.

.. important::

   - **Session creation** uses ``personalSign`` (message prefix + hash).
   - **Session actions** (orders, cancels, settlements) use ``rawSign``
     (plain SHA-256 hash).
   - The SDK handles this distinction automatically.

Sessions are scoped to specific market contracts and expire after a
configurable number of days (default: 30).

Nonce management
-----------------

Every action on-chain increments the account's **nonce**. The SDK caches and
auto-increments the nonce, but there is an important caveat:

.. warning::

   The nonce increments on-chain **even when a transaction reverts**. If an
   action fails, the SDK automatically calls
   :meth:`~o2_sdk.client.O2Client.refresh_nonce` to resynchronize.

You can also manually refresh the nonce:

.. code-block:: python

   nonce = await client.refresh_nonce(session)

Markets
-------

A **market** represents a trading pair on the O2 Exchange (e.g.,
``FUEL/USDC``). Each market has:

- A ``contract_id`` — the on-chain contract managing the order book.
- A ``market_id`` — a unique identifier within the contract.
- ``base`` and ``quote`` assets, each with their own ``decimals`` and
  ``max_precision``.
- Fee rates (``maker_fee``, ``taker_fee``), ``min_order`` size, and
  ``dust`` threshold.

The SDK automatically resolves human-readable pair names (like
``"fFUEL/fUSDC"``) to their on-chain identifiers.

Price and quantity scaling
--------------------------

On-chain, prices and quantities are represented as unsigned 64-bit integers
scaled by the asset's decimal places. The SDK converts between human-readable
floats and on-chain integers automatically:

.. code-block:: python

   market = await client.get_market("fFUEL/fUSDC")

   # Human → on-chain
   chain_price = market.scale_price(0.025)    # e.g. 25000
   chain_qty   = market.scale_quantity(100.0)  # e.g. 100000000000

   # On-chain → human
   human_price = market.format_price(25000)    # 0.025
   human_qty   = market.format_quantity(100000000000)  # 100.0

Order types
-----------

The ``order_type`` parameter accepts :class:`~o2_sdk.models.OrderType` enum
values for simple types, or typed dataclasses for ``Limit`` and
``BoundedMarket``:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Type
     - Description
   * - ``OrderType.SPOT``
     - Standard limit order. Rests on the book if not immediately matched.
   * - ``OrderType.MARKET``
     - Executes immediately at the best available price. Fails if the book
       is empty.
   * - ``OrderType.POST_ONLY``
     - Guaranteed to be a maker order. Rejected if it would cross the spread
       and match immediately.
   * - ``OrderType.FILL_OR_KILL``
     - Must be filled entirely or not at all.
   * - ``LimitOrder(price, timestamp)``
     - Like Spot but includes a limit price and a timestamp for
       time-in-force semantics.
   * - ``BoundedMarketOrder(max_price, min_price)``
     - Market order with price bounds.

Batch actions
-------------

The O2 Exchange supports submitting up to **5 actions** in a single
transaction via :meth:`~o2_sdk.client.O2Client.batch_actions`. Actions are
strongly typed using dataclasses and grouped by market using
:class:`~o2_sdk.models.MarketActions`:

- :class:`~o2_sdk.models.CreateOrderAction` — Place a new order.
- :class:`~o2_sdk.models.CancelOrderAction` — Cancel an existing order.
- :class:`~o2_sdk.models.SettleBalanceAction` — Settle filled order
  proceeds back to your trading account.
- :class:`~o2_sdk.models.RegisterRefererAction` — Register a referer.

A common pattern is to settle + cancel + place in one batch:

.. code-block:: python

   from o2_sdk import (
       CancelOrderAction, CreateOrderAction, SettleBalanceAction,
       MarketActions, OrderSide, OrderType,
   )

   actions = [
       SettleBalanceAction(to=session.trade_account_id),
       CancelOrderAction(order_id=old_order_id),
       CreateOrderAction(
           side=OrderSide.BUY,
           price=str(scaled_price),
           quantity=str(scaled_qty),
           order_type=OrderType.SPOT,
       ),
   ]
   result = await client.batch_actions(
       session,
       [MarketActions(market_id=market.market_id, actions=actions)],
   )

Signing model
-------------

.. list-table::
   :header-rows: 1
   :widths: 25 25 50

   * - Operation
     - Signing method
     - Details
   * - Session creation
     - ``personalSign``
     - Fuel: ``\x19Fuel Signed Message:\n`` + SHA-256.
       EVM: ``\x19Ethereum Signed Message:\n`` + keccak-256.
   * - Session actions
     - ``rawSign``
     - Plain ``SHA-256(payload)`` signed with the session key.
   * - Withdrawals
     - ``personalSign``
     - Same as session creation, signed with the owner key.

The session wallet always uses Fuel-style signing, even when the owner is
an EVM wallet.
