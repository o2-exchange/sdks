"""SRC-16 and EIP-712 typed-data encoding for owner-signed operations.

The trade-account contract selects SRC-16 for Fuel-native owners and EIP-712
for zero-padded EVM owners. Both paths sign the final keccak256 digest directly
with secp256k1; personal-sign framing must not be applied to this digest.
"""

from __future__ import annotations

from Crypto.Hash import keccak

SRC16 = "src16"
EIP712 = "eip712"

TRADE_ACCOUNT_DOMAIN = "TradeAccount"
TRADE_ACCOUNT_VERSION = "2"

_EVM_ADDRESS_PADDING = b"\x00" * 12
_SRC16_DOMAIN_TYPE = (
    b"SRC16Domain(string name,string version,u256 chain_id,contractId verifying_contract)"
)
_EIP712_DOMAIN_TYPE = b"EIP712Domain(string name,string version,bytes32 salt)"

# fuel-o2-exports/contracts/schema/src/trade_account_par.sw
_SRC16_PARALLEL_WITHDRAW_TYPE_HASH = bytes.fromhex(
    "95a9c4c23dd3607b14ecdc67fcc42946f61a4f1d153dc7dfbd77ca6c2af1c6f6"
)
_EIP712_PARALLEL_WITHDRAW_TYPE_HASH = bytes.fromhex(
    "7d2e70c357f073fd00c187b1871bf74c440ec8303b435f001d884d6ffd77ca1c"
)


def keccak256(data: bytes) -> bytes:
    """Return the 32-byte keccak256 digest of *data*."""
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return hasher.digest()


def _uint256(value: int, field: str) -> bytes:
    if not 0 <= value < 1 << 256:
        raise ValueError(f"{field} must fit in an unsigned 256-bit integer")
    return value.to_bytes(32, "big")


def _u64_padded(value: int, field: str) -> bytes:
    if not 0 <= value < 1 << 64:
        raise ValueError(f"{field} must fit in an unsigned 64-bit integer")
    return value.to_bytes(32, "big")


def _bytes32(value: bytes, field: str) -> bytes:
    if len(value) != 32:
        raise ValueError(f"{field} must be 32 bytes, got {len(value)}")
    return value


def is_evm_owner(owner_b256: bytes) -> bool:
    """Return whether the B256 owner is a zero-padded EVM address."""
    return len(owner_b256) == 32 and owner_b256.startswith(_EVM_ADDRESS_PADDING)


def src16_domain_separator(chain_id: int, verifying_contract: bytes) -> bytes:
    """Build the Fuel SRC-16 trade-account domain separator."""
    return keccak256(
        keccak256(_SRC16_DOMAIN_TYPE)
        + keccak256(TRADE_ACCOUNT_DOMAIN.encode())
        + keccak256(TRADE_ACCOUNT_VERSION.encode())
        + _uint256(chain_id, "chain_id")
        + _bytes32(verifying_contract, "verifying_contract")
    )


def eip712_domain_separator(chain_id: int) -> bytes:
    """Build the EIP-712 trade-account domain separator used by EVM owners."""
    if not 0 <= chain_id < 1 << 64:
        raise ValueError("chain_id must fit in an unsigned 64-bit integer")
    salt = bytes(24) + chain_id.to_bytes(8, "big")
    return keccak256(
        keccak256(_EIP712_DOMAIN_TYPE)
        + keccak256(TRADE_ACCOUNT_DOMAIN.encode())
        + keccak256(TRADE_ACCOUNT_VERSION.encode())
        + salt
    )


def parallel_withdraw_struct_hash(
    *,
    encoding: str,
    nonce: int,
    to: bytes,
    amount: int,
    asset_id: bytes,
) -> bytes:
    """Hash ``ParallelWithdrawArgs`` exactly as the trade-account contract does."""
    if encoding == SRC16:
        type_hash = _SRC16_PARALLEL_WITHDRAW_TYPE_HASH
    elif encoding == EIP712:
        type_hash = _EIP712_PARALLEL_WITHDRAW_TYPE_HASH
    else:
        raise ValueError(f"unknown typed-data encoding: {encoding}")
    return keccak256(
        type_hash
        + _uint256(nonce, "nonce")
        + _bytes32(to, "to")
        + _u64_padded(amount, "amount")
        + _bytes32(asset_id, "asset_id")
    )


def typed_digest(domain_separator: bytes, struct_hash: bytes) -> bytes:
    """Build ``keccak256(0x1901 || domain_separator || struct_hash)``."""
    return keccak256(
        b"\x19\x01"
        + _bytes32(domain_separator, "domain_separator")
        + _bytes32(struct_hash, "struct_hash")
    )


def parallel_withdraw_digest(
    *,
    owner_b256: bytes,
    chain_id: int,
    verifying_contract: bytes,
    nonce: int,
    to: bytes,
    amount: int,
    asset_id: bytes,
) -> bytes:
    """Return the typed-data digest authorizing ``par_withdraw``."""
    if is_evm_owner(_bytes32(owner_b256, "owner_b256")):
        encoding = EIP712
        domain = eip712_domain_separator(chain_id)
    else:
        encoding = SRC16
        domain = src16_domain_separator(chain_id, verifying_contract)
    struct_hash = parallel_withdraw_struct_hash(
        encoding=encoding,
        nonce=nonce,
        to=to,
        amount=amount,
        asset_id=asset_id,
    )
    return typed_digest(domain, struct_hash)
