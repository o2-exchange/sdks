``encoding`` — Fuel ABI encoding
=================================

.. module:: o2_sdk.encoding
   :synopsis: Fuel ABI encoding primitives for the O2 Exchange SDK.

Low-level encoding functions used internally to construct signed payloads
for the O2 Exchange on-chain contracts. You typically do not need to use
these directly — :class:`~o2_sdk.client.O2Client` handles encoding
automatically.

.. note::

   Fuel function selectors are **not hash-based** like Solidity's 4-byte
   keccak selectors. Instead, they are encoded as
   ``u64(len(name)) + utf8(name)``.


Constants
---------

.. data:: GAS_MAX
   :value: 18446744073709551615

   ``u64::MAX`` — the gas limit used for all contract calls.


Primitive encoding
------------------

.. function:: u64_be(value)

   Encode an integer as 8 bytes in big-endian (u64) format.

   :param value: The integer to encode.
   :type value: int
   :returns: 8-byte big-endian representation.
   :rtype: bytes

.. function:: function_selector(name)

   Encode a Fuel ABI function selector.

   Format: ``u64_be(len(name)) + utf8(name)``

   :param name: The function name (e.g., ``"create_order"``).
   :type name: str
   :returns: The encoded selector.
   :rtype: bytes

.. function:: encode_identity(discriminant, address_bytes)

   Encode a Fuel ``Identity`` enum value.

   Format: ``u64(discriminant) + 32-byte address``

   :param discriminant: ``0`` for ``Address``, ``1`` for ``ContractId``.
   :type discriminant: int
   :param address_bytes: The 32-byte address.
   :type address_bytes: bytes
   :returns: 40-byte encoded identity.
   :rtype: bytes
   :raises ValueError: If ``address_bytes`` is not 32 bytes.


Option encoding
---------------

.. function:: encode_option_none()

   Encode ``Option::None``: ``u64(0)``.

   :returns: 8-byte None encoding.
   :rtype: bytes

.. function:: encode_option_some(data)

   Encode ``Option::Some(data)``: ``u64(1) + data``.

   :param data: The inner data bytes.
   :type data: bytes
   :returns: Encoded option.
   :rtype: bytes

.. function:: encode_option_call_data(data_or_none)

   Encode ``Option`` for ``call_data`` in action signing bytes.

   - ``None`` → ``u64(0)``
   - ``Some`` → ``u64(1) + u64(len(data)) + data``

   :param data_or_none: The call data bytes, or ``None``.
   :type data_or_none: bytes | None
   :returns: Encoded option.
   :rtype: bytes


Order encoding
--------------

.. function:: encode_order_args(price, quantity, order_type, order_type_data=None)

   Encode ``OrderArgs`` struct for ``CreateOrder`` call data.

   Layout: ``u64(price) + u64(quantity) + order_type_encoding``

   Order type variants are **tightly packed** (no padding to largest
   variant size):

   .. list-table::
      :header-rows: 1
      :widths: 20 10 50

      * - Variant
        - Discriminant
        - Encoding
      * - ``Limit``
        - 0
        - ``u64(0) + u64(price) + u64(timestamp)`` (24 bytes)
      * - ``Spot``
        - 1
        - ``u64(1)`` (8 bytes)
      * - ``FillOrKill``
        - 2
        - ``u64(2)`` (8 bytes)
      * - ``PostOnly``
        - 3
        - ``u64(3)`` (8 bytes)
      * - ``Market``
        - 4
        - ``u64(4)`` (8 bytes)
      * - ``BoundedMarket``
        - 5
        - ``u64(5) + u64(max_price) + u64(min_price)`` (24 bytes)

   :param price: Scaled price (on-chain integer).
   :type price: int
   :param quantity: Scaled quantity (on-chain integer).
   :type quantity: int
   :param order_type: Order type name.
   :type order_type: str
   :param order_type_data: Additional data for ``Limit`` or
       ``BoundedMarket`` types.
   :type order_type_data: dict | None
   :returns: Encoded order arguments.
   :rtype: bytes


Signing payload construction
-----------------------------

.. function:: build_session_signing_bytes(nonce, chain_id, session_address, contract_ids, expiry)

   Build the signing payload for ``set_session``.

   Layout:

   .. code-block:: text

      u64(nonce) + u64(chain_id) + function_selector("set_session")
      + u64(1)              [Option::Some]
      + u64(0)              [Identity::Address]
      + session_address     [32 bytes]
      + u64(expiry)
      + u64(len(contract_ids))
      + concat(contract_ids) [32 bytes each]

   :param nonce: Current account nonce.
   :type nonce: int
   :param chain_id: The Fuel chain ID.
   :type chain_id: int
   :param session_address: The 32-byte session wallet address.
   :type session_address: bytes
   :param contract_ids: List of 32-byte market contract IDs.
   :type contract_ids: list[bytes]
   :param expiry: Session expiry (Unix timestamp).
   :type expiry: int
   :returns: The bytes to sign with ``personalSign``.
   :rtype: bytes

.. function:: build_actions_signing_bytes(nonce, calls)

   Build the signing payload for session actions.

   Layout:

   .. code-block:: text

      u64(nonce) + u64(num_calls)
      + for each call:
          contract_id            [32 bytes]
          + u64(selector_len)
          + selector             [variable]
          + u64(amount)
          + asset_id             [32 bytes]
          + u64(gas)
          + encode_option_call_data(call_data)

   :param nonce: Current account nonce.
   :type nonce: int
   :param calls: List of low-level call dicts (as returned by
       :func:`action_to_call`).
   :type calls: list[dict]
   :returns: The bytes to sign with ``rawSign``.
   :rtype: bytes

.. function:: action_to_call(action, market_info)

   Convert a high-level action dict to a low-level contract call dict.

   Supported action types:

   - ``CreateOrder`` — Place a new order.
   - ``CancelOrder`` — Cancel an existing order.
   - ``SettleBalance`` — Settle filled proceeds.
   - ``RegisterReferer`` — Register a referrer.

   :param action: A high-level action dict (e.g.,
       ``{"CreateOrder": {...}}``).
   :type action: dict
   :param market_info: Market metadata dict with ``contract_id``,
       ``market_id``, ``base``, ``quote``, and ``accounts_registry_id``.
   :type market_info: dict
   :returns: A low-level call dict with ``contract_id``,
       ``function_selector``, ``amount``, ``asset_id``, ``gas``, and
       ``call_data``.
   :rtype: dict
   :raises ValueError: If the action type is unknown.
