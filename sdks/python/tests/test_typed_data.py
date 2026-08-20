"""Golden and validation tests for owner typed-data encoding."""

import pytest

from o2_sdk.typed_data import (
    EIP712,
    SRC16,
    eip712_domain_separator,
    parallel_withdraw_digest,
    parallel_withdraw_struct_hash,
    src16_domain_separator,
)

CHAIN_ID = 9889
CONTRACT = bytes.fromhex("33" * 32)
TO = bytes.fromhex("44" * 32)
ASSET = bytes.fromhex("55" * 32)
FUEL_OWNER = bytes.fromhex("11" * 32)
EVM_OWNER = bytes.fromhex("00" * 12 + "22" * 20)
PARALLEL_NONCE = (2 << 168) | (1_900_000_000 << 136) | (5 << 8) | 10


def test_src16_parallel_withdraw_digest_golden():
    digest = parallel_withdraw_digest(
        owner_b256=FUEL_OWNER,
        chain_id=CHAIN_ID,
        verifying_contract=CONTRACT,
        nonce=PARALLEL_NONCE,
        to=TO,
        amount=123_456_789,
        asset_id=ASSET,
    )
    assert digest.hex() == "992024613b5f5727386f192b6f6a0da3c5fd5ce455d1dad491ba98e425e8281c"


def test_eip712_parallel_withdraw_digest_golden():
    digest = parallel_withdraw_digest(
        owner_b256=EVM_OWNER,
        chain_id=CHAIN_ID,
        verifying_contract=CONTRACT,
        nonce=PARALLEL_NONCE,
        to=TO,
        amount=123_456_789,
        asset_id=ASSET,
    )
    assert digest.hex() == "750f21e1677c611e6b4a659b1a4102c005ccc6f54970e29aa2fb775d3c1cd0d8"


def test_domain_separators_match_trade_account_v2_layout():
    assert src16_domain_separator(CHAIN_ID, CONTRACT).hex() == (
        "e642a737af80566f0757786406caeacdd950a75f7c56f5b29f256701039b7d1a"
    )
    assert eip712_domain_separator(CHAIN_ID).hex() == (
        "9e3b0972fd54906177c2e9f72a9413582744a5a74fb3ca6a38364e8ceb09e61b"
    )


def test_parallel_withdraw_hash_rejects_bad_widths_and_encoding():
    with pytest.raises(ValueError, match="unknown typed-data encoding"):
        parallel_withdraw_struct_hash(
            encoding="bad",
            nonce=PARALLEL_NONCE,
            to=TO,
            amount=1,
            asset_id=ASSET,
        )
    for encoding in (SRC16, EIP712):
        with pytest.raises(ValueError, match="to must be 32 bytes"):
            parallel_withdraw_struct_hash(
                encoding=encoding,
                nonce=PARALLEL_NONCE,
                to=b"short",
                amount=1,
                asset_id=ASSET,
            )
