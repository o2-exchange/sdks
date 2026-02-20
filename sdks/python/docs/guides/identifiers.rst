Identifiers and Wallet Types
============================

This guide explains when to use Fuel-native vs EVM wallets, and how
identifiers map to O2 API/SDK calls.

Wallet choice
-------------

- **Fuel-native wallet**: best when you want interoperability with other Fuel ecosystem apps.
- **EVM wallet**: best when you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

Owner identity rule
-------------------

O2 owner identity is always **Fuel B256** (``0x`` + 64 hex chars).

- Fuel-native wallets provide ``b256_address`` directly.
- EVM wallets provide:
  - ``evm_address`` (``0x`` + 40 hex chars)
  - ``b256_address`` (``0x`` + 64 hex chars)

For EVM wallets:

.. code-block:: text

   owner_b256 = 0x000000000000000000000000 + evm_address[2:]

So ``evm_address`` is not passed directly as O2 ``owner_id``; ``b256_address`` is.

Which identifier goes where
---------------------------

- **Account/session owner lookups**: owner ``b256_address``
- **Trading account state**: ``trade_account_id`` (contract ID)
- **Market selection**: pair string (``"fFUEL/fUSDC"``) or ``market_id``
- **EVM display/bridge context**: ``evm_address``

Example
-------

.. code-block:: python

   evm_owner = client.generate_evm_wallet()
   print(evm_owner.evm_address)    # 20-byte Ethereum address
   print(evm_owner.b256_address)   # 32-byte Fuel owner identity (zero-left-padded)

   await client.setup_account(evm_owner)  # uses b256_address as owner_id
   await client.create_session(owner=evm_owner, markets=["fFUEL/fUSDC"])
