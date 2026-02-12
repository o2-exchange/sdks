``config`` — Network configuration
===================================

.. module:: o2_sdk.config
   :synopsis: Network configuration for the O2 Exchange SDK.


Networks
--------

.. class:: Network

   Enum of available O2 Exchange networks.

   .. attribute:: TESTNET
      :value: "testnet"

      The O2 testnet (for testing and development). Includes a faucet
      for obtaining test tokens.

   .. attribute:: DEVNET
      :value: "devnet"

      The O2 devnet (for internal/early development). Includes a faucet.

   .. attribute:: MAINNET
      :value: "mainnet"

      The O2 mainnet (production). No faucet available.

   Usage:

   .. code-block:: python

      from o2_sdk import O2Client, Network

      # Testnet (default)
      client = O2Client(network=Network.TESTNET)

      # Mainnet
      client = O2Client(network=Network.MAINNET)


Network configuration
---------------------

.. class:: NetworkConfig

   Configuration for connecting to an O2 Exchange network.

   This is a frozen (immutable) dataclass. Pass a custom instance to
   :class:`~o2_sdk.client.O2Client` for private deployments or custom
   endpoints.

   .. attribute:: api_base
      :type: str

      Base URL for REST API calls (e.g., ``"https://api.testnet.o2.app"``).

   .. attribute:: ws_url
      :type: str

      WebSocket URL for real-time streams (e.g.,
      ``"wss://api.testnet.o2.app/v1/ws"``).

   .. attribute:: fuel_rpc
      :type: str

      Fuel Network RPC endpoint.

   .. attribute:: faucet_url
      :type: str | None

      Faucet URL for test token minting. ``None`` for mainnet.

   .. code-block:: python

      from o2_sdk import O2Client, NetworkConfig

      custom = NetworkConfig(
          api_base="https://my-private-api.example.com",
          ws_url="wss://my-private-api.example.com/v1/ws",
          fuel_rpc="https://my-fuel-node.example.com/v1/graphql",
          faucet_url=None,
      )
      client = O2Client(custom_config=custom)


Built-in endpoints
------------------

.. list-table::
   :header-rows: 1
   :widths: 15 40 35 10

   * - Network
     - REST API
     - WebSocket
     - Faucet
   * - Testnet
     - ``https://api.testnet.o2.app``
     - ``wss://api.testnet.o2.app/v1/ws``
     - Yes
   * - Devnet
     - ``https://api.devnet.o2.app``
     - ``wss://api.devnet.o2.app/v1/ws``
     - Yes
   * - Mainnet
     - ``https://api.o2.app``
     - ``wss://api.o2.app/v1/ws``
     - No


Helper function
---------------

.. function:: get_config(network)

   Return the built-in :class:`NetworkConfig` for the given network.

   :param network: The target network.
   :type network: Network
   :returns: The network configuration.
   :rtype: NetworkConfig
