``crypto`` — Wallets and signing
================================

.. module:: o2_sdk.crypto
   :synopsis: Cryptographic operations — key generation, signing, external signers.

This module implements key generation, message signing, and external signer
support for the O2 Exchange SDK.

.. seealso::

   The O2 Exchange uses a specific on-chain signing format documented at
   `<https://docs.o2.app>`_. The SDK handles this format automatically.


Signer protocol
---------------

.. class:: Signer

   Protocol for objects that can sign messages for the O2 Exchange.

   Both :class:`Wallet` and :class:`EvmWallet` satisfy this protocol.
   For external signing (hardware wallets, AWS KMS, HSMs), use
   :class:`ExternalSigner` or :class:`ExternalEvmSigner`, or implement
   this protocol directly.

   .. property:: b256_address
      :type: str

      The Fuel B256 address (``0x``-prefixed, 66-character hex string).

   .. property:: address_bytes
      :type: bytes

      The address as raw bytes (32 bytes).

   .. method:: personal_sign(message)

      Sign a message using the appropriate ``personal_sign`` format.

      - For **Fuel-native** accounts: ``\x19Fuel Signed Message:\n`` prefix
        + SHA-256.
      - For **EVM** accounts: ``\x19Ethereum Signed Message:\n`` prefix +
        keccak-256.

      :param message: The raw message bytes to sign.
      :type message: bytes
      :returns: A 64-byte Fuel compact signature.
      :rtype: bytes


Wallet classes
--------------

.. class:: Wallet

   A Fuel-native wallet. Satisfies the :class:`Signer` protocol.

   .. attribute:: private_key
      :type: bytes

      The 32-byte private key.

   .. attribute:: public_key
      :type: bytes

      The 65-byte uncompressed secp256k1 public key.

   .. attribute:: b256_address
      :type: str

      The Fuel B256 address (``sha256(public_key[1:])``, ``0x``-prefixed).

   .. property:: address_bytes
      :type: bytes

      The address as raw bytes (32 bytes).

   .. method:: personal_sign(message)

      Sign using Fuel's ``personalSign`` format.

      Computes ``sha256("\x19Fuel Signed Message:\n" + len + message)``
      and signs with secp256k1.

      :param message: The message bytes.
      :type message: bytes
      :returns: A 64-byte Fuel compact signature.
      :rtype: bytes

.. class:: EvmWallet

   An EVM-compatible wallet with B256 zero-padded address. Satisfies the
   :class:`Signer` protocol.

   .. attribute:: private_key
      :type: bytes

      The 32-byte private key.

   .. attribute:: public_key
      :type: bytes

      The 65-byte uncompressed secp256k1 public key.

   .. attribute:: evm_address
      :type: str

      The Ethereum-style address (``0x``-prefixed, 42 characters).

   .. attribute:: b256_address
      :type: str

      The Fuel B256 address (EVM address zero-padded to 32 bytes).

   .. property:: address_bytes
      :type: bytes

      The address as raw bytes (32 bytes).

   .. method:: personal_sign(message)

      Sign using Ethereum's ``personal_sign`` format.

      Computes ``keccak256("\x19Ethereum Signed Message:\n" + len + message)``
      and signs with secp256k1.

      :param message: The message bytes.
      :type message: bytes
      :returns: A 64-byte Fuel compact signature.
      :rtype: bytes


Wallet generation and loading
-----------------------------

.. function:: generate_wallet()

   Generate a new Fuel-native wallet with a random private key.

   :returns: A new :class:`Wallet`.
   :rtype: Wallet

.. function:: generate_evm_wallet()

   Generate a new EVM-compatible wallet with a random private key.

   :returns: A new :class:`EvmWallet`.
   :rtype: EvmWallet

.. function:: load_wallet(private_key_hex)

   Load a Fuel-native wallet from a hex-encoded private key.

   :param private_key_hex: The private key (with or without ``0x`` prefix).
   :type private_key_hex: str
   :returns: The loaded :class:`Wallet`.
   :rtype: Wallet

.. function:: load_evm_wallet(private_key_hex)

   Load an EVM-compatible wallet from a hex-encoded private key.

   :param private_key_hex: The private key (with or without ``0x`` prefix).
   :type private_key_hex: str
   :returns: The loaded :class:`EvmWallet`.
   :rtype: EvmWallet

.. function:: generate_keypair()

   Generate a secp256k1 keypair and derive the Fuel B256 address.

   This is a low-level function; prefer :func:`generate_wallet` for
   most use cases.

   :returns: A tuple of ``(private_key_hex, public_key_bytes_65, b256_address_hex)``.
   :rtype: tuple[str, bytes, str]

.. function:: generate_evm_keypair()

   Generate a secp256k1 keypair with EVM address derivation.

   This is a low-level function; prefer :func:`generate_evm_wallet` for
   most use cases.

   :returns: A tuple of ``(private_key_hex, public_key_bytes_65, evm_address_hex, b256_address_hex)``.
   :rtype: tuple[str, bytes, str, str]


Signing functions
-----------------

.. function:: fuel_compact_sign(private_key_bytes, digest)

   Sign a 32-byte digest and return a 64-byte Fuel compact signature.

   The **Fuel compact signature** format embeds the recovery ID in the
   MSB of byte 32 (first byte of ``s``):

   .. code-block:: text

      s[0] = (recovery_id << 7) | (s[0] & 0x7F)

   The result is ``r(32 bytes) + s(32 bytes) = 64 bytes``.

   :param private_key_bytes: The 32-byte private key.
   :type private_key_bytes: bytes
   :param digest: The 32-byte message digest to sign.
   :type digest: bytes
   :returns: The 64-byte Fuel compact signature.
   :rtype: bytes

.. function:: personal_sign(private_key_bytes, message_bytes)

   Sign a message using Fuel's ``personalSign`` format.

   Used for **session creation** and **withdrawals** with Fuel-native
   wallets.

   Format: ``sha256("\x19Fuel Signed Message:\n" + str(len(msg)) + msg)``

   :param private_key_bytes: The 32-byte private key.
   :type private_key_bytes: bytes
   :param message_bytes: The message to sign.
   :type message_bytes: bytes
   :returns: A 64-byte Fuel compact signature.
   :rtype: bytes

.. function:: raw_sign(private_key_bytes, message_bytes)

   Sign a message using raw SHA-256 (no prefix).

   Used for **session actions** (orders, cancels, settlements).

   Format: ``fuel_compact_sign(key, sha256(msg))``

   :param private_key_bytes: The 32-byte private key.
   :type private_key_bytes: bytes
   :param message_bytes: The message to sign.
   :type message_bytes: bytes
   :returns: A 64-byte Fuel compact signature.
   :rtype: bytes

.. function:: evm_personal_sign(private_key_bytes, message_bytes)

   Sign using Ethereum's ``personal_sign`` prefix + keccak-256.

   Used for session creation and withdrawals with **EVM wallets**.

   Format: ``keccak256("\x19Ethereum Signed Message:\n" + str(len(msg)) + msg)``

   :param private_key_bytes: The 32-byte private key.
   :type private_key_bytes: bytes
   :param message_bytes: The message to sign.
   :type message_bytes: bytes
   :returns: A 64-byte Fuel compact signature.
   :rtype: bytes


External signer support
-----------------------

For production deployments where private keys are managed by hardware
wallets, AWS KMS, Google Cloud KMS, HashiCorp Vault, or other secure
enclaves, use the external signer classes.

.. data:: SignDigestFn

   Type alias for external signing callbacks.

   .. code-block:: python

      SignDigestFn = Callable[[bytes], bytes]

   The callback receives a **32-byte digest** and must return a **64-byte
   Fuel compact signature**. Use :func:`to_fuel_compact_signature` to
   convert from standard ``(r, s, recovery_id)`` components.

.. function:: to_fuel_compact_signature(r, s, recovery_id)

   Convert standard ``(r, s, recovery_id)`` components to a 64-byte
   Fuel compact signature.

   This is a helper for implementing :data:`SignDigestFn` callbacks when
   your external signing service returns standard secp256k1 components.

   :param r: 32-byte ``r`` component.
   :type r: bytes
   :param s: 32-byte ``s`` component (must be low-s normalised).
   :type s: bytes
   :param recovery_id: Recovery ID (``0`` or ``1``).
   :type recovery_id: int
   :returns: 64-byte Fuel compact signature.
   :rtype: bytes
   :raises ValueError: If ``r`` or ``s`` is not 32 bytes, or
       ``recovery_id`` is not 0 or 1.

   .. code-block:: python

      def my_kms_sign(digest: bytes) -> bytes:
          r, s, v = kms_client.sign(digest)
          return to_fuel_compact_signature(r, s, v)

.. class:: ExternalSigner(b256_address, sign_digest)

   A Fuel-native signer backed by an external signing function.

   The SDK handles Fuel-specific message framing (prefix + SHA-256
   hashing); your callback only needs to sign a raw 32-byte digest.

   :param b256_address: The Fuel B256 address for this signer.
   :type b256_address: str
   :param sign_digest: A callback that signs a 32-byte digest and
       returns a 64-byte Fuel compact signature.
   :type sign_digest: :data:`SignDigestFn`

   .. code-block:: python

      from o2_sdk import ExternalSigner, to_fuel_compact_signature

      def kms_sign(digest: bytes) -> bytes:
          r, s, v = my_kms.sign(key_id="...", digest=digest)
          return to_fuel_compact_signature(r, s, v)

      signer = ExternalSigner(
          b256_address="0x1234...abcd",
          sign_digest=kms_sign,
      )
      session = await client.create_session(owner=signer, markets=["fFUEL/fUSDC"])

.. class:: ExternalEvmSigner(b256_address, evm_address, sign_digest)

   An EVM signer backed by an external signing function.

   Same as :class:`ExternalSigner` but uses Ethereum ``personal_sign``
   message framing (prefix + keccak-256 hashing).

   :param b256_address: The Fuel B256 address (EVM address zero-padded).
   :type b256_address: str
   :param evm_address: The Ethereum address.
   :type evm_address: str
   :param sign_digest: A callback that signs a 32-byte digest.
   :type sign_digest: :data:`SignDigestFn`

   .. code-block:: python

      from o2_sdk import ExternalEvmSigner, to_fuel_compact_signature

      signer = ExternalEvmSigner(
          b256_address="0x000000000000000000000000abcd...1234",
          evm_address="0xabcd...1234",
          sign_digest=kms_sign,
      )
