Evaluation Accounts
===================

Buy evaluations with a mainnet client. For test purchases, use
``Network.TESTNET`` and testnet funds. Discover the shop through
``client.api.get_markets()`` and authorize it when creating a session:

.. code-block:: python

   from o2_sdk import Network, O2Client, O2Error
   from o2_sdk.crypto import Signer

   async def buy_evaluation(owner: Signer, tier_id: int, asset_id: str, amount: int):
       async with O2Client(network=Network.MAINNET) as client:
           shop_id = (await client.api.get_markets()).eval_shop_id
           if shop_id is None:
               raise O2Error(message="Evaluation purchases are unavailable")
           await client.setup_account(owner)
           await client.create_session(owner, [], extra_contract_ids=[shop_id])
           return await client.buy_eval_account(tier_id, asset_id, amount)

``tier_id`` and ``amount`` must be unsigned 64-bit integers. Pass the payment
asset's full 32-byte hex ID and the exact price in token base units. The SDK does
not fetch product prices or convert human amounts. Your trading account pays
for the evaluation; the API pays gas. Check the returned action response and
confirm the transaction before expecting the purchased account to be available.
Reconcile a timeout or connection failure before submitting another purchase.

Network and trading scope
-------------------------

``Network.EVAL`` connects to ``https://api.eval.o2.app`` and
``wss://api.eval.o2.app/v1/ws`` using Fuel testnet RPC. It has no faucet.
Purchases use mainnet (or testnet for testing), separately from the eval network.

Python currently supports purchases and eval network configuration. The Turbo
account lifecycle, margin trading, positions, valuation and rule helpers remain
available in the TypeScript SDK. Configuring ``Network.EVAL`` alone does not
provide those helpers. The backend enforces evaluation rules and confirms passes.
