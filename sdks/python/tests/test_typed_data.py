"""Typed-data (SRC-16 / EIP-712) signing tests, anchored on fuel-o2 golden vectors."""

from o2_sdk.typed_data import (
    EIP712,
    SRC16,
    domain_separator,
    eip712_domain_separator,
    is_evm_owner,
    keccak256,
    parallel_multicall_struct_hash,
    src16_domain_separator,
    typed_digest,
)

# Golden vector from fuel-o2 packages/api/src/app/routes.rs:427
# (test_eip712_session_hash_matches_frontend) — EVM owner, EIP-712 domain.
_GOLDEN_OWNER_EVM = bytes.fromhex(
    "000000000000000000000000dd89c413f054398c0f6903786477a2f26875ad80"
)
_GOLDEN_CHAIN_ID = 0x42C026D7
_GOLDEN_CONTRACT = bytes.fromhex(
    "18f9d6f5e708d01ddf2249318b906dd2d7d954c3b8b2399c912565ea78f272b1"
)
_GOLDEN_DOMAIN_SEP = bytes.fromhex(
    "2177b5d66662dcd3c8e3dd12a3d951aab14834bd1b3a4aaee22ac3591ae1e32d"
)


class TestDomainSeparator:
    def test_eip712_golden_domain_separator(self):
        # The make-or-break check: our EIP-712 domain separator must equal the
        # value fuel-o2 computes for the frontend-signed session.
        sep = eip712_domain_separator("TradeAccount", "1", _GOLDEN_CHAIN_ID)
        assert sep == _GOLDEN_DOMAIN_SEP

    def test_owner_selects_encoding(self):
        enc_evm, _ = domain_separator(
            _GOLDEN_OWNER_EVM, "TradeAccount", "1", _GOLDEN_CHAIN_ID, _GOLDEN_CONTRACT
        )
        assert enc_evm == EIP712

        fuel_owner = bytes.fromhex(
            "abcdef0000000000000000000000000000000000000000000000000000000001"
        )
        enc_fuel, _ = domain_separator(
            fuel_owner, "TradeAccount", "1", _GOLDEN_CHAIN_ID, _GOLDEN_CONTRACT
        )
        assert enc_fuel == SRC16

    def test_is_evm_owner(self):
        assert is_evm_owner(_GOLDEN_OWNER_EVM)
        assert not is_evm_owner(bytes.fromhex("ab" + "00" * 31))

    def test_src16_domain_separator_deterministic(self):
        # No golden vector for SRC-16 yet; assert structure (32 bytes, stable,
        # distinct from EIP-712 for the same inputs since the domain type differs).
        s = src16_domain_separator("TradeAccount", "1", _GOLDEN_CHAIN_ID, _GOLDEN_CONTRACT)
        assert len(s) == 32
        assert s == src16_domain_separator(
            "TradeAccount", "1", _GOLDEN_CHAIN_ID, _GOLDEN_CONTRACT
        )
        assert s != eip712_domain_separator("TradeAccount", "1", _GOLDEN_CHAIN_ID)


class TestStructHash:
    def _call(self):
        return {
            "contract_id": bytes(range(32)),
            "function_selector": b"create_order",
            "amount": 1000,
            "asset_id": bytes(range(32, 64)),
            "gas": 5_000_000,
            "call_data": b"\x01\x02\x03",
        }

    def test_parallel_multicall_hash_is_32_bytes_and_stable(self):
        for enc in (SRC16, EIP712):
            h = parallel_multicall_struct_hash(enc, nonce=123, calls=[self._call()])
            assert len(h) == 32
            assert h == parallel_multicall_struct_hash(enc, 123, [self._call()])

    def test_nonce_and_calls_affect_hash(self):
        c = self._call()
        base = parallel_multicall_struct_hash(SRC16, 1, [c])
        assert base != parallel_multicall_struct_hash(SRC16, 2, [c])  # nonce matters
        c2 = self._call()
        c2["amount"] = 999
        assert base != parallel_multicall_struct_hash(SRC16, 1, [c2])  # calls matter

    def test_none_call_data_hashes_empty(self):
        c = self._call()
        c["call_data"] = None
        h_none = parallel_multicall_struct_hash(SRC16, 1, [c])
        c["call_data"] = b""
        h_empty = parallel_multicall_struct_hash(SRC16, 1, [c])
        assert h_none == h_empty  # None encodes as keccak256(b"")

    def test_src16_eip712_differ(self):
        c = self._call()
        assert parallel_multicall_struct_hash(SRC16, 1, [c]) != (
            parallel_multicall_struct_hash(EIP712, 1, [c])
        )


class TestTypedDigest:
    def test_envelope_prefix(self):
        sep = b"\x11" * 32
        sh = b"\x22" * 32
        assert typed_digest(sep, sh) == keccak256(b"\x19\x01" + sep + sh)
