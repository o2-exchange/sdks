"""Fuel ABI encoding primitives for the O2 Exchange SDK.

Implements the exact byte layouts from the O2 integration guide:
- u64 big-endian encoding
- Identity encoding (Address / ContractId discriminant)
- Option encoding (None / Some)
- Vec encoding
- Function selectors (NOT hash-based: u64(len) + utf8(name))
- OrderArgs struct encoding with tightly packed OrderType enum
- Session signing bytes (set_session)
- Action signing bytes (session/actions)
"""

from __future__ import annotations

import struct
from typing import Optional

GAS_MAX = 18446744073709551615  # u64::MAX


def u64_be(value: int) -> bytes:
    """Encode an integer as 8 bytes big-endian (u64)."""
    return struct.pack(">Q", value)


def function_selector(name: str) -> bytes:
    """Encode a Fuel ABI function selector: u64_be(len(name)) + utf8(name).

    NOTE: Fuel function selectors are NOT hash-based like Solidity.
    """
    name_bytes = name.encode("utf-8")
    return u64_be(len(name_bytes)) + name_bytes


def encode_identity(discriminant: int, address_bytes: bytes) -> bytes:
    """Encode a Fuel Identity enum: u64(discriminant) + 32-byte address.

    discriminant: 0 = Address, 1 = ContractId
    """
    assert len(address_bytes) == 32, f"Address must be 32 bytes, got {len(address_bytes)}"
    return u64_be(discriminant) + address_bytes


def encode_option_none() -> bytes:
    """Encode Option::None: u64(0)."""
    return u64_be(0)


def encode_option_some(data: bytes) -> bytes:
    """Encode Option::Some(data): u64(1) + data."""
    return u64_be(1) + data


def encode_option_call_data(data_or_none: Optional[bytes]) -> bytes:
    """Encode Option for call_data in action signing bytes.

    None  -> u64(0)
    Some  -> u64(1) + u64(len(data)) + data
    """
    if data_or_none is None:
        return u64_be(0)
    return u64_be(1) + u64_be(len(data_or_none)) + data_or_none


def encode_order_args(
    price: int,
    quantity: int,
    order_type: str,
    order_type_data: Optional[dict] = None,
) -> bytes:
    """Encode OrderArgs struct for CreateOrder call_data.

    OrderArgs = u64(price) + u64(quantity) + order_type_encoding

    OrderType variants are tightly packed (NO padding to largest variant size):
      Limit(0):         u64(0) + u64(price) + u64(timestamp)   [24 bytes]
      Spot(1):          u64(1)                                  [8 bytes]
      FillOrKill(2):    u64(2)                                  [8 bytes]
      PostOnly(3):      u64(3)                                  [8 bytes]
      Market(4):        u64(4)                                  [8 bytes]
      BoundedMarket(5): u64(5) + u64(max_price) + u64(min_price) [24 bytes]
    """
    result = bytearray()
    result += u64_be(price)
    result += u64_be(quantity)

    if order_type == "Limit":
        limit_price = int(order_type_data["price"])
        timestamp = int(order_type_data["timestamp"])
        result += u64_be(0) + u64_be(limit_price) + u64_be(timestamp)
    elif order_type == "Spot":
        result += u64_be(1)
    elif order_type == "FillOrKill":
        result += u64_be(2)
    elif order_type == "PostOnly":
        result += u64_be(3)
    elif order_type == "Market":
        result += u64_be(4)
    elif order_type == "BoundedMarket":
        max_price = int(order_type_data["max_price"])
        min_price = int(order_type_data["min_price"])
        result += u64_be(5) + u64_be(max_price) + u64_be(min_price)
    else:
        raise ValueError(f"Unknown order type: {order_type}")

    return bytes(result)


def build_session_signing_bytes(
    nonce: int,
    chain_id: int,
    session_address: bytes,
    contract_ids: list[bytes],
    expiry: int,
) -> bytes:
    """Build the signing bytes for set_session.

    Layout:
      u64(nonce) + u64(chain_id) + function_selector("set_session")
      + u64(1)  [Option::Some]
      + u64(0)  [Identity::Address]
      + session_address (32 bytes)
      + u64(expiry)
      + u64(len(contract_ids))
      + concat(contract_ids)  [32 bytes each]
    """
    func_name = b"set_session"

    encoded_args = bytearray()
    encoded_args += u64_be(1)                    # Option::Some
    encoded_args += u64_be(0)                    # Identity::Address
    encoded_args += session_address              # 32 bytes
    encoded_args += u64_be(expiry)               # expiry
    encoded_args += u64_be(len(contract_ids))    # number of contract IDs
    for cid in contract_ids:
        encoded_args += cid                      # 32 bytes each

    signing_bytes = bytearray()
    signing_bytes += u64_be(nonce)
    signing_bytes += u64_be(chain_id)
    signing_bytes += u64_be(len(func_name))
    signing_bytes += func_name
    signing_bytes += encoded_args

    return bytes(signing_bytes)


def build_actions_signing_bytes(nonce: int, calls: list[dict]) -> bytes:
    """Build the signing bytes from a list of low-level calls.

    Layout:
      u64(nonce) + u64(num_calls)
      + for each call:
          contract_id (32 bytes)
          + u64(selector_len)
          + selector (variable)
          + u64(amount)
          + asset_id (32 bytes)
          + u64(gas)
          + encode_option_call_data(call_data)
    """
    result = bytearray()
    result += u64_be(nonce)
    result += u64_be(len(calls))

    for call in calls:
        selector = call["function_selector"]
        result += call["contract_id"]                        # 32 bytes
        result += u64_be(len(selector))                      # 8 bytes
        result += selector                                   # variable
        result += u64_be(call["amount"])                     # 8 bytes
        result += call["asset_id"]                           # 32 bytes
        result += u64_be(call["gas"])                        # 8 bytes
        result += encode_option_call_data(call.get("call_data"))

    return bytes(result)


def action_to_call(action: dict, market_info: dict) -> dict:
    """Convert a high-level action to a low-level contract call.

    Returns dict with: contract_id, function_selector, amount, asset_id, gas, call_data
    """
    contract_id = bytes.fromhex(market_info["contract_id"][2:])
    zero_asset = bytes(32)

    if "CreateOrder" in action:
        data = action["CreateOrder"]
        price = int(data["price"])
        quantity = int(data["quantity"])
        side = data["side"]
        base_decimals = market_info["base"]["decimals"]

        if side == "Buy":
            amount = (price * quantity) // (10 ** base_decimals)
            asset_id = bytes.fromhex(market_info["quote"]["asset"][2:])
        else:  # Sell
            amount = quantity
            asset_id = bytes.fromhex(market_info["base"]["asset"][2:])

        # Parse order_type from JSON format
        ot = data["order_type"]
        if isinstance(ot, str):
            ot_name = ot
            ot_data = None
        elif isinstance(ot, dict):
            if "Limit" in ot:
                ot_name = "Limit"
                ot_data = {"price": ot["Limit"][0], "timestamp": ot["Limit"][1]}
            elif "BoundedMarket" in ot:
                ot_name = "BoundedMarket"
                ot_data = ot["BoundedMarket"]
            else:
                raise ValueError(f"Unknown order type dict: {ot}")
        else:
            raise ValueError(f"Invalid order_type: {ot}")

        call_data = encode_order_args(price, quantity, ot_name, ot_data)
        return {
            "contract_id": contract_id,
            "function_selector": function_selector("create_order"),
            "amount": amount,
            "asset_id": asset_id,
            "gas": GAS_MAX,
            "call_data": call_data,
        }

    elif "CancelOrder" in action:
        oid = action["CancelOrder"]["order_id"]
        order_id = bytes.fromhex(oid[2:] if oid.startswith("0x") else oid)
        return {
            "contract_id": contract_id,
            "function_selector": function_selector("cancel_order"),
            "amount": 0,
            "asset_id": zero_asset,
            "gas": GAS_MAX,
            "call_data": order_id,
        }

    elif "SettleBalance" in action:
        to = action["SettleBalance"]["to"]
        if "ContractId" in to:
            disc = 1
            addr = bytes.fromhex(to["ContractId"][2:])
        else:
            disc = 0
            addr = bytes.fromhex(to["Address"][2:])
        return {
            "contract_id": contract_id,
            "function_selector": function_selector("settle_balance"),
            "amount": 0,
            "asset_id": zero_asset,
            "gas": GAS_MAX,
            "call_data": encode_identity(disc, addr),
        }

    elif "RegisterReferer" in action:
        to = action["RegisterReferer"]["to"]
        if "ContractId" in to:
            disc = 1
            addr = bytes.fromhex(to["ContractId"][2:])
        else:
            disc = 0
            addr = bytes.fromhex(to["Address"][2:])
        # RegisterReferer uses accounts_registry_id, not market contract_id
        registry_id = bytes.fromhex(market_info["accounts_registry_id"][2:])
        return {
            "contract_id": registry_id,
            "function_selector": function_selector("register_referer"),
            "amount": 0,
            "asset_id": zero_asset,
            "gas": GAS_MAX,
            "call_data": encode_identity(disc, addr),
        }

    else:
        raise ValueError(f"Unknown action type: {action}")
