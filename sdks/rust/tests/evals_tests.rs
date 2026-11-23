use o2_sdk::crypto::raw_sign;
use o2_sdk::encoding::{
    build_actions_signing_bytes, build_eval_purchase_call, build_session_signing_bytes, GAS_MAX,
};
use o2_sdk::{ContractId, IntoValidId, MarketsResponse, Network, NetworkConfig, O2Client, Session};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/evals/purchase.json")).unwrap()
}

fn catalog(shop: Value) -> Value {
    json!({
        "eval_shop_id": shop,
        "books_registry_id": format!("0x{}", "55".repeat(32)),
        "accounts_registry_id": format!("0x{}", "66".repeat(32)),
        "trade_account_oracle_id": format!("0x{}", "77".repeat(32)),
        "chain_id": "0x0", "base_asset_id": vector()["asset_id"], "markets": []
    })
}

fn session() -> Session {
    Session {
        owner_address: [0x44; 32],
        session_private_key: [1; 32],
        session_address: [0x88; 32],
        trade_account_id: format!("0x{}", "33".repeat(32)).into_valid().unwrap(),
        contract_ids: vec![format!("0x{}", "AB".repeat(32)).into_valid().unwrap()],
        expiry: 9_999_999_999,
        nonce: 7,
    }
}

// Scripted local HTTP server: each response consumes exactly one request.
// Returning the listener lets tests assert that rejected/failed purchases never retry.
fn server(
    responses: Vec<Value>,
) -> (
    NetworkConfig,
    std::thread::JoinHandle<(Vec<Value>, TcpListener)>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut config = NetworkConfig::from_network(Network::Mainnet);
    config.api_base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for response in responses {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let mut buf = [0; 4096];
            let (header_end, length) = loop {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    break (end + 4, length);
                }
            };
            while data.len() < header_end + length {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
            }
            bodies.push(if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&data[header_end..header_end + length]).unwrap()
            });
            if !response.is_null() {
                let body = response.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            // A null response simulates a connection lost after receiving the request.
        }
        (bodies, listener)
    });
    (config, handle)
}

fn assert_no_more_requests(listener: TcpListener) {
    listener.set_nonblocking(true).unwrap();
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn eval_network_and_discovery() {
    let config = NetworkConfig::from_network(Network::Eval);
    assert_eq!(config.api_base, "https://api.eval.o2.app");
    assert_eq!(config.ws_url, "wss://api.eval.o2.app/v1/ws");
    assert_eq!(config.fuel_rpc, "https://testnet.fuel.network/v1/graphql");
    assert!(config.faucet_url.is_none());
    for shop in [vector()["shop_id"].clone(), Value::Null] {
        let parsed: MarketsResponse = serde_json::from_value(catalog(shop.clone())).unwrap();
        assert_eq!(serde_json::to_value(parsed.eval_shop_id).unwrap(), shop);
    }
    let mut old = catalog(Value::Null);
    old.as_object_mut().unwrap().remove("eval_shop_id");
    assert!(serde_json::from_value::<MarketsResponse>(old)
        .unwrap()
        .eval_shop_id
        .is_none());
}

#[test]
fn shared_purchase_vector_and_validation() {
    let v = vector();
    let call = build_eval_purchase_call(
        v["shop_id"].as_str().unwrap(),
        20,
        v["asset_id"].as_str().unwrap(),
        9_007_199_254_740_993,
    )
    .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(&call.function_selector)),
        v["function_selector"]
    );
    assert_eq!(
        format!("0x{}", hex::encode(call.call_data.as_ref().unwrap())),
        v["call_data"]
    );
    assert_eq!(call.gas, GAS_MAX);
    let payload = build_actions_signing_bytes(7, &[call]);
    assert_eq!(format!("0x{}", hex::encode(&payload)), v["signing_bytes"]);
    assert_eq!(
        format!("0x{}", hex::encode(raw_sign(&[1; 32], &payload).unwrap())),
        v["signature"]
    );
    for (shop, asset) in [
        ("0x123", v["asset_id"].as_str().unwrap()),
        (v["shop_id"].as_str().unwrap(), "0xgg"),
    ] {
        assert!(build_eval_purchase_call(shop, 1, asset, 1).is_err());
    }
}

#[tokio::test]
async fn purchase_signs_exact_wire_and_advances_nonce() {
    let v = vector();
    let (config, handle) = server(vec![
        catalog(v["shop_id"].clone()),
        json!({"tx_id": "0x99"}),
    ]);
    let mut client = O2Client::with_config(config);
    let mut active = session();
    assert!(client
        .buy_eval_account(
            &mut active,
            20,
            &v["asset_id"].as_str().unwrap().into_valid().unwrap(),
            9_007_199_254_740_993
        )
        .await
        .unwrap()
        .is_success());
    assert_eq!(active.nonce, 8);
    let (requests, listener) = handle.join().unwrap();
    assert_eq!(
        requests[1],
        json!({
            "actions": [{"actions": [{"BuyEvalAccount": {"tier_id": "20", "asset_id": v["asset_id"], "amount": v["amount"]}}]}],
            "signature": {"Secp256k1": v["signature"]},
            "nonce": "7", "trade_account_id": active.trade_account_id,
            "session_id": {"Address": format!("0x{}", "88".repeat(32))},
            "collect_orders": false
        })
    );
    assert_no_more_requests(listener);
}

#[tokio::test]
async fn unavailable_or_unapproved_shop_never_submits() {
    for shop in [
        Value::Null,
        json!(format!("0x{}", "00".repeat(32))),
        vector()["shop_id"].clone(),
    ] {
        let (config, handle) = server(vec![catalog(shop)]);
        let mut client = O2Client::with_config(config);
        let mut active = session();
        active.contract_ids.clear();
        assert!(client
            .buy_eval_account(
                &mut active,
                1,
                &vector()["asset_id"].as_str().unwrap().into_valid().unwrap(),
                1
            )
            .await
            .is_err());
        assert_eq!(active.nonce, 7);
        let (requests, listener) = handle.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_no_more_requests(listener);
    }
}

#[tokio::test]
async fn expired_session_never_contacts_api() {
    let (config, handle) = server(vec![]);
    let mut client = O2Client::with_config(config);
    let mut active = session();
    active.expiry = 1;
    assert!(client
        .buy_eval_account(
            &mut active,
            1,
            &vector()["asset_id"].as_str().unwrap().into_valid().unwrap(),
            1
        )
        .await
        .is_err());
    let (_, listener) = handle.join().unwrap();
    assert_no_more_requests(listener);
}

#[tokio::test]
async fn ambiguous_purchase_is_not_retried() {
    let (config, handle) = server(vec![
        catalog(vector()["shop_id"].clone()),
        Value::Null,
        json!({"trade_account_id": session().trade_account_id, "trade_account": {"nonce": "8", "owner": {"Address": format!("0x{}", "44".repeat(32))}, "last_modification": 0}}),
    ]);
    let mut client = O2Client::with_config(config);
    let mut active = session();
    assert!(client
        .buy_eval_account(
            &mut active,
            1,
            &vector()["asset_id"].as_str().unwrap().into_valid().unwrap(),
            1
        )
        .await
        .is_err());
    let (requests, listener) = handle.join().unwrap();
    assert_eq!(requests.iter().filter(|r| !r.is_null()).count(), 1);
    assert_no_more_requests(listener);
}

#[tokio::test]
async fn purchase_only_session_authorizes_shop() {
    let shop: ContractId = vector()["shop_id"].as_str().unwrap().into_valid().unwrap();
    let account = json!({"trade_account_id": session().trade_account_id, "trade_account": {"nonce": "3", "owner": {"Address": format!("0x{}", "44".repeat(32))}, "last_modification": 0}});
    let response = json!({"tx_id": "0x99", "trade_account_id": session().trade_account_id, "session_id": {"Address": format!("0x{}", "88".repeat(32))}, "contract_ids": [shop], "session_expiry": "9999999999"});
    let (config, handle) = server(vec![
        catalog(vector()["shop_id"].clone()),
        account,
        response,
    ]);
    let mut client = O2Client::with_config(config);
    let owner = o2_sdk::crypto::load_wallet(&[1; 32]).unwrap();
    let active = client
        .create_session_with_contracts(
            &owner,
            &[] as &[&str],
            Duration::from_secs(3600),
            &[shop.clone(), shop.clone()],
        )
        .await
        .unwrap();
    assert_eq!(active.contract_ids, vec![shop]);
    assert_eq!(active.nonce, 4);
    let (requests, listener) = handle.join().unwrap();
    assert_eq!(requests[2]["contract_ids"], json!([vector()["shop_id"]]));
    let payload =
        build_session_signing_bytes(3, 0, &active.session_address, &[[0xab; 32]], active.expiry);
    use o2_sdk::SignableWallet;
    assert_eq!(
        requests[2]["signature"]["Secp256k1"],
        format!("0x{}", hex::encode(owner.personal_sign(&payload).unwrap()))
    );
    assert_no_more_requests(listener);
}
