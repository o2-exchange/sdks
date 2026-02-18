O2 SDK for Python
=================

.. image:: https://img.shields.io/badge/python-3.10+-blue.svg
   :target: https://python.org
   :alt: Python 3.10+

.. image:: https://img.shields.io/badge/License-Apache_2.0-blue.svg
   :target: https://github.com/o2-exchange/sdks/blob/main/LICENSE
   :alt: License: Apache 2.0

The official Python SDK for the `O2 Exchange <https://o2.app>`_ — a fully
on-chain central limit order book (CLOB) DEX on the
`Fuel Network <https://fuel.network>`_.

This SDK provides everything you need to trade programmatically on the O2
Exchange: wallet management, account lifecycle, session-based trading, market
data retrieval, and real-time WebSocket streaming.

.. tip::

   For general information about the O2 Exchange platform, see the
   `O2 Exchange documentation <https://docs.o2.app>`_.

Quick example
-------------

.. code-block:: python

   import asyncio
   from o2_sdk import O2Client, Network, OrderSide

   async def main():
       client = O2Client(network=Network.TESTNET)
       owner = client.generate_wallet()
       account = await client.setup_account(owner)
       session = await client.create_session(owner=owner, markets=["FUEL/USDC"])
       result = await client.create_order(
           "FUEL/USDC", OrderSide.BUY, price=0.02, quantity=100.0
       )
       print(result.tx_id)
       await client.close()

   asyncio.run(main())

.. toctree::
   :maxdepth: 2
   :caption: User Guide

   installation
   quickstart
   concepts

.. toctree::
   :maxdepth: 2
   :caption: API Reference

   api/client
   api/models
   api/crypto
   api/errors
   api/config
   api/websocket
   api/encoding
   api/low_level_api

.. toctree::
   :maxdepth: 2
   :caption: Guides

   guides/trading
   guides/market_data
   guides/websocket_streams
   guides/external_signers
   guides/error_handling

.. toctree::
   :maxdepth: 1
   :caption: Project

   changelog
