"""Unit tests for the encoding module."""

import struct
from typing import ClassVar

from o2_sdk.encoding import (
    GAS_MAX,
    action_to_call,
    build_actions_signing_bytes,
    build_session_signing_bytes,
    encode_identity,
    encode_option_call_data,
    encode_option_none,
    encode_option_some,
    encode_order_args,
    function_selector,
    u64_be,
)


class TestU64Be:
    def test_zero(self):
        assert u64_be(0) == b"\x00" * 8

    def test_one(self):
        assert u64_be(1) == b"\x00" * 7 + b"\x01"

    def test_max(self):
        assert u64_be(GAS_MAX) == b"\xff" * 8

    def test_known_value(self):
        # 256 = 0x100
        result = u64_be(256)
        assert result == b"\x00\x00\x00\x00\x00\x00\x01\x00"

    def test_roundtrip(self):
        for val in [0, 1, 255, 256, 65535, 1000000000, GAS_MAX]:
            encoded = u64_be(val)
            decoded = struct.unpack(">Q", encoded)[0]
            assert decoded == val


class TestFunctionSelector:
    def test_create_order(self):
        result = function_selector("create_order")
        # "create_order" = 12 chars
        assert result[:8] == u64_be(12)
        assert result[8:] == b"create_order"
        assert len(result) == 20

    def test_cancel_order(self):
        result = function_selector("cancel_order")
        assert result[:8] == u64_be(12)
        assert result[8:] == b"cancel_order"
        assert len(result) == 20

    def test_settle_balance(self):
        result = function_selector("settle_balance")
        assert result[:8] == u64_be(14)
        assert result[8:] == b"settle_balance"
        assert len(result) == 22

    def test_register_referer(self):
        result = function_selector("register_referer")
        assert result[:8] == u64_be(16)
        assert result[8:] == b"register_referer"
        assert len(result) == 24

    def test_set_session(self):
        result = function_selector("set_session")
        assert result[:8] == u64_be(11)
        assert result[8:] == b"set_session"

    def test_known_hex_create_order(self):
        """Verify create_order selector matches known hex from the guide."""
        result = function_selector("create_order")
        expected = bytes.fromhex(
            "000000000000000c"  # u64(12)
            "6372656174655f6f72646572"  # "create_order"
        )
        assert result == expected

    def test_known_hex_cancel_order(self):
        result = function_selector("cancel_order")
        expected = bytes.fromhex("000000000000000c63616e63656c5f6f72646572")
        assert result == expected

    def test_known_hex_settle_balance(self):
        result = function_selector("settle_balance")
        expected = bytes.fromhex("000000000000000e736574746c655f62616c616e6365")
        assert result == expected

    def test_known_hex_register_referer(self):
        result = function_selector("register_referer")
        expected = bytes.fromhex("000000000000001072656769737465725f72656665726572")
        assert result == expected


class TestEncodeIdentity:
    def test_address(self):
        addr = bytes(32)
        result = encode_identity(0, addr)
        assert result == u64_be(0) + addr
        assert len(result) == 40

    def test_contract_id(self):
        addr = bytes(range(32))
        result = encode_identity(1, addr)
        assert result == u64_be(1) + addr
        assert len(result) == 40


class TestEncodeOption:
    def test_none(self):
        assert encode_option_none() == u64_be(0)

    def test_some(self):
        data = b"\x01\x02\x03"
        result = encode_option_some(data)
        assert result == u64_be(1) + data

    def test_call_data_none(self):
        assert encode_option_call_data(None) == u64_be(0)

    def test_call_data_some(self):
        data = b"\x01\x02\x03"
        result = encode_option_call_data(data)
        assert result == u64_be(1) + u64_be(3) + data


class TestEncodeOrderArgs:
    def test_spot(self):
        result = encode_order_args(100000000, 5000000000, "Spot")
        assert len(result) == 24  # 8 + 8 + 8
        assert result[:8] == u64_be(100000000)
        assert result[8:16] == u64_be(5000000000)
        assert result[16:24] == u64_be(1)  # Spot variant = 1

    def test_market(self):
        result = encode_order_args(100000000, 5000000000, "Market")
        assert len(result) == 24
        assert result[16:24] == u64_be(4)  # Market variant = 4

    def test_fill_or_kill(self):
        result = encode_order_args(100000000, 5000000000, "FillOrKill")
        assert len(result) == 24
        assert result[16:24] == u64_be(2)  # FillOrKill variant = 2

    def test_post_only(self):
        result = encode_order_args(100000000, 5000000000, "PostOnly")
        assert len(result) == 24
        assert result[16:24] == u64_be(3)  # PostOnly variant = 3

    def test_limit(self):
        result = encode_order_args(
            100000000, 5000000000, "Limit", {"price": 100000000, "timestamp": 1734876543}
        )
        # 8 + 8 + (8 + 8 + 8) = 40 bytes
        assert len(result) == 40
        assert result[16:24] == u64_be(0)  # Limit variant = 0
        assert result[24:32] == u64_be(100000000)
        assert result[32:40] == u64_be(1734876543)

    def test_bounded_market(self):
        result = encode_order_args(
            100000000, 5000000000, "BoundedMarket", {"max_price": 110000000, "min_price": 90000000}
        )
        assert len(result) == 40
        assert result[16:24] == u64_be(5)  # BoundedMarket variant = 5
        assert result[24:32] == u64_be(110000000)
        assert result[32:40] == u64_be(90000000)

    def test_tightly_packed(self):
        """Verify different order types produce different sizes (tightly packed)."""
        spot = encode_order_args(100, 200, "Spot")
        limit = encode_order_args(100, 200, "Limit", {"price": 100, "timestamp": 0})
        assert len(spot) == 24
        assert len(limit) == 40
        # No padding: spot is 16 bytes shorter


class TestBuildSessionSigningBytes:
    def test_structure(self):
        nonce = 0
        chain_id = 0
        session_addr = bytes(32)
        contract_ids = [bytes(32)]
        expiry = 1737504000

        result = build_session_signing_bytes(nonce, chain_id, session_addr, contract_ids, expiry)

        offset = 0
        # nonce
        assert result[offset : offset + 8] == u64_be(0)
        offset += 8
        # chain_id
        assert result[offset : offset + 8] == u64_be(0)
        offset += 8
        # function_selector("set_session")
        func_name = b"set_session"
        assert result[offset : offset + 8] == u64_be(len(func_name))
        offset += 8
        assert result[offset : offset + len(func_name)] == func_name
        offset += len(func_name)
        # Option::Some
        assert result[offset : offset + 8] == u64_be(1)
        offset += 8
        # Identity::Address
        assert result[offset : offset + 8] == u64_be(0)
        offset += 8
        # session_address
        assert result[offset : offset + 32] == session_addr
        offset += 32
        # expiry
        assert result[offset : offset + 8] == u64_be(1737504000)
        offset += 8
        # contract_ids length
        assert result[offset : offset + 8] == u64_be(1)
        offset += 8
        # contract_id
        assert result[offset : offset + 32] == bytes(32)
        offset += 32

        assert offset == len(result)

    def test_multiple_contract_ids(self):
        cid1 = bytes(range(32))
        cid2 = bytes(range(32, 64))
        result = build_session_signing_bytes(
            nonce=1, chain_id=0, session_address=bytes(32), contract_ids=[cid1, cid2], expiry=100
        )
        # The contract IDs should both be present
        assert cid1 in result
        assert cid2 in result


class TestBuildActionsSigningBytes:
    def test_single_call(self):
        call = {
            "contract_id": bytes(32),
            "function_selector": function_selector("create_order"),
            "amount": 500000000,
            "asset_id": bytes(32),
            "gas": GAS_MAX,
            "call_data": encode_order_args(100000000, 5000000000, "Spot"),
        }
        result = build_actions_signing_bytes(nonce=0, calls=[call])

        offset = 0
        # nonce
        assert result[offset : offset + 8] == u64_be(0)
        offset += 8
        # num_calls
        assert result[offset : offset + 8] == u64_be(1)
        offset += 8
        # contract_id
        assert result[offset : offset + 32] == bytes(32)
        offset += 32
        # selector_len
        selector = function_selector("create_order")
        assert result[offset : offset + 8] == u64_be(len(selector))
        offset += 8
        # selector
        assert result[offset : offset + len(selector)] == selector
        offset += len(selector)
        # amount
        assert result[offset : offset + 8] == u64_be(500000000)
        offset += 8
        # asset_id
        assert result[offset : offset + 32] == bytes(32)
        offset += 32
        # gas
        assert result[offset : offset + 8] == u64_be(GAS_MAX)
        offset += 8
        # option call_data (Some)
        assert result[offset : offset + 8] == u64_be(1)  # Some
        offset += 8
        call_data = encode_order_args(100000000, 5000000000, "Spot")
        assert result[offset : offset + 8] == u64_be(len(call_data))
        offset += 8
        assert result[offset : offset + len(call_data)] == call_data
        offset += len(call_data)

        assert offset == len(result)


class TestActionToCall:
    MARKET_INFO: ClassVar[dict] = {
        "contract_id": "0x" + "ab" * 32,
        "market_id": "0x" + "cd" * 32,
        "base": {"asset": "0x" + "11" * 32, "decimals": 9},
        "quote": {"asset": "0x" + "22" * 32, "decimals": 9},
        "accounts_registry_id": "0x" + "33" * 32,
    }

    def test_create_order_buy(self):
        action = {
            "CreateOrder": {
                "side": "Buy",
                "price": "100000000",
                "quantity": "5000000000",
                "order_type": "Spot",
            }
        }
        call = action_to_call(action, self.MARKET_INFO)
        assert call["contract_id"] == bytes.fromhex("ab" * 32)
        assert call["function_selector"] == function_selector("create_order")
        # amount = (100000000 * 5000000000) // 10^9 = 500000000
        assert call["amount"] == 500000000
        assert call["asset_id"] == bytes.fromhex("22" * 32)  # quote asset for buy
        assert call["gas"] == GAS_MAX

    def test_create_order_sell(self):
        action = {
            "CreateOrder": {
                "side": "Sell",
                "price": "100000000",
                "quantity": "5000000000",
                "order_type": "Spot",
            }
        }
        call = action_to_call(action, self.MARKET_INFO)
        assert call["amount"] == 5000000000  # quantity for sell
        assert call["asset_id"] == bytes.fromhex("11" * 32)  # base asset for sell

    def test_cancel_order(self):
        action = {
            "CancelOrder": {
                "order_id": "0x" + "ff" * 32,
            }
        }
        call = action_to_call(action, self.MARKET_INFO)
        assert call["function_selector"] == function_selector("cancel_order")
        assert call["amount"] == 0
        assert call["asset_id"] == bytes(32)
        assert call["call_data"] == bytes.fromhex("ff" * 32)

    def test_settle_balance(self):
        action = {
            "SettleBalance": {
                "to": {"ContractId": "0x" + "dd" * 32},
            }
        }
        call = action_to_call(action, self.MARKET_INFO)
        assert call["function_selector"] == function_selector("settle_balance")
        assert call["amount"] == 0
        expected_identity = encode_identity(1, bytes.fromhex("dd" * 32))
        assert call["call_data"] == expected_identity
