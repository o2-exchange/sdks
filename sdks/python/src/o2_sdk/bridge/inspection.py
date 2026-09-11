"""Offline inspection of the proxy's pinned transaction formats, not a safety approval.

No RPC calls, HMAC verification, or personal-sign hashing. Compare parsed intent
with independently trusted expectations before signing the locally derived digest.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass

from Crypto.Hash import keccak


def _check(ok: object, message: str = "Invalid bridge transaction") -> None:
    if not ok:
        raise ValueError(message)


def _unhex(value: str) -> bytes:
    _check(len(value) <= 32770 and re.fullmatch(r"0x(?:[\da-fA-F]{2})+", value))
    return bytes.fromhex(value[2:])


def _hex(value: bytes) -> str:
    return "0x" + value.hex()


def _keccak(value: bytes) -> str:
    return _hex(keccak.new(digest_bits=256, data=value).digest())


@dataclass(frozen=True)
class PreparationProofClaims:
    """UNAUTHENTICATED claims. expires_at is Unix seconds; expired proofs still parse."""

    version: int
    key_id: str
    expires_at: int
    signer: str


def parse_preparation_proof(proof: str) -> PreparationProofClaims:
    """Decode claims only. Does not authenticate the signer or bind a transaction."""
    _check(len(proof) <= 2048, "Preparation proof too large")
    parts = proof.split(".")
    _check(len(parts) == 2, "Invalid preparation proof")

    def decode(value: str) -> bytes:
        _check(re.fullmatch(r"[A-Za-z0-9_-]+", value), "Invalid preparation proof encoding")
        data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        _check(
            base64.urlsafe_b64encode(data).decode().rstrip("=") == value,
            "Noncanonical preparation proof encoding",
        )
        return data

    _check(len(decode(parts[1])) == 32, "Invalid preparation proof MAC length")
    c = json.loads(decode(parts[0]).decode("utf-8"))
    _check(
        isinstance(c, dict) and set(c) == {"version", "keyId", "expiresAt", "signer"},
        "Invalid preparation proof claims",
    )
    _check(
        type(c["version"]) is int
        and c["version"] == 1
        and isinstance(c["keyId"], str)
        and c["keyId"]
        and type(c["expiresAt"]) is int
        and 0 < c["expiresAt"] <= 9007199254740991
        and isinstance(c["signer"], str)
        and re.fullmatch(r"0x([0-9a-f]{40}|[0-9a-f]{64})", c["signer"]),
        "Invalid preparation proof claims",
    )
    return PreparationProofClaims(c["version"], c["keyId"], c["expiresAt"], c["signer"])


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def take(self, size: int) -> bytes:
        _check(0 <= size <= len(self.data) - self.offset, "Truncated transaction")
        result = self.data[self.offset : self.offset + size]
        self.offset += size
        return result

    def num(self, size: int = 8) -> int:
        return int.from_bytes(self.take(size), "big")

    def count(self, maximum: int = 16384) -> int:
        result = self.num()
        _check(result <= maximum, "Unsupported transaction size or field")
        return result

    def padded(self, size: int) -> bytes:
        result = self.take(size)
        _check(not any(self.take(-size % 8)), "Nonzero transaction padding")
        return result

    def done(self) -> None:
        _check(self.offset == len(self.data), "Trailing transaction data")


def _rlp(reader: _Reader, depth: int = 0) -> bytes | list:
    _check(depth < 4, "RLP nesting too deep")
    tag = reader.num(1)
    if tag < 128:
        return bytes([tag])
    is_list = tag >= 192
    short, long = (192, 247) if is_list else (128, 183)
    length = tag - short
    if tag > long:
        encoded = reader.take(tag - long)
        length = int.from_bytes(encoded, "big")
        _check(encoded[0] != 0 and 56 <= length <= 16384)
    data = reader.take(length)
    if not is_list:
        _check(length != 1 or data[0] >= 128, "Noncanonical RLP")
        return data
    children = _Reader(data)
    result = []
    while children.offset < len(data):
        result.append(_rlp(children, depth + 1))
    return result


@dataclass(frozen=True)
class EvmPermitInspection:
    deadline: int
    v: int
    r: str
    s: str


@dataclass(frozen=True)
class EvmDepositInspection:
    type: int
    chain_id: int
    nonce: int
    messenger_address: str
    value: int
    gas_limit: int
    max_fee_per_gas: int
    max_priority_fee_per_gas: int
    estimated_network_fee: int
    """gas_limit * max_fee_per_gas, in wei: cap, not actual fee. Excludes rollup L1 data fees."""
    data: str
    method: str
    recipient: str
    recipient_is_contract: bool
    token_address: str | None
    amount: int
    """EVM token base units or wei, not API/Fuel base units."""
    permit: EvmPermitInspection | None
    signing_digest: str


def parse_evm_unsigned_transaction(unsigned_transaction: str) -> EvmDepositInspection:
    """Parse only canonical unsigned EIP-1559 proxy deposits and derive their raw signing digest."""
    raw = _unhex(unsigned_transaction)
    reader = _Reader(raw)
    _check(reader.num(1) == 2, "Only unsigned EIP-1559 deposits are supported")
    fields = _rlp(reader)
    reader.done()
    _check(isinstance(fields, list) and len(fields) == 9, "Expected unsigned EIP-1559 fields")
    assert isinstance(fields, list)
    _check(fields[8] == [], "Proxy deposits require an empty access list")

    def leaf(index: int, size: int | None = None) -> bytes:
        value = fields[index]
        _check(
            isinstance(value, bytes) and (size is None or len(value) == size), "Invalid EVM field"
        )
        assert isinstance(value, bytes)
        return value

    def number(index: int) -> int:
        data = leaf(index)
        _check(len(data) <= 32 and (not data or data[0] != 0), "Noncanonical EVM integer")
        return int.from_bytes(data, "big")

    chain_id, nonce, priority, fee, gas = (number(i) for i in range(5))
    _check(chain_id > 0 and priority <= fee)
    messenger, value, data = _hex(leaf(5, 20)), number(6), leaf(7)
    signatures = [
        "deposit(bytes32,address,uint256,bool)",
        "depositWithPermit(bytes32,address,uint256,uint256,uint8,bytes32,bytes32,bool)",
        "depositETH(bytes32,bool)",
    ]
    indexes = [
        i for i, sig in enumerate(signatures) if _keccak(sig.encode())[2:10] == data[:4].hex()
    ]
    _check(indexes, "Unknown Messenger method")
    index = indexes[0]
    count = [4, 8, 2][index]
    _check(len(data) == 4 + count * 32, "Invalid Messenger calldata length")

    def arg(i: int) -> bytes:
        return data[4 + i * 32 : 36 + i * 32]

    def arg_int(i: int) -> int:
        return int.from_bytes(arg(i), "big")

    flag = arg_int(count - 1)
    _check(flag <= 1, "Invalid recipientIsContract")
    token = None
    amount = value
    permit = None
    if index != 2:
        _check(value == 0 and not any(arg(1)[:12]))
        token, amount = _hex(arg(1)[12:]), arg_int(2)
        if index == 1:
            _check(arg_int(4) <= 255, "Invalid permit v")
            permit = EvmPermitInspection(arg_int(3), arg_int(4), _hex(arg(5)), _hex(arg(6)))
    return EvmDepositInspection(
        2,
        chain_id,
        nonce,
        messenger,
        value,
        gas,
        fee,
        priority,
        gas * fee,
        _hex(data),
        ["deposit", "depositWithPermit", "depositETH"][index],
        _hex(arg(0)),
        flag == 1,
        token,
        amount,
        permit,
        _keccak(raw),
    )


@dataclass(frozen=True)
class FuelInputInspection:
    type: str
    owner: str | None = None
    amount: int | None = None
    asset_id: str | None = None
    contract_id: str | None = None
    witness_index: int | None = None


@dataclass(frozen=True)
class FuelOutputInspection:
    """Change/Variable amounts and Variable to/asset_id are unsigned execution results."""

    type: str
    to: str | None = None
    amount: int | None = None
    asset_id: str | None = None
    input_index: int | None = None


@dataclass(frozen=True)
class FuelNetworkFee:
    max_fee: int
    """Cap in Fuel base-asset units, not an actual network fee."""


@dataclass(frozen=True)
class FuelWithdrawalInspection:
    asset_id: str
    asset_sub_id: str
    asset_registry_contract_id: str
    destination_chain_id: int
    recipient: str
    gross_amount: int
    bridge_fee: int
    """Embedded quote in Fuel asset units; execution fee can drift within contract tolerance."""
    net_amount: int
    """Expected gross_amount - bridge_fee, not guaranteed delivery."""
    network_fee: FuelNetworkFee
    expiration_block_height: int
    script_gas_limit: int
    policies: dict[str, int]
    inputs: list[FuelInputInspection]
    outputs: list[FuelOutputInspection]
    transaction_id: str


def parse_fuel_unsigned_transaction(
    unsigned_transaction: str, fuel_chain_id: int, fuel_max_inputs: int
) -> FuelWithdrawalInspection:
    """Inspect the proxy single-call script and derive its ID using an independently trusted chain ID.

    Rejects other scripts, predicates, message data and non-empty witnesses. Inspect
    the returned inputs/outputs too; parsing alone does not mean safe to sign.
    fuel_max_inputs is independently trusted consensus txParameters.maxInputs:
    the VM memory offset depends on it, but it is not encoded in the transaction.
    """
    _check(
        type(fuel_chain_id) is int and 0 <= fuel_chain_id < 1 << 64, "Fuel chain ID must fit u64"
    )
    _check(
        type(fuel_max_inputs) is int and 0 < fuel_max_inputs <= 65535,
        "Invalid Fuel consensus maxInputs",
    )
    raw = _unhex(unsigned_transaction)
    normalized = bytearray(raw)
    r = _Reader(raw)

    def zero(start: int, size: int) -> None:
        normalized[start : start + size] = bytes(size)

    _check(r.num() == 0, "Expected Fuel Script transaction")
    gas = r.num()
    r.take(32)
    zero(16, 32)
    script_len, data_len, mask = r.count(), r.count(), r.count(63)
    input_count, output_count, witnesses = r.count(), r.count(), r.count()
    _check(
        0 < input_count <= fuel_max_inputs and witnesses == 1,
        "Expected supported inputs and one unsigned owner witness",
    )
    script, data = r.padded(script_len), r.padded(data_len)
    policies = {
        name: r.num()
        for i, name in enumerate(
            ["tip", "witnessLimit", "maturity", "maxFee", "expiration", "owner"]
        )
        if mask & (1 << i)
    }
    _check(
        "maxFee" in policies and "expiration" in policies and policies["expiration"] <= 0xFFFFFFFF
    )
    inputs = []
    for _ in range(input_count):
        kind, start = r.count(2), r.offset
        if kind == 1:
            r.take(32)
            r.count(65535)
            r.take(64)
            r.count(0xFFFFFFFF)
            r.count(65535)
            zero(start, 120)
            inputs.append(FuelInputInspection("contract", contract_id=_hex(r.take(32))))
        else:
            asset = None
            if kind == 0:
                r.take(32)
                r.count(65535)
                owner, amount, asset = _hex(r.take(32)), r.num(), _hex(r.take(32))
                pointer = r.offset
                r.count(0xFFFFFFFF)
                r.count(65535)
                zero(pointer, 16)
            else:
                r.take(32)
                owner, amount = _hex(r.take(32)), r.num()
                r.take(32)
            witness = r.count(65535)
            _check(witness == 0)
            gas_offset = r.offset
            _check(r.num() == 0, "Predicates are unsupported")
            zero(gas_offset, 8)
            if kind == 2:
                _check(r.num() == 0, "Message data is unsupported")
            _check(r.num() == 0 and r.num() == 0, "Predicates are unsupported")
            inputs.append(
                FuelInputInspection(
                    "coin" if kind == 0 else "message", owner, amount, asset, witness_index=witness
                )
            )
    outputs = []
    for _ in range(output_count):
        kind = r.count(3)
        _check(kind != 0, "Coin outputs are unsupported in proxy withdrawals")
        if kind == 1:
            index = r.count()
            _check(index < len(inputs) and inputs[index].type == "contract")
            zero(r.offset, 64)
            r.take(64)
            outputs.append(FuelOutputInspection("contract", input_index=index))
        else:
            start = r.offset
            to, amount, asset = _hex(r.take(32)), r.num(), _hex(r.take(32))
            if kind == 2:
                zero(start + 32, 8)
            if kind == 3:
                zero(start, 72)
            outputs.append(
                FuelOutputInspection("change" if kind == 2 else "variable", to, amount, asset)
            )
    witness_offset = r.offset
    _check(r.num() == 0, "Expected empty unsigned witness")
    r.done()
    zero(88, 8)
    d = _Reader(data)
    gross, asset_id, registry = d.num(), _hex(d.take(32)), _hex(d.take(32))
    selector_pointer, args_pointer = d.count(0x3FFFF + 88), d.count(0x3FFFF + 256)
    selector = b"withdraw_via_fast_bridge_with_fee"
    _check(d.num() == len(selector) and d.take(len(selector)) == selector, "Unknown Fuel call")
    _check(args_pointer == selector_pointer + 8 + len(selector), "Invalid Fuel argument pointer")
    offset = selector_pointer - 88
    # VM prefix 72 + maxInputs * 40, Script header 96, CALL script 24.
    _check(
        offset == 192 + 40 * fuel_max_inputs,
        "Fuel call pointer does not address this transaction's script data",
    )
    _check(offset >= 0 and offset + 40 <= 0x3FFFF)
    expected = [
        0x72400000 | (offset + 40),
        0x72440000 | offset,
        0x5D451000,
        0x72480000 | (offset + 8),
        0x2D41148A,
        0x24040000,
    ]
    s = _Reader(script)
    _check(len(script) == 24 and all(s.num(4) == v for v in expected), "Unsupported Fuel script")
    sub_id, chain, recipient, fee = _hex(d.take(32)), d.num(4), d.take(32), d.num()
    d.done()
    _check(not any(recipient[:12]) and gross >= fee)
    _check(any(recipient[12:]), "Zero withdrawal recipient")
    _check(any(i.contract_id == registry for i in inputs), "Missing Asset Registry input")
    tx_id = _hex(
        hashlib.sha256(fuel_chain_id.to_bytes(8, "big") + normalized[:witness_offset]).digest()
    )
    return FuelWithdrawalInspection(
        asset_id,
        sub_id,
        registry,
        chain,
        _hex(recipient[12:]),
        gross,
        fee,
        gross - fee,
        FuelNetworkFee(policies["maxFee"]),
        policies["expiration"],
        gas,
        policies,
        inputs,
        outputs,
        tx_id,
    )
