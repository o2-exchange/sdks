External Signers Guide
======================

For production deployments, you likely manage private keys in a secure
enclave (hardware wallet, AWS KMS, Google Cloud KMS, HashiCorp Vault,
etc.) rather than in-process. The O2 SDK supports this via the
:class:`~o2_sdk.crypto.ExternalSigner` and
:class:`~o2_sdk.crypto.ExternalEvmSigner` classes.


How it works
------------

The SDK handles all message framing (prefix bytes, hashing) internally
via the shared helpers :func:`~o2_sdk.crypto.fuel_personal_sign_digest`
(Fuel) and :func:`~o2_sdk.crypto.evm_personal_sign_digest` (EVM).
Your external signing function only needs to:

1. **Receive** a 32-byte digest.
2. **Sign** it with secp256k1 (ECDSA).
3. **Return** a 64-byte Fuel compact signature.

Use :func:`~o2_sdk.crypto.to_fuel_compact_signature` to convert from
standard ``(r, s, recovery_id)`` components.


Fuel-native external signer
----------------------------

For Fuel-native accounts:

.. code-block:: python

   from o2_sdk import O2Client, Network, OrderSide, ExternalSigner, to_fuel_compact_signature

   def my_kms_sign(digest: bytes) -> bytes:
       """Sign a 32-byte digest using your KMS/HSM."""
       r, s, recovery_id = my_kms.sign(key_id="my-key", digest=digest)
       return to_fuel_compact_signature(r, s, recovery_id)

   signer = ExternalSigner(
       b256_address="0x1234...abcd",  # Your Fuel B256 address
       sign_digest=my_kms_sign,
   )

   async with O2Client(network=Network.MAINNET) as client:
       account = await client.setup_account(signer)
       session = await client.create_session(
           owner=signer, markets=["FUEL/USDC"]
       )
       result = await client.create_order(
           "FUEL/USDC", OrderSide.BUY, 0.02, 100.0
       )

For session creation and sequential withdrawals, the SDK calls
``my_kms_sign`` with a Fuel-prefixed SHA-256 digest. For a parallel
withdrawal it passes the final SRC-16 typed-data digest directly.

.. important::

   Session **actions** (orders, cancels, settlements) are signed with the
   session key — not the external signer. The external signer is only
   needed for session creation and withdrawals.


EVM external signer
--------------------

For EVM-compatible accounts (MetaMask, Ledger via Ethereum, etc.):

.. code-block:: python

   from o2_sdk import ExternalEvmSigner, to_fuel_compact_signature

   signer = ExternalEvmSigner(
       b256_address="0x000000000000000000000000abcd...1234",
       evm_address="0xabcd...1234",
       sign_digest=my_kms_sign,  # Same callback interface
   )

For personal-sign operations, :class:`ExternalEvmSigner` uses Ethereum's
``\x19Ethereum Signed Message:\n`` prefix + keccak-256, while
:class:`ExternalSigner` uses Fuel's ``\x19Fuel Signed Message:\n`` prefix +
SHA-256. For typed withdrawals the distinction is EIP-712 versus SRC-16;
both classes still pass one final 32-byte digest to the callback.


Implementing the callback
--------------------------

The :data:`~o2_sdk.crypto.SignDigestFn` callback must return a **64-byte
Fuel compact signature**. Here is how to build one from standard
components:

.. code-block:: python

   from o2_sdk import to_fuel_compact_signature

   def sign_digest(digest: bytes) -> bytes:
       # Your KMS/HSM returns (r, s, recovery_id)
       r: bytes = ...   # 32 bytes
       s: bytes = ...   # 32 bytes (must be low-s normalized)
       v: int   = ...   # 0 or 1

       return to_fuel_compact_signature(r, s, v)

The Fuel compact format stores the recovery ID in the MSB of the first
byte of ``s``:

.. code-block:: text

   s[0] = (recovery_id << 7) | (s[0] & 0x7F)

.. warning::

   The ``s`` component **must be low-s normalized** before passing to
   :func:`~o2_sdk.crypto.to_fuel_compact_signature`. Most modern signing
   libraries (coincurve, ethers.js, etc.) do this automatically, but
   check your KMS documentation.


AWS KMS example
----------------

.. code-block:: python

   import boto3
   from o2_sdk import ExternalSigner, to_fuel_compact_signature

   kms = boto3.client("kms")

   def aws_kms_sign(digest: bytes) -> bytes:
       response = kms.sign(
           KeyId="alias/my-trading-key",
           Message=digest,
           MessageType="DIGEST",
           SigningAlgorithm="ECDSA_SHA_256",
       )
       # Parse DER-encoded signature to (r, s)
       der_sig = response["Signature"]
       r, s, v = parse_der_signature(der_sig)  # your DER parser
       return to_fuel_compact_signature(r, s, v)

   signer = ExternalSigner(
       b256_address="0x...",
       sign_digest=aws_kms_sign,
   )


Custom Signer protocol
-----------------------

You can also implement the :class:`~o2_sdk.crypto.Signer` protocol
directly for full control. Use the shared digest helpers to ensure your
personal-sign framing matches the SDK. The protocol also exposes
``sign_digest`` for typed operations:

.. code-block:: python

   from o2_sdk import fuel_personal_sign_digest

   class MyCustomSigner:
       @property
       def b256_address(self) -> str:
           return "0x..."

       @property
       def address_bytes(self) -> bytes:
           return bytes.fromhex(self.b256_address[2:])

       def personal_sign(self, message: bytes) -> bytes:
           digest = fuel_personal_sign_digest(message)
           # Sign the 32-byte digest with your own signing backend
           return my_backend_sign(digest)

       def sign_digest(self, digest: bytes) -> bytes:
           # The SDK has already applied SRC-16/EIP-712 hashing here.
           return my_backend_sign(digest)

   signer = MyCustomSigner()
   session = await client.create_session(owner=signer, markets=["FUEL/USDC"])

For EVM accounts, use :func:`~o2_sdk.crypto.evm_personal_sign_digest`
instead.

.. important::

   A custom signer may raise :class:`NotImplementedError` from
   ``sign_digest`` if its backend does not support raw-digest signing. This is
   safe for existing functionality: the SDK only calls ``sign_digest`` when a
   typed operation is selected, currently a parallel withdrawal. Sequential
   withdrawals and session creation use ``personal_sign``.

   .. code-block:: python

      def sign_digest(self, digest: bytes) -> bytes:
          raise NotImplementedError("typed operations are not supported")
