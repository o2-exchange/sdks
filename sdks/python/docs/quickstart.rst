Quick Start
===========

This guide walks you through the five steps needed to place your first trade
on the O2 Exchange using the Python SDK.

.. seealso::

   For background on how the O2 Exchange works, see the
   `O2 Exchange documentation <https://docs.o2.app>`_.

Step 1: Initialise the client
-----------------------------

.. code-block:: python

   from o2_sdk import O2Client, Network

   client = O2Client(network=Network.TESTNET)

The client connects to the O2 testnet by default. Pass ``Network.MAINNET``
for production trading. You can also provide a custom
:class:`~o2_sdk.config.NetworkConfig` for private deployments.

Step 2: Create a wallet
-----------------------

.. code-block:: python

   # Fuel-native wallet
   owner = client.generate_wallet()
   print(owner.b256_address)  # 0x-prefixed, 66-character hex

   # — or load an existing private key —
   owner = client.load_wallet("0xabcd...1234")

The SDK supports both Fuel-native wallets and EVM-compatible wallets:

.. code-block:: python

   # EVM wallet (Ethereum-style address, zero-padded for Fuel)
   evm_owner = client.generate_evm_wallet()
   print(evm_owner.evm_address)    # 0x-prefixed, 42-character hex
   print(evm_owner.b256_address)   # zero-padded to 32 bytes

.. warning::

   Never hard-code private keys in source code. Use environment variables or
   a secrets manager for production deployments.

Step 3: Set up a trading account
---------------------------------

.. code-block:: python

   account = await client.setup_account(owner)
   print(account.trade_account_id)

:meth:`~o2_sdk.client.O2Client.setup_account` is **idempotent** — it is safe
to call on every bot startup. It performs the following steps automatically:

1. Checks whether an account already exists for the wallet address.
2. Creates a new trading account if needed.
3. Mints test tokens via the faucet (testnet/devnet only).
4. Whitelists the account for trading.

Step 4: Create a trading session
--------------------------------

.. code-block:: python

   session = await client.create_session(
       owner=owner,
       markets=["fFUEL/fUSDC"],
       expiry_days=30,
   )

A **session** delegates signing authority from your owner wallet to a
temporary session key. This allows the SDK to sign trade actions without
needing the owner key for every request. Sessions are scoped to specific
markets and expire after the specified number of days.

.. note::

   Session creation uses ``personalSign`` (Fuel prefix + SHA-256 for
   Fuel-native wallets, or Ethereum prefix + keccak-256 for EVM wallets).
   Session *actions* use ``rawSign`` (plain SHA-256). The SDK handles this
   distinction automatically.

Step 5: Place an order
-----------------------

.. code-block:: python

   result = await client.create_order(
       session=session,
       market="fFUEL/fUSDC",
       side="Buy",
       price=0.02,
       quantity=100.0,
       order_type="Spot",
   )

   if result.success:
       print(f"Order placed! tx_id={result.tx_id}")
       if result.orders:
           print(f"Order ID: {result.orders[0].order_id}")

Prices and quantities are specified as **human-readable floats**. The SDK
scales them to on-chain integer representation automatically, honouring the
market's precision and dust constraints.

Cleanup
-------

Always close the client when you are done:

.. code-block:: python

   await client.close()

Or use the async context manager:

.. code-block:: python

   async with O2Client(network=Network.TESTNET) as client:
       # ... your trading logic ...
       pass  # close() is called automatically

Complete example
----------------

.. code-block:: python

   import asyncio
   from o2_sdk import O2Client, Network

   async def main():
       async with O2Client(network=Network.TESTNET) as client:
           # Wallet + account
           owner = client.generate_wallet()
           account = await client.setup_account(owner)

           # Session
           session = await client.create_session(
               owner=owner,
               markets=["fFUEL/fUSDC"],
           )

           # Place order
           result = await client.create_order(
               session, "fFUEL/fUSDC", "Buy",
               price=0.02, quantity=100.0,
           )
           print(f"tx_id={result.tx_id}")

           # Check balances
           balances = await client.get_balances(account)
           for symbol, bal in balances.items():
               print(f"{symbol}: {bal.trading_account_balance}")

   asyncio.run(main())

Next steps
----------

- :doc:`guides/trading` — Order types, batch actions, cancel/replace patterns
- :doc:`guides/market_data` — Fetching depth, trades, candles, and ticker data
- :doc:`guides/websocket_streams` — Real-time data with ``async for``
- :doc:`api/client` — Full API reference for :class:`~o2_sdk.client.O2Client`
