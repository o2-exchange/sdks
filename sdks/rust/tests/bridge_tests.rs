use o2_sdk::bridge::*;
use o2_sdk::crypto::{fuel_compact_sign, parse_hex_32};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/bridge/transactions.json")).unwrap()
}
fn assert_expected(actual: &Value, expected: &Value) {
    for (key, value) in expected.as_object().unwrap() {
        if value.is_object() {
            assert_expected(&actual[key], value);
        } else if actual[key].is_number() && value.is_string() {
            assert_eq!(actual[key].to_string(), value.as_str().unwrap(), "{key}");
        } else {
            assert_eq!(&actual[key], value, "{key}");
        }
    }
}
#[test]
fn evm_oracle() {
    for vector in vectors()["evm"].as_array().unwrap() {
        let parsed =
            parse_evm_unsigned_transaction(vector["unsignedTransaction"].as_str().unwrap())
                .unwrap();
        assert_expected(&serde_json::to_value(&parsed).unwrap(), &vector["expected"]);
        assert_eq!(serde_json::to_value(&parsed).unwrap()["type"], 2);
        let mut compact =
            fuel_compact_sign(&[0x11; 32], &parse_hex_32(&parsed.signing_digest).unwrap()).unwrap();
        let v = 27 + (compact[32] >> 7);
        compact[32] &= 127;
        let mut signature = compact.to_vec();
        signature.push(v);
        assert_eq!(format!("0x{}", hex::encode(signature)), vector["signature"]);
    }
}
#[test]
fn fuel_oracle() {
    for vector in vectors()["fuel"].as_array().unwrap() {
        let parsed = parse_fuel_unsigned_transaction(
            vector["unsignedTransaction"].as_str().unwrap(),
            vector["fuelChainId"].as_str().unwrap().parse().unwrap(),
            vector["fuelMaxInputs"].as_u64().unwrap() as u16,
        )
        .unwrap();
        assert_expected(&serde_json::to_value(&parsed).unwrap(), &vector["expected"]);
        assert_eq!(
            parsed
                .inputs
                .iter()
                .map(|i| i.kind.as_str())
                .collect::<Vec<_>>(),
            ["coin", "contract", "message"]
        );
        assert_eq!(parsed.outputs[2].amount, Some(2345));
        assert_eq!(
            serde_json::to_value(&parsed.inputs[0]).unwrap()["type"],
            "coin"
        );
        assert_eq!(
            serde_json::to_value(&parsed.outputs[2]).unwrap()["type"],
            "variable"
        );
        let signature =
            fuel_compact_sign(&[0x11; 32], &parse_hex_32(&parsed.transaction_id).unwrap()).unwrap();
        assert_eq!(format!("0x{}", hex::encode(signature)), vector["signature"]);
    }
}
#[test]
fn proof_decoding_and_malformed_data() {
    for vector in vectors()["invalidEvm"].as_array().unwrap() {
        assert!(
            parse_evm_unsigned_transaction(vector["unsignedTransaction"].as_str().unwrap())
                .is_err(),
            "{}",
            vector["name"]
        );
    }
    for vector in vectors()["invalidFuel"].as_array().unwrap() {
        assert!(
            parse_fuel_unsigned_transaction(
                vector["unsignedTransaction"].as_str().unwrap(),
                0,
                255
            )
            .is_err(),
            "{}",
            vector["name"]
        );
    }
    for vector in vectors()["proofs"].as_array().unwrap() {
        let parsed = parse_preparation_proof(vector["proof"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), vector["claims"]);
        // Deliberately replace the MAC: decoding is not authentication.
        let claims = vector["proof"].as_str().unwrap().split('.').next().unwrap();
        assert!(parse_preparation_proof(&format!("{claims}.{}", "A".repeat(43))).is_ok());
    }
    for proof in ["", "a.b", "a.b.c", &"x".repeat(2049)] {
        assert!(parse_preparation_proof(proof).is_err());
    }
    for (key, fuel) in [("evm", false), ("fuel", true)] {
        for vector in vectors()[key].as_array().unwrap() {
            let raw = vector["unsignedTransaction"].as_str().unwrap();
            let parse = |value: &str| {
                if fuel {
                    parse_fuel_unsigned_transaction(value, 0, 255).map(|_| ())
                } else {
                    parse_evm_unsigned_transaction(value).map(|_| ())
                }
            };
            for end in (2..raw.len()).step_by(2) {
                assert!(
                    parse(&raw[..end]).is_err(),
                    "accepted truncated {key} at {end}"
                );
            }
            assert!(parse(&format!("{raw}00")).is_err());
        }
    }
}

#[test]
fn fuel_consensus_context() {
    let fixtures = vectors();
    for (index, max_inputs) in [(0, 511), (3, 255)] {
        let error = parse_fuel_unsigned_transaction(
            fixtures["fuel"][index]["unsignedTransaction"]
                .as_str()
                .unwrap(),
            0,
            max_inputs,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Fuel call pointer"));
    }
    assert!(parse_fuel_unsigned_transaction(
        fixtures["fuel"][0]["unsignedTransaction"].as_str().unwrap(),
        0,
        0
    )
    .is_err());
    // u64/u16 parameter types reject negative/overflowing context at compile time.
}

#[test]
fn invalid_client_configuration() {
    for url in [
        "file:///tmp",
        "https://bridge.example?query=yes",
        "https://user:pass@bridge.example",
    ] {
        assert!(FastBridgeClient::new(url).is_err());
    }
    assert!(FastBridgeClient::with_timeout("https://bridge.example", Duration::ZERO).is_err());
}

#[tokio::test]
async fn all_endpoint_mappings() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../fixtures/bridge/http.json")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/proxy/", listener.local_addr().unwrap());
    let expected = fixtures.clone();
    let server = std::thread::spawn(move || {
        for fixture in expected.as_array().unwrap() {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let headers_end = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                data.extend_from_slice(&chunk[..count]);
                if let Some(index) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8(data[..headers_end].to_vec()).unwrap();
            let mut first = headers.lines().next().unwrap().split_whitespace();
            assert_eq!(first.next().unwrap(), fixture["method"]);
            let target = url::Url::parse(&format!("http://test{}", first.next().unwrap())).unwrap();
            assert_eq!(
                target.path(),
                format!("/proxy{}", fixture["path"].as_str().unwrap())
            );
            let query: std::collections::BTreeMap<String, String> = target
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            let wanted: std::collections::BTreeMap<String, String> = fixture["query"]
                .as_object()
                .map(|q| {
                    q.iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                v.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| v.to_string()),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(query, wanted);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while data.len() < headers_end + length {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                data.extend_from_slice(&chunk[..count]);
            }
            if length > 0 {
                assert_eq!(
                    serde_json::from_slice::<Value>(&data[headers_end..]).unwrap(),
                    fixture["body"]
                );
            }
            let body = fixture["response"].to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    let client = FastBridgeClient::new(&url).unwrap();
    assert_eq!(
        serde_json::to_value(client.get_info().await.unwrap()).unwrap(),
        fixtures[0]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_assets(Some(fixtures[1]["query"]["chainId"].as_u64().unwrap()))
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[1]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_deposit_info(
                    fixtures[2]["query"]["sourceChainId"].as_u64().unwrap(),
                    Some(fixtures[2]["query"]["assetId"].as_str().unwrap()),
                    Some(fixtures[2]["query"]["amount"].as_str().unwrap())
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[2]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .prepare_deposit(
                    &serde_json::from_value::<DepositPrepareRequest>(fixtures[3]["body"].clone())
                        .unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[3]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .submit_deposit(
                    &serde_json::from_value::<SubmitRequest>(fixtures[4]["body"].clone()).unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[4]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_deposit_status(
                    fixtures[5]["query"]["sourceChainId"].as_u64().unwrap(),
                    fixtures[5]["query"]["evmTxHash"].as_str().unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[5]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_withdraw_info(
                    fixtures[6]["query"]["destinationChainId"].as_u64().unwrap(),
                    Some(fixtures[6]["query"]["assetId"].as_str().unwrap()),
                    Some(fixtures[6]["query"]["amount"].as_str().unwrap())
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[6]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_withdraw_fee(
                    fixtures[7]["query"]["destinationChainId"].as_u64().unwrap(),
                    fixtures[7]["query"]["assetId"].as_str().unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[7]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .prepare_withdraw(
                    &serde_json::from_value::<WithdrawPrepareRequest>(fixtures[8]["body"].clone())
                        .unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[8]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .submit_withdraw(
                    &serde_json::from_value::<SubmitRequest>(fixtures[9]["body"].clone()).unwrap()
                )
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[9]["response"]
    );
    assert_eq!(
        serde_json::to_value(
            client
                .get_withdraw_status(fixtures[10]["query"]["fuelTxId"].as_str().unwrap())
                .await
                .unwrap()
        )
        .unwrap(),
        fixtures[10]["response"]
    );
    server.join().unwrap();
}
#[tokio::test]
async fn errors_preserve_status_and_details() {
    for status in [404, 410, 429, 503] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = [0; 4096];
            assert!(socket.read(&mut data).unwrap() > 0);
            let body =
                json!({"error":{"code":"TEST_CODE","message":"test","details":{"retry":false}}})
                    .to_string();
            write!(socket, "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let client = FastBridgeClient::new(&url).unwrap();
        match client.get_info().await.unwrap_err() {
            BridgeError::Api {
                status: s,
                code,
                details,
                ..
            } => {
                assert_eq!(s, status);
                assert_eq!(code, "TEST_CODE");
                assert_eq!(details, Some(json!({"retry":false})));
            }
            e => panic!("{e:?}"),
        }
        server.join().unwrap();
    }
}

#[tokio::test]
async fn malformed_response_shapes() {
    for (status, payload, code) in [
        (200, json!(null), "INVALID_RESPONSE"),
        (200, json!([]), "INVALID_RESPONSE"),
        (502, json!({"error": "gateway error"}), "HTTP_ERROR"),
        (502, json!({"error": null}), "HTTP_ERROR"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = [0; 4096];
            assert!(socket.read(&mut data).unwrap() > 0);
            let body = payload.to_string();
            write!(socket, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        match FastBridgeClient::new(&base_url)
            .unwrap()
            .get_info()
            .await
            .unwrap_err()
        {
            BridgeError::Api {
                status: actual_status,
                code: actual_code,
                ..
            } => {
                assert_eq!(actual_status, status);
                assert_eq!(actual_code, code);
            }
            error => panic!("{error:?}"),
        }
        server.join().unwrap();
    }
}
