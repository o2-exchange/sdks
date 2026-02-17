//! Fuel ABI encoding primitives for O2 Exchange.
//!
//! Implements the exact byte layouts from the O2 integration guide:
//! - u64 big-endian encoding
//! - Function selectors (NOT hash-based: u64(len) + utf8(name))
//! - Identity encoding (discriminant + 32-byte address)
//! - Option encoding (None = u64(0), Some = u64(1) + data)
//! - OrderArgs struct encoding (tightly packed enum variants)
//! - Session signing bytes
//! - Action signing bytes

/// Encode a u64 value as 8 bytes big-endian.
pub fn u64_be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

/// Encode a Fuel ABI function selector: u64_be(len(name)) + utf8(name).
/// These are NOT hash-based like Solidity selectors.
pub fn function_selector(name: &str) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let mut result = Vec::with_capacity(8 + name_bytes.len());
    result.extend_from_slice(&u64_be(name_bytes.len() as u64));
    result.extend_from_slice(name_bytes);
    result
}

/// Encode a Fuel Identity enum: u64(discriminant) + 32-byte address.
/// discriminant: 0 = Address, 1 = ContractId
pub fn encode_identity(discriminant: u64, address: &[u8; 32]) -> Vec<u8> {
    let mut result = Vec::with_capacity(40);
    result.extend_from_slice(&u64_be(discriminant));
    result.extend_from_slice(address);
    result
}

/// Encode Option::None: u64(0).
pub fn encode_option_none() -> Vec<u8> {
    u64_be(0).to_vec()
}

/// Encode Option::Some(data): u64(1) + data.
pub fn encode_option_some(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(8 + data.len());
    result.extend_from_slice(&u64_be(1));
    result.extend_from_slice(data);
    result
}

/// Encode Option for call_data in action signing bytes.
/// None -> u64(0)
/// Some -> u64(1) + u64(len(data)) + data
pub fn encode_option_call_data(data: Option<&[u8]>) -> Vec<u8> {
    match data {
        None => u64_be(0).to_vec(),
        Some(d) => {
            let mut result = Vec::with_capacity(16 + d.len());
            result.extend_from_slice(&u64_be(1));
            result.extend_from_slice(&u64_be(d.len() as u64));
            result.extend_from_slice(d);
            result
        }
    }
}

/// Order type variants for encoding.
#[derive(Debug, Clone)]
pub enum OrderTypeEncoding {
    Limit { price: u64, timestamp: u64 },
    Spot,
    FillOrKill,
    PostOnly,
    Market,
    BoundedMarket { max_price: u64, min_price: u64 },
}

/// Encode OrderArgs struct for CreateOrder call_data.
/// Layout: u64(price) + u64(quantity) + order_type_encoding (tightly packed)
pub fn encode_order_args(price: u64, quantity: u64, order_type: &OrderTypeEncoding) -> Vec<u8> {
    let mut result = Vec::with_capacity(40);
    result.extend_from_slice(&u64_be(price));
    result.extend_from_slice(&u64_be(quantity));

    match order_type {
        OrderTypeEncoding::Limit {
            price: limit_price,
            timestamp,
        } => {
            result.extend_from_slice(&u64_be(0));
            result.extend_from_slice(&u64_be(*limit_price));
            result.extend_from_slice(&u64_be(*timestamp));
        }
        OrderTypeEncoding::Spot => {
            result.extend_from_slice(&u64_be(1));
        }
        OrderTypeEncoding::FillOrKill => {
            result.extend_from_slice(&u64_be(2));
        }
        OrderTypeEncoding::PostOnly => {
            result.extend_from_slice(&u64_be(3));
        }
        OrderTypeEncoding::Market => {
            result.extend_from_slice(&u64_be(4));
        }
        OrderTypeEncoding::BoundedMarket {
            max_price,
            min_price,
        } => {
            result.extend_from_slice(&u64_be(5));
            result.extend_from_slice(&u64_be(*max_price));
            result.extend_from_slice(&u64_be(*min_price));
        }
    }

    result
}

/// Build the signing bytes for set_session (Section 4.6 Step 3).
///
/// Layout:
///   u64(nonce) + u64(chain_id) + u64(len("set_session")) + "set_session"
///   + u64(1) [Option::Some] + u64(0) [Identity Address discriminant] + session_address(32)
///   + u64(expiry) + u64(len(contract_ids)) + contract_ids(32 each)
pub fn build_session_signing_bytes(
    nonce: u64,
    chain_id: u64,
    session_address: &[u8; 32],
    contract_ids: &[[u8; 32]],
    expiry: u64,
) -> Vec<u8> {
    let func_name = b"set_session";

    let mut result = Vec::with_capacity(128 + contract_ids.len() * 32);

    // Nonce + chain_id
    result.extend_from_slice(&u64_be(nonce));
    result.extend_from_slice(&u64_be(chain_id));

    // Function selector
    result.extend_from_slice(&u64_be(func_name.len() as u64));
    result.extend_from_slice(func_name);

    // Option::Some
    result.extend_from_slice(&u64_be(1));
    // Identity::Address
    result.extend_from_slice(&u64_be(0));
    // Session address
    result.extend_from_slice(session_address);
    // Expiry
    result.extend_from_slice(&u64_be(expiry));
    // Contract IDs vec
    result.extend_from_slice(&u64_be(contract_ids.len() as u64));
    for cid in contract_ids {
        result.extend_from_slice(cid);
    }

    result
}

/// A low-level contract call used in action signing.
pub struct CallArg {
    pub contract_id: [u8; 32],
    pub function_selector: Vec<u8>,
    pub amount: u64,
    pub asset_id: [u8; 32],
    pub gas: u64,
    pub call_data: Option<Vec<u8>>,
}

/// Gas value: always u64::MAX. The API overrides with its own value.
pub const GAS_MAX: u64 = u64::MAX;

/// Build the signing bytes for session actions (Section 4.7 Step 2).
///
/// Layout:
///   u64(nonce) + u64(num_calls) + for each call:
///     contract_id(32) + u64(selector_len) + selector + u64(amount) + asset_id(32)
///     + u64(gas) + encode_option_call_data(call_data)
pub fn build_actions_signing_bytes(nonce: u64, calls: &[CallArg]) -> Vec<u8> {
    let mut result = Vec::with_capacity(256);

    result.extend_from_slice(&u64_be(nonce));
    result.extend_from_slice(&u64_be(calls.len() as u64));

    for call in calls {
        result.extend_from_slice(&call.contract_id);
        result.extend_from_slice(&u64_be(call.function_selector.len() as u64));
        result.extend_from_slice(&call.function_selector);
        result.extend_from_slice(&u64_be(call.amount));
        result.extend_from_slice(&call.asset_id);
        result.extend_from_slice(&u64_be(call.gas));
        result.extend_from_slice(&encode_option_call_data(call.call_data.as_deref()));
    }

    result
}

/// Convert a high-level CreateOrder action to a low-level CallArg.
#[allow(clippy::too_many_arguments)]
pub fn create_order_to_call(
    contract_id: &[u8; 32],
    side: &str,
    price: u64,
    quantity: u64,
    order_type: &OrderTypeEncoding,
    base_decimals: u32,
    base_asset: &[u8; 32],
    quote_asset: &[u8; 32],
) -> CallArg {
    let call_data = encode_order_args(price, quantity, order_type);

    let (amount, asset_id) = if side == "Buy" {
        let amt = (price as u128 * quantity as u128) / 10u128.pow(base_decimals);
        (amt as u64, *quote_asset)
    } else {
        (quantity, *base_asset)
    };

    CallArg {
        contract_id: *contract_id,
        function_selector: function_selector("create_order"),
        amount,
        asset_id,
        gas: GAS_MAX,
        call_data: Some(call_data),
    }
}

/// Convert a CancelOrder action to a low-level CallArg.
pub fn cancel_order_to_call(contract_id: &[u8; 32], order_id: &[u8; 32]) -> CallArg {
    CallArg {
        contract_id: *contract_id,
        function_selector: function_selector("cancel_order"),
        amount: 0,
        asset_id: [0u8; 32],
        gas: GAS_MAX,
        call_data: Some(order_id.to_vec()),
    }
}

/// Convert a SettleBalance action to a low-level CallArg.
/// `to` is the destination identity (discriminant, address).
pub fn settle_balance_to_call(
    contract_id: &[u8; 32],
    to_discriminant: u64,
    to_address: &[u8; 32],
) -> CallArg {
    CallArg {
        contract_id: *contract_id,
        function_selector: function_selector("settle_balance"),
        amount: 0,
        asset_id: [0u8; 32],
        gas: GAS_MAX,
        call_data: Some(encode_identity(to_discriminant, to_address)),
    }
}

/// Build the signing bytes for a withdrawal.
///
/// Layout:
///   u64(nonce) + u64(chain_id) + u64(len("withdraw")) + "withdraw"
///   + u64(to_discriminant) + to_address(32)
///   + asset_id(32) + u64(amount)
pub fn build_withdraw_signing_bytes(
    nonce: u64,
    chain_id: u64,
    to_discriminant: u64,
    to_address: &[u8; 32],
    asset_id: &[u8; 32],
    amount: u64,
) -> Vec<u8> {
    let func_name = b"withdraw";

    let mut result = Vec::with_capacity(128);
    result.extend_from_slice(&u64_be(nonce));
    result.extend_from_slice(&u64_be(chain_id));
    result.extend_from_slice(&u64_be(func_name.len() as u64));
    result.extend_from_slice(func_name);
    // to identity
    result.extend_from_slice(&u64_be(to_discriminant));
    result.extend_from_slice(to_address);
    // asset_id
    result.extend_from_slice(asset_id);
    // amount
    result.extend_from_slice(&u64_be(amount));

    result
}

/// Convert a high-level `Action` to a low-level `CallArg` and JSON representation.
///
/// This is the typed counterpart to building calls manually. It handles
/// price/quantity scaling internally using the `Market`.
pub fn action_to_call(
    action: &crate::models::Action,
    market: &crate::models::Market,
    trade_account_id: &str,
    accounts_registry_id: Option<&[u8; 32]>,
) -> Result<(CallArg, serde_json::Value), crate::errors::O2Error> {
    use crate::crypto::parse_hex_32;
    use crate::models::{Action, Identity};

    let contract_id = parse_hex_32(&market.contract_id)?;

    match action {
        Action::CreateOrder {
            side,
            price,
            quantity,
            order_type,
        } => {
            let base_asset = parse_hex_32(market.base.asset.as_str())?;
            let quote_asset = parse_hex_32(market.quote.asset.as_str())?;
            let scaled_price = market.scale_price(price)?;
            let scaled_quantity = market.scale_quantity(quantity)?;
            let scaled_quantity = market.adjust_quantity(scaled_price, scaled_quantity)?;

            market.validate_order(scaled_price, scaled_quantity)?;

            let (ot_encoding, ot_json) = order_type.to_encoding(market)?;
            let side_str = side.as_str();

            let call = create_order_to_call(
                &contract_id,
                side_str,
                scaled_price,
                scaled_quantity,
                &ot_encoding,
                market.base.decimals,
                &base_asset,
                &quote_asset,
            );

            let json = serde_json::json!({
                "CreateOrder": {
                    "side": side_str,
                    "price": scaled_price.to_string(),
                    "quantity": scaled_quantity.to_string(),
                    "order_type": ot_json
                }
            });

            Ok((call, json))
        }
        Action::CancelOrder { order_id } => {
            let order_id_bytes = parse_hex_32(order_id.as_str())?;
            let call = cancel_order_to_call(&contract_id, &order_id_bytes);
            let json = serde_json::json!({
                "CancelOrder": { "order_id": order_id }
            });
            Ok((call, json))
        }
        Action::SettleBalance => {
            let trade_account_bytes = parse_hex_32(trade_account_id)?;
            let call = settle_balance_to_call(&contract_id, 1, &trade_account_bytes);
            let json = serde_json::json!({
                "SettleBalance": { "to": { "ContractId": trade_account_id } }
            });
            Ok((call, json))
        }
        Action::RegisterReferer { to } => {
            let registry_id = accounts_registry_id.ok_or_else(|| {
                crate::errors::O2Error::Other(
                    "accounts_registry_id required for RegisterReferer".into(),
                )
            })?;
            let (disc, addr_hex) = match to {
                Identity::Address(a) => (0u64, a.as_str()),
                Identity::ContractId(c) => (1u64, c.as_str()),
            };
            let addr_bytes = parse_hex_32(addr_hex)?;
            let call = register_referer_to_call(registry_id, disc, &addr_bytes);
            let json = serde_json::json!({
                "RegisterReferer": { "to": serde_json::to_value(to).unwrap_or_default() }
            });
            Ok((call, json))
        }
    }
}

/// Convert a RegisterReferer action to a low-level CallArg.
pub fn register_referer_to_call(
    accounts_registry_id: &[u8; 32],
    referer_discriminant: u64,
    referer_address: &[u8; 32],
) -> CallArg {
    CallArg {
        contract_id: *accounts_registry_id,
        function_selector: function_selector("register_referer"),
        amount: 0,
        asset_id: [0u8; 32],
        gas: GAS_MAX,
        call_data: Some(encode_identity(referer_discriminant, referer_address)),
    }
}
