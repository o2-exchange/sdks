"""Cryptographic operations for the O2 Exchange SDK.

Implements:
- Key generation (Fuel-native SHA-256 and EVM keccak256 address derivation)
- personalSign (Fuel prefix: b"\\x19Fuel Signed Message:\\n" + len + message)
- rawSign (sha256(message) then fuel_compact_sign)
- evm_personal_sign (Ethereum prefix + keccak256)
- fuel_compact_sign with low-s normalization and recovery ID in MSB of byte 32
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from coincurve import PrivateKey
from Crypto.Hash import keccak


@dataclass
class Wallet:
    """A Fuel-native wallet."""

    private_key: bytes
    public_key: bytes
    b256_address: str

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.b256_address[2:])


@dataclass
class EvmWallet:
    """An EVM-compatible wallet with B256 zero-padded address."""

    private_key: bytes
    public_key: bytes
    evm_address: str
    b256_address: str

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.b256_address[2:])


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


def personal_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using Fuel's personalSign format (for session creation).

    prefix = b"\\x19Fuel Signed Message:\\n" + str(len(message)) + message
    digest = sha256(prefix + length_str + message)
    """
    prefix = b"\x19Fuel Signed Message:\n"
    length_str = str(len(message_bytes)).encode("utf-8")
    full_message = prefix + length_str + message_bytes
    digest = hashlib.sha256(full_message).digest()
    return fuel_compact_sign(private_key_bytes, digest)


def raw_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using raw SHA-256 hash, no prefix (for session actions).

    digest = sha256(message_bytes)
    """
    digest = hashlib.sha256(message_bytes).digest()
    return fuel_compact_sign(private_key_bytes, digest)


def evm_personal_sign(private_key_bytes: bytes, message_bytes: bytes) -> bytes:
    """Sign using Ethereum's personal_sign prefix + keccak256.

    prefix = "\\x19Ethereum Signed Message:\\n" + str(len(message))
    digest = keccak256(prefix_bytes + message)
    """
    prefix = f"\x19Ethereum Signed Message:\n{len(message_bytes)}".encode()
    k = keccak.new(digest_bits=256)
    k.update(prefix + message_bytes)
    digest = k.digest()
    return fuel_compact_sign(private_key_bytes, digest)
