"""Cryptographic operations for the O2 Exchange SDK.

Implements:
- Key generation (Fuel-native SHA-256 and EVM keccak256 address derivation)
- personalSign (Fuel prefix: b"\\x19Fuel Signed Message:\\n" + len + message)
- rawSign (sha256(message) then fuel_compact_sign)
- evm_personal_sign (Ethereum prefix + keccak256)
- fuel_compact_sign with low-s normalization and recovery ID in MSB of byte 32
- External signer support (hardware wallets, KMS, HSMs)
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from coincurve import PrivateKey
from Crypto.Hash import keccak

logger = logging.getLogger("o2_sdk.crypto")

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

SignDigestFn = Callable[[bytes], bytes]
"""Callback type for external signing functions.

Receives a 32-byte digest and must return a 64-byte Fuel compact signature
(r[32] + s[32] with recovery ID embedded in the MSB of s[0]).

See :func:`to_fuel_compact_signature` for a helper to build this format
from standard (r, s, recovery_id) components.
"""


# ---------------------------------------------------------------------------
# Signer protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class Signer(Protocol):
    """Protocol for objects that can sign messages for the O2 Exchange.

    Both :class:`Wallet` and :class:`EvmWallet` satisfy this protocol.
    For external signing (hardware wallets, AWS KMS, HSMs, etc.), use
    :class:`ExternalSigner` or :class:`ExternalEvmSigner`, or implement
    this protocol directly.
    """

    @property
    def b256_address(self) -> str:
        """The Fuel B256 address (``0x``-prefixed, 66-char hex string)."""
        ...

    @property
    def address_bytes(self) -> bytes:
        """The address as raw bytes (32 bytes)."""
        ...

    def personal_sign(self, message: bytes) -> bytes:
        """Sign a message using the appropriate personal_sign format.

        For Fuel-native accounts: Fuel personalSign
        (``\\x19Fuel Signed Message:\\n`` prefix + SHA-256).

        For EVM accounts: Ethereum personalSign
        (``\\x19Ethereum Signed Message:\\n`` prefix + keccak256).

        Returns a 64-byte Fuel compact signature.
        """
        ...


# ---------------------------------------------------------------------------
# Wallet dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Wallet:
    """A Fuel-native wallet.

    Satisfies the :class:`Signer` protocol.
    """

    private_key: bytes
    public_key: bytes
    b256_address: str

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.b256_address[2:])

    def personal_sign(self, message: bytes) -> bytes:
        """Sign using Fuel's personalSign format (prefix + SHA-256 + secp256k1)."""
        digest = fuel_personal_sign_digest(message)
        logger.debug(
            "Wallet.personal_sign: payload=%d bytes, digest=%s", len(message), digest.hex()
        )
        return fuel_compact_sign(self.private_key, digest)


@dataclass
class EvmWallet:
    """An EVM-compatible wallet with B256 zero-padded address.

    Satisfies the :class:`Signer` protocol.
    """

    private_key: bytes
    public_key: bytes
    evm_address: str
    b256_address: str

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.b256_address[2:])

    def personal_sign(self, message: bytes) -> bytes:
        """Sign using Ethereum's personal_sign prefix + keccak256."""
        digest = evm_personal_sign_digest(message)
        logger.debug(
            "EvmWallet.personal_sign: payload=%d bytes, digest=%s", len(message), digest.hex()
        )
        return fuel_compact_sign(self.private_key, digest)


def generate_keypair() -> tuple[str, bytes, str]:
    """Generate a secp256k1 keypair and derive the Fuel B256 address.

    Returns: (private_key_hex, public_key_bytes_65, b256_address_hex)
    """
    secret = os.urandom(32)
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)  # 65 bytes
    address = hashlib.sha256(public_key[1:]).digest()
    return secret.hex(), public_key, "0x" + address.hex()


def generate_wallet() -> Wallet:
    """Generate a new Fuel-native wallet."""
    secret = os.urandom(32)
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)
    address = hashlib.sha256(public_key[1:]).digest()
    return Wallet(
        private_key=secret,
        public_key=public_key,
        b256_address="0x" + address.hex(),
    )


def generate_evm_keypair() -> tuple[str, bytes, str, str]:
    """Generate a secp256k1 keypair with EVM address derivation.

    Returns: (private_key_hex, public_key_bytes_65, evm_address_hex, b256_address_hex)
    """
    secret = os.urandom(32)
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)
    k = keccak.new(digest_bits=256)
    k.update(public_key[1:])
    evm_address = k.digest()[-20:]
    evm_hex = "0x" + evm_address.hex()
    b256_hex = "0x" + "000000000000000000000000" + evm_address.hex()
    return secret.hex(), public_key, evm_hex, b256_hex


def generate_evm_wallet() -> EvmWallet:
    """Generate a new EVM-compatible wallet."""
    secret = os.urandom(32)
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)
    k = keccak.new(digest_bits=256)
    k.update(public_key[1:])
    evm_address = k.digest()[-20:]
    return EvmWallet(
        private_key=secret,
        public_key=public_key,
        evm_address="0x" + evm_address.hex(),
        b256_address="0x" + "000000000000000000000000" + evm_address.hex(),
    )


def load_wallet(private_key_hex: str) -> Wallet:
    """Load a Fuel-native wallet from a private key hex string."""
    secret = bytes.fromhex(private_key_hex.removeprefix("0x"))
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)
    address = hashlib.sha256(public_key[1:]).digest()
    return Wallet(
        private_key=secret,
        public_key=public_key,
        b256_address="0x" + address.hex(),
    )


def load_evm_wallet(private_key_hex: str) -> EvmWallet:
    """Load an EVM-compatible wallet from a private key hex string."""
    secret = bytes.fromhex(private_key_hex.removeprefix("0x"))
    pk = PrivateKey(secret)
    public_key = pk.public_key.format(compressed=False)
    k = keccak.new(digest_bits=256)
    k.update(public_key[1:])
    evm_address = k.digest()[-20:]
    return EvmWallet(
        private_key=secret,
        public_key=public_key,
        evm_address="0x" + evm_address.hex(),
        b256_address="0x" + "000000000000000000000000" + evm_address.hex(),
    )


def fuel_compact_sign(private_key_bytes: bytes, digest: bytes) -> bytes:
    """Sign a 32-byte digest and return 64-byte Fuel compact signature.

    The recovery ID is embedded in the MSB of byte 32 (first byte of s).
    Low-s normalization is handled by coincurve internally.

    Steps:
      1. Sign digest with secp256k1 -> (r, s, recovery_id)
      2. coincurve handles low-s normalization
      3. Embed recovery_id in MSB of s[0]: s[0] = (recovery_id << 7) | (s[0] & 0x7F)
      4. Return r(32) + s(32) = 64 bytes
    """
    pk = PrivateKey(private_key_bytes)
    # sign_recoverable returns 65 bytes: [r(32)] [s(32)] [recovery_id(1)]
    sig = pk.sign_recoverable(digest, hasher=None)
    r = sig[0:32]
    s = bytearray(sig[32:64])
    recovery_id = sig[64]

    # Embed recovery ID in the MSB of s[0]
    s[0] = (recovery_id << 7) | (s[0] & 0x7F)

    return r + bytes(s)


def fuel_personal_sign_digest(message: bytes) -> bytes:
    """Compute the Fuel personalSign digest.

    Constructs ``SHA-256(b"\\x19Fuel Signed Message:\\n" + len(message) + message)``
    and returns the 32-byte digest.

    This is the shared framing logic used by :meth:`Wallet.personal_sign`,
    :func:`personal_sign`, and :meth:`ExternalSigner.personal_sign`.
    """
    prefix = b"\x19Fuel Signed Message:\n"
    length_str = str(len(message)).encode("utf-8")
    return hashlib.sha256(prefix + length_str + message).digest()


def evm_personal_sign_digest(message: bytes) -> bytes:
    """Compute the Ethereum personal_sign digest.

    Constructs ``keccak256(b"\\x19Ethereum Signed Message:\\n" + str(len(message)) + message)``
    and returns the 32-byte digest.

    This is the shared framing logic used by :meth:`EvmWallet.personal_sign`,
    :func:`evm_personal_sign`, and :meth:`ExternalEvmSigner.personal_sign`.
    """
    prefix = f"\x19Ethereum Signed Message:\n{len(message)}".encode()
    k = keccak.new(digest_bits=256)
    k.update(prefix + message)
    return k.digest()


def personal_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using Fuel's personalSign format (for session creation).

    prefix = b"\\x19Fuel Signed Message:\\n" + str(len(message)) + message
    digest = sha256(prefix + length_str + message)
    """
    digest = fuel_personal_sign_digest(message_bytes)
    logger.debug("personal_sign: payload=%d bytes, digest=%s", len(message_bytes), digest.hex())
    return fuel_compact_sign(private_key_bytes, digest)


def raw_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using raw SHA-256 hash, no prefix (for session actions).

    digest = sha256(message_bytes)
    """
    digest = hashlib.sha256(message_bytes).digest()
    logger.debug("raw_sign: payload=%d bytes, digest=%s", len(message_bytes), digest.hex())
    return fuel_compact_sign(private_key_bytes, digest)


def evm_personal_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using Ethereum's personal_sign prefix + keccak256.

    prefix = "\\x19Ethereum Signed Message:\\n" + str(len(message))
    digest = keccak256(prefix_bytes + message)
    """
    digest = evm_personal_sign_digest(message_bytes)
    logger.debug("evm_personal_sign: payload=%d bytes, digest=%s", len(message_bytes), digest.hex())
    return fuel_compact_sign(private_key_bytes, digest)


# ---------------------------------------------------------------------------
# External signer support
# ---------------------------------------------------------------------------


def to_fuel_compact_signature(r: bytes, s: bytes, recovery_id: int) -> bytes:
    """Convert standard (r, s, recovery_id) components to a 64-byte Fuel compact signature.

    This is a convenience helper for implementing :data:`SignDigestFn` callbacks
    when your external signing service (KMS, HSM, hardware wallet) returns
    standard secp256k1 signature components.

    The Fuel compact format stores the recovery ID in the MSB of the first
    byte of ``s``:  ``s[0] = (recovery_id << 7) | (s[0] & 0x7F)``.

    Args:
        r: 32-byte r component of the ECDSA signature.
        s: 32-byte s component of the ECDSA signature (must be low-s normalised).
        recovery_id: Recovery ID (0 or 1).

    Returns:
        64-byte Fuel compact signature (``r || s'``).

    Example::

        def my_kms_sign(digest: bytes) -> bytes:
            r, s, v = kms_client.sign(digest)
            return to_fuel_compact_signature(r, s, v)
    """
    if len(r) != 32:
        raise ValueError(f"r must be 32 bytes, got {len(r)}")
    if len(s) != 32:
        raise ValueError(f"s must be 32 bytes, got {len(s)}")
    if recovery_id not in (0, 1):
        raise ValueError(f"recovery_id must be 0 or 1, got {recovery_id}")

    s_modified = bytearray(s)
    s_modified[0] = (recovery_id << 7) | (s_modified[0] & 0x7F)
    return r + bytes(s_modified)


class ExternalSigner:
    """A Fuel-native signer backed by an external signing function.

    Use this for hardware wallets, AWS KMS, or other secure enclaves
    that manage private keys externally.  The SDK handles Fuel-specific
    message framing (prefix + SHA-256 hashing); your callback only needs
    to sign a raw 32-byte digest.

    The ``sign_digest`` callback receives a 32-byte SHA-256 digest and must
    return a 64-byte Fuel compact signature.  Use :func:`to_fuel_compact_signature`
    to convert from standard ``(r, s, recovery_id)`` components.

    Example::

        from o2_sdk import ExternalSigner, to_fuel_compact_signature

        def kms_sign(digest: bytes) -> bytes:
            r, s, v = my_kms.sign(key_id="...", digest=digest)
            return to_fuel_compact_signature(r, s, v)

        signer = ExternalSigner(
            b256_address="0x1234...abcd",
            sign_digest=kms_sign,
        )
        session = await client.create_session(owner=signer, markets=["FUEL/USDC"])
    """

    def __init__(self, b256_address: str, sign_digest: SignDigestFn) -> None:
        self._b256_address = b256_address
        self._sign_digest = sign_digest

    @property
    def b256_address(self) -> str:
        """The Fuel B256 address (``0x``-prefixed hex string)."""
        return self._b256_address

    @property
    def address_bytes(self) -> bytes:
        """The address as raw bytes (32 bytes)."""
        return bytes.fromhex(self._b256_address[2:])

    def personal_sign(self, message: bytes) -> bytes:
        """Sign using Fuel's personalSign format, delegating to the external signer."""
        digest = fuel_personal_sign_digest(message)
        logger.debug(
            "ExternalSigner.personal_sign: payload=%d bytes, digest=%s",
            len(message),
            digest.hex(),
        )
        return self._sign_digest(digest)


class ExternalEvmSigner:
    """An EVM signer backed by an external signing function.

    Same as :class:`ExternalSigner` but uses Ethereum personal_sign message
    framing (``\\x19Ethereum Signed Message:\\n`` prefix + keccak256 hashing).

    Example::

        from o2_sdk import ExternalEvmSigner, to_fuel_compact_signature

        def kms_sign(digest: bytes) -> bytes:
            r, s, v = my_kms.sign(key_id="...", digest=digest)
            return to_fuel_compact_signature(r, s, v)

        signer = ExternalEvmSigner(
            b256_address="0x000000000000000000000000abcd...1234",
            evm_address="0xabcd...1234",
            sign_digest=kms_sign,
        )
        session = await client.create_session(owner=signer, markets=["FUEL/USDC"])
    """

    def __init__(self, b256_address: str, evm_address: str, sign_digest: SignDigestFn) -> None:
        self._b256_address = b256_address
        self._evm_address = evm_address
        self._sign_digest = sign_digest

    @property
    def b256_address(self) -> str:
        """The Fuel B256 address (``0x``-prefixed hex string)."""
        return self._b256_address

    @property
    def evm_address(self) -> str:
        """The EVM address (``0x``-prefixed, 42-char hex string)."""
        return self._evm_address

    @property
    def address_bytes(self) -> bytes:
        """The address as raw bytes (32 bytes)."""
        return bytes.fromhex(self._b256_address[2:])

    def personal_sign(self, message: bytes) -> bytes:
        """Sign using Ethereum's personal_sign format, delegating to the external signer."""
        digest = evm_personal_sign_digest(message)
        logger.debug(
            "ExternalEvmSigner.personal_sign: payload=%d bytes, digest=%s",
            len(message),
            digest.hex(),
        )
        return self._sign_digest(digest)
