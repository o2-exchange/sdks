"""SRC-16 / EIP-712 typed-data signing for the parallel-nonce track.

The parallel session/actions path is authorized by a typed-data signature
(``TypedSecp256k1``) over a typed struct, NOT the sequential byte-concat. Two
encodings exist; **both use keccak256** and differ only in domain construction
and per-struct type-hash constants:

* **SRC-16** — Fuel-address owner. Domain carries ``chain_id`` (u256) and
  ``verifying_contract`` (contractId) as explicit fields.
* **EIP-712** — EVM-address owner (12 zero-byte b256 prefix). Standard EIP-712
  domain with ``chain_id`` packed into ``salt[24:32]``.

The owner address type selects the domain (mirrors fuel-o2 ``get_typed_domain``).
Final digest = ``keccak256(0x1901 || domain_separator || struct_hash)``, then signed
with secp256k1 (Fuel compact form), regardless of encoding.

Verified against fuel-o2 ``o2-tools`` ``signature_ext.rs`` (o2-tools 0.2.5) and the
``routes.rs`` golden vector. See PARALLEL_NONCES_PLAN.md.
"""

from __future__ import annotations

from Crypto.Hash import keccak

# Owners with this 12-byte zero prefix are EVM addresses (-> EIP-712 domain).
_EVM_ADDRESS_PADDING = b"\x00" * 12

# Encoding tags.
SRC16 = "src16"
EIP712 = "eip712"

# Type-hash constants = keccak256(type string), copied from o2-tools
# signature_ext.rs. CallParams / CallContractArg are shared by the sequential
# and parallel tracks (they carry no nonce); only the top-level struct differs.
_TYPE_HASHES: dict[str, dict[str, bytes]] = {
    # "CallParams(u64 coins,assetId asset_id,u64 gas)"
    "call_params": {
        SRC16: bytes.fromhex("05816efb1220d5dd49f0abf9882712729285e7080da3dc2ba051a6ab701cf3b8"),
        EIP712: bytes.fromhex("322b030cfd61eddd3d0acc5c37358539477197bfc2599dc09a9c75ad47f6e5b8"),
    },
    # "CallContractArg(contractId contract_id,bytes function_selector,CallParams call_params,bytes call_data)..."
    "call_contract_arg": {
        SRC16: bytes.fromhex("c8ac163d1f87886f48788901b8e5eb4eebb3edad4ae111859b2a051059920048"),
        EIP712: bytes.fromhex("325b44fd679189ccd8f708a440a27448cbfd6f47f90205e8ace3f1efc27c92d6"),
    },
    # "ParallelMultiCallContractArgs(u256 nonce,CallContractArg[] call_contract_args)..."
    "parallel_multicall": {
        SRC16: bytes.fromhex("b913eb232c21ef9250e65abc3c1cb9f75af53ed044455ea484d4f3fa3b4b0ee5"),
        EIP712: bytes.fromhex("3c5f4ecf0e01c024666fd99c1a6b05d93d7ca2ca31879f4d66d008356c8dcbf2"),
    },
}

# Domain type strings (hashed at import for the SRC-16 / EIP-712 domain separators).
_SRC16_DOMAIN_TYPE = (
    b"SRC16Domain(string name,string version,u256 chain_id,contractId verifying_contract)"
)
_EIP712_DOMAIN_TYPE = b"EIP712Domain(string name,string version,bytes32 salt)"


def keccak256(data: bytes) -> bytes:
    k = keccak.new(digest_bits=256)
    k.update(data)
    return k.digest()


def _u64_padded(value: int) -> bytes:
    """u64 left-padded to 32 bytes (matches o2-tools: 3x 0u64 + value)."""
    return value.to_bytes(32, "big")


def _u256_bytes(value: int) -> bytes:
    return value.to_bytes(32, "big")


def is_evm_owner(owner_b256: bytes) -> bool:
    return owner_b256[:12] == _EVM_ADDRESS_PADDING


# --- Domain separators ------------------------------------------------------


def src16_domain_separator(
    name: str, version: str, chain_id: int, verifying_contract: bytes
) -> bytes:
    type_hash = keccak256(_SRC16_DOMAIN_TYPE)
    return keccak256(
        type_hash
        + keccak256(name.encode())
        + keccak256(version.encode())
        + _u256_bytes(chain_id)
        + verifying_contract
    )


def eip712_domain_separator(name: str, version: str, chain_id: int) -> bytes:
    # EVM branch packs chain_id into salt[24:32]; chain_id is a u64.
    salt = bytes(24) + chain_id.to_bytes(8, "big")
    type_hash = keccak256(_EIP712_DOMAIN_TYPE)
    return keccak256(
        type_hash + keccak256(name.encode()) + keccak256(version.encode()) + salt
    )


def domain_separator(
    owner_b256: bytes,
    name: str,
    version: str,
    chain_id: int,
    verifying_contract: bytes,
) -> tuple[str, bytes]:
    """Return ``(encoding, domain_separator)`` selected by the owner address type."""
    if is_evm_owner(owner_b256):
        return EIP712, eip712_domain_separator(name, version, chain_id)
    return SRC16, src16_domain_separator(name, version, chain_id, verifying_contract)


# --- Struct hashes ----------------------------------------------------------


def _call_params_hash(enc: str, coins: int, asset_id: bytes, gas: int) -> bytes:
    return keccak256(
        _TYPE_HASHES["call_params"][enc] + _u64_padded(coins) + asset_id + _u64_padded(gas)
    )


def _call_contract_arg_hash(enc: str, call: dict) -> bytes:
    call_data = call.get("call_data")
    return keccak256(
        _TYPE_HASHES["call_contract_arg"][enc]
        + call["contract_id"]
        + keccak256(call["function_selector"])
        + _call_params_hash(enc, call["amount"], call["asset_id"], call["gas"])
        + keccak256(call_data if call_data is not None else b"")
    )


def parallel_multicall_struct_hash(enc: str, nonce: int, calls: list[dict]) -> bytes:
    """struct_hash for ParallelMultiCallContractArgs(u256 nonce, CallContractArg[]).

    ``calls`` are the SDK's low-level call dicts (same shape as
    ``build_actions_signing_bytes`` consumes): contract_id(32), function_selector,
    amount, asset_id(32), gas, call_data.
    """
    call_buffer = b"".join(_call_contract_arg_hash(enc, c) for c in calls)
    return keccak256(
        _TYPE_HASHES["parallel_multicall"][enc]
        + _u256_bytes(nonce)
        + keccak256(call_buffer)
    )


# --- Final digest -----------------------------------------------------------


def typed_digest(domain_sep: bytes, struct_hash: bytes) -> bytes:
    """keccak256(0x1901 || domain_separator || struct_hash) — the 32-byte digest to sign."""
    return keccak256(b"\x19\x01" + domain_sep + struct_hash)


def parallel_actions_digest(
    *,
    owner_b256: bytes,
    name: str,
    version: str,
    chain_id: int,
    verifying_contract: bytes,
    nonce: int,
    calls: list[dict],
) -> bytes:
    """The 32-byte typed-data digest a session key signs for parallel actions."""
    enc, sep = domain_separator(owner_b256, name, version, chain_id, verifying_contract)
    sh = parallel_multicall_struct_hash(enc, nonce, calls)
    return typed_digest(sep, sh)
