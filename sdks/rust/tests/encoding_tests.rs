/// Unit tests for O2 SDK encoding module.
///
/// Tests Fuel ABI encoding primitives, function selectors, session signing bytes,
/// and action signing bytes.

use o2_sdk::encoding::*;

#[test]
fn test_u64_be_zero() {
    assert_eq!(u64_be(0), [0, 0, 0, 0, 0, 0, 0, 0]);
}

#[test]
fn test_u64_be_one() {
    assert_eq!(u64_be(1), [0, 0, 0, 0, 0, 0, 0, 1]);
}

#[test]
fn test_u64_be_max() {
    assert_eq!(u64_be(u64::MAX), [0xFF; 8]);
}

#[test]
fn test_u64_be_known_value() {
    // 100000000 = 0x05F5E100
    assert_eq!(
        u64_be(100_000_000),
        [0x00, 0x00, 0x00, 0x00, 0x05, 0xF5, 0xE1, 0x00]
    );
}

#[test]
fn test_function_selector_create_order() {
    let sel = function_selector("create_order");
    // u64_be(12) + "create_order"
    let expected_len = [0, 0, 0, 0, 0, 0, 0, 12];
    assert_eq!(&sel[..8], &expected_len);
    assert_eq!(&sel[8..], b"create_order");
    assert_eq!(sel.len(), 20);
}

#[test]
fn test_function_selector_cancel_order() {
    let sel = function_selector("cancel_order");
    assert_eq!(&sel[..8], &[0, 0, 0, 0, 0, 0, 0, 12]);
    assert_eq!(&sel[8..], b"cancel_order");
    assert_eq!(sel.len(), 20);
}

#[test]
fn test_function_selector_settle_balance() {
    let sel = function_selector("settle_balance");
    assert_eq!(&sel[..8], &[0, 0, 0, 0, 0, 0, 0, 14]);
    assert_eq!(&sel[8..], b"settle_balance");
    assert_eq!(sel.len(), 22);
}

#[test]
fn test_function_selector_register_referer() {
    let sel = function_selector("register_referer");
    assert_eq!(&sel[..8], &[0, 0, 0, 0, 0, 0, 0, 16]);
    assert_eq!(&sel[8..], b"register_referer");
    assert_eq!(sel.len(), 24);
}

#[test]
fn test_function_selector_set_session() {
    let sel = function_selector("set_session");
    assert_eq!(&sel[..8], &[0, 0, 0, 0, 0, 0, 0, 11]);
    assert_eq!(&sel[8..], b"set_session");
    assert_eq!(sel.len(), 19);
}

#[test]
fn test_encode_identity_address() {
    let addr = [0xAA; 32];
    let encoded = encode_identity(0, &addr);
    assert_eq!(encoded.len(), 40);
    assert_eq!(&encoded[..8], &u64_be(0)); // Address discriminant
    assert_eq!(&encoded[8..], &addr);
}

#[test]
fn test_encode_identity_contract_id() {
    let addr = [0xBB; 32];
    let encoded = encode_identity(1, &addr);
    assert_eq!(encoded.len(), 40);
    assert_eq!(&encoded[..8], &u64_be(1)); // ContractId discriminant
    assert_eq!(&encoded[8..], &addr);
}

#[test]
fn test_encode_option_none() {
    let encoded = encode_option_none();
    assert_eq!(encoded, u64_be(0).to_vec());
    assert_eq!(encoded.len(), 8);
}

#[test]
fn test_encode_option_some() {
    let data = vec![1, 2, 3, 4];
    let encoded = encode_option_some(&data);
    assert_eq!(&encoded[..8], &u64_be(1));
    assert_eq!(&encoded[8..], &data);
    assert_eq!(encoded.len(), 12);
}

#[test]
fn test_encode_option_call_data_none() {
    let encoded = encode_option_call_data(None);
    assert_eq!(encoded, u64_be(0).to_vec());
    assert_eq!(encoded.len(), 8);
}

#[test]
fn test_encode_option_call_data_some() {
    let data = vec![0xAA, 0xBB, 0xCC];
    let encoded = encode_option_call_data(Some(&data));
    assert_eq!(&encoded[..8], &u64_be(1)); // Some
    assert_eq!(&encoded[8..16], &u64_be(3)); // length = 3
    assert_eq!(&encoded[16..], &data);
    assert_eq!(encoded.len(), 19);
}

#[test]
fn test_encode_order_args_spot() {
    let price = 100_000_000u64;
    let quantity = 5_000_000_000u64;
    let encoded = encode_order_args(price, quantity, &OrderTypeEncoding::Spot);

    // 8 (price) + 8 (quantity) + 8 (variant index) = 24 bytes
    assert_eq!(encoded.len(), 24);
    assert_eq!(&encoded[0..8], &u64_be(price));
    assert_eq!(&encoded[8..16], &u64_be(quantity));
    assert_eq!(&encoded[16..24], &u64_be(1)); // Spot = variant 1
}

#[test]
fn test_encode_order_args_limit() {
    let price = 100_000_000u64;
    let quantity = 5_000_000_000u64;
    let limit_price = 90_000_000u64;
    let timestamp = 1734876543u64;

    let encoded = encode_order_args(
        price,
        quantity,
        &OrderTypeEncoding::Limit {
            price: limit_price,
            timestamp,
        },
    );

    // 8 + 8 + 8 (variant) + 8 (limit_price) + 8 (timestamp) = 40 bytes
    assert_eq!(encoded.len(), 40);
    assert_eq!(&encoded[0..8], &u64_be(price));
    assert_eq!(&encoded[8..16], &u64_be(quantity));
    assert_eq!(&encoded[16..24], &u64_be(0)); // Limit = variant 0
    assert_eq!(&encoded[24..32], &u64_be(limit_price));
    assert_eq!(&encoded[32..40], &u64_be(timestamp));
}

#[test]
fn test_encode_order_args_fill_or_kill() {
    let encoded = encode_order_args(100, 200, &OrderTypeEncoding::FillOrKill);
    assert_eq!(encoded.len(), 24);
    assert_eq!(&encoded[16..24], &u64_be(2)); // FillOrKill = variant 2
}

#[test]
fn test_encode_order_args_post_only() {
    let encoded = encode_order_args(100, 200, &OrderTypeEncoding::PostOnly);
    assert_eq!(encoded.len(), 24);
    assert_eq!(&encoded[16..24], &u64_be(3)); // PostOnly = variant 3
}

#[test]
fn test_encode_order_args_market() {
    let encoded = encode_order_args(100, 200, &OrderTypeEncoding::Market);
    assert_eq!(encoded.len(), 24);
    assert_eq!(&encoded[16..24], &u64_be(4)); // Market = variant 4
}

#[test]
fn test_encode_order_args_bounded_market() {
    let max_price = 110_000_000u64;
    let min_price = 90_000_000u64;
    let encoded = encode_order_args(
        100,
        200,
        &OrderTypeEncoding::BoundedMarket {
            max_price,
            min_price,
        },
    );

    // 8 + 8 + 8 + 8 + 8 = 40 bytes
    assert_eq!(encoded.len(), 40);
    assert_eq!(&encoded[16..24], &u64_be(5)); // BoundedMarket = variant 5
    assert_eq!(&encoded[24..32], &u64_be(max_price));
    assert_eq!(&encoded[32..40], &u64_be(min_price));
}

#[test]
fn test_build_session_signing_bytes() {
    let nonce = 0u64;
    let chain_id = 0u64;
    let session_address = [0xAA; 32];
    let contract_id = [0xBB; 32];
    let expiry = 1737504000u64;

    let bytes = build_session_signing_bytes(
        nonce,
        chain_id,
        &session_address,
        &[contract_id],
        expiry,
    );

    let mut expected = Vec::new();
    expected.extend_from_slice(&u64_be(nonce));
    expected.extend_from_slice(&u64_be(chain_id));
    expected.extend_from_slice(&u64_be(11)); // len("set_session")
    expected.extend_from_slice(b"set_session");
    expected.extend_from_slice(&u64_be(1)); // Option::Some
    expected.extend_from_slice(&u64_be(0)); // Identity::Address
    expected.extend_from_slice(&session_address);
    expected.extend_from_slice(&u64_be(expiry));
    expected.extend_from_slice(&u64_be(1)); // 1 contract_id
    expected.extend_from_slice(&contract_id);

    assert_eq!(bytes, expected);
}

#[test]
fn test_build_session_signing_bytes_multiple_contracts() {
    let session_address = [0xCC; 32];
    let contract_ids = [[0xDD; 32], [0xEE; 32]];

    let bytes = build_session_signing_bytes(
        5,
        9889,
        &session_address,
        &contract_ids,
        1700000000,
    );

    // Verify structure
    let mut offset = 0;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(5)); // nonce
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(9889)); // chain_id
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(11)); // func name len
    offset += 8;
    assert_eq!(&bytes[offset..offset + 11], b"set_session");
    offset += 11;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(1)); // Option::Some
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(0)); // Identity::Address
    offset += 8;
    assert_eq!(&bytes[offset..offset + 32], &session_address);
    offset += 32;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(1700000000)); // expiry
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(2)); // 2 contract_ids
    offset += 8;
    assert_eq!(&bytes[offset..offset + 32], &contract_ids[0]);
    offset += 32;
    assert_eq!(&bytes[offset..offset + 32], &contract_ids[1]);
}

#[test]
fn test_build_actions_signing_bytes_empty() {
    let bytes = build_actions_signing_bytes(0, &[]);
    assert_eq!(&bytes[..8], &u64_be(0)); // nonce
    assert_eq!(&bytes[8..16], &u64_be(0)); // 0 calls
    assert_eq!(bytes.len(), 16);
}

#[test]
fn test_build_actions_signing_bytes_single_call() {
    let contract_id = [0xAA; 32];
    let selector = function_selector("create_order");
    let asset_id = [0xBB; 32];
    let call_data = vec![1, 2, 3, 4, 5, 6, 7, 8];

    let calls = vec![CallArg {
        contract_id,
        function_selector: selector.clone(),
        amount: 1000,
        asset_id,
        gas: GAS_MAX,
        call_data: Some(call_data.clone()),
    }];

    let bytes = build_actions_signing_bytes(42, &calls);

    let mut offset = 0;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(42)); // nonce
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(1)); // 1 call
    offset += 8;
    assert_eq!(&bytes[offset..offset + 32], &contract_id);
    offset += 32;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(selector.len() as u64));
    offset += 8;
    assert_eq!(&bytes[offset..offset + selector.len()], &selector);
    offset += selector.len();
    assert_eq!(&bytes[offset..offset + 8], &u64_be(1000));
    offset += 8;
    assert_eq!(&bytes[offset..offset + 32], &asset_id);
    offset += 32;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(GAS_MAX));
    offset += 8;
    // Option::Some for call_data
    assert_eq!(&bytes[offset..offset + 8], &u64_be(1));
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &u64_be(8)); // call_data length
    offset += 8;
    assert_eq!(&bytes[offset..offset + 8], &call_data);
}

#[test]
fn test_create_order_to_call_buy() {
    let contract_id = [0x11; 32];
    let base_asset = [0x22; 32];
    let quote_asset = [0x33; 32];

    let call = create_order_to_call(
        &contract_id,
        "Buy",
        100_000_000,      // price
        5_000_000_000,    // quantity
        &OrderTypeEncoding::Spot,
        9,                // base_decimals
        &base_asset,
        &quote_asset,
    );

    // amount for Buy = (price * quantity) / 10^base_decimals
    // = (100_000_000 * 5_000_000_000) / 10^9
    // = 500_000_000_000_000_000 / 1_000_000_000
    // = 500_000_000
    assert_eq!(call.amount, 500_000_000);
    assert_eq!(call.asset_id, quote_asset);
    assert_eq!(call.contract_id, contract_id);
    assert_eq!(call.gas, GAS_MAX);
    assert!(call.call_data.is_some());
}

#[test]
fn test_create_order_to_call_sell() {
    let contract_id = [0x11; 32];
    let base_asset = [0x22; 32];
    let quote_asset = [0x33; 32];

    let call = create_order_to_call(
        &contract_id,
        "Sell",
        100_000_000,
        5_000_000_000,
        &OrderTypeEncoding::Spot,
        9,
        &base_asset,
        &quote_asset,
    );

    // amount for Sell = quantity
    assert_eq!(call.amount, 5_000_000_000);
    assert_eq!(call.asset_id, base_asset);
}

#[test]
fn test_cancel_order_to_call() {
    let contract_id = [0x11; 32];
    let order_id = [0xFF; 32];

    let call = cancel_order_to_call(&contract_id, &order_id);

    assert_eq!(call.amount, 0);
    assert_eq!(call.asset_id, [0u8; 32]);
    assert_eq!(call.call_data.as_ref().unwrap(), &order_id.to_vec());
}

#[test]
fn test_settle_balance_to_call() {
    let contract_id = [0x11; 32];
    let to_address = [0x22; 32];

    let call = settle_balance_to_call(&contract_id, 1, &to_address);

    assert_eq!(call.amount, 0);
    assert_eq!(call.asset_id, [0u8; 32]);
    // call_data should be encode_identity(1, to_address) = 40 bytes
    assert_eq!(call.call_data.as_ref().unwrap().len(), 40);
}

#[test]
fn test_precomputed_function_selectors_match() {
    // Verify the precomputed selectors from the integration guide
    let co = function_selector("create_order");
    assert_eq!(
        co,
        vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C,
             0x63, 0x72, 0x65, 0x61, 0x74, 0x65, 0x5F, 0x6F,
             0x72, 0x64, 0x65, 0x72]
    );

    let ca = function_selector("cancel_order");
    assert_eq!(
        ca,
        vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C,
             0x63, 0x61, 0x6E, 0x63, 0x65, 0x6C, 0x5F, 0x6F,
             0x72, 0x64, 0x65, 0x72]
    );

    let sb = function_selector("settle_balance");
    assert_eq!(
        sb,
        vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0E,
             0x73, 0x65, 0x74, 0x74, 0x6C, 0x65, 0x5F, 0x62,
             0x61, 0x6C, 0x61, 0x6E, 0x63, 0x65]
    );

    let rr = function_selector("register_referer");
    assert_eq!(
        rr,
        vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
             0x72, 0x65, 0x67, 0x69, 0x73, 0x74, 0x65, 0x72,
             0x5F, 0x72, 0x65, 0x66, 0x65, 0x72, 0x65, 0x72]
    );
}
