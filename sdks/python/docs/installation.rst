Installation
============

Requirements
------------

- **Python 3.10** or newer
- A working C compiler (required by the ``coincurve`` dependency)

Install from PyPI
-----------------

.. code-block:: bash

   pip install o2-sdk

Install from source
-------------------

.. code-block:: bash

   git clone https://github.com/o2-exchange/sdks.git
   cd sdks
   pip install -e sdks/python

Development install
-------------------

To install with development dependencies (linting, testing, type checking):

.. code-block:: bash

   pip install -e "sdks/python[dev]"

Dependencies
------------

The SDK uses the following runtime dependencies:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Package
     - Purpose
   * - `coincurve <https://pypi.org/project/coincurve/>`_ >=20.0.0
     - secp256k1 elliptic curve cryptography (key generation, signing)
   * - `aiohttp <https://pypi.org/project/aiohttp/>`_ >=3.9.0
     - Async HTTP client for REST API calls
   * - `websockets <https://pypi.org/project/websockets/>`_ >=12.0
     - WebSocket client for real-time data streams
   * - `pycryptodome <https://pypi.org/project/pycryptodome/>`_ >=3.20.0
     - Keccak-256 hashing (EVM address derivation)

Verifying the installation
--------------------------

.. code-block:: python

   import o2_sdk
   print("o2-sdk installed successfully")

   # Quick connectivity check
   import asyncio
   from o2_sdk import O2Client, Network

   async def check():
       client = O2Client(network=Network.TESTNET)
       markets = await client.get_markets()
       print(f"Connected — {len(markets)} markets available")
       await client.close()

   asyncio.run(check())
