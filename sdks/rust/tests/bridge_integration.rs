#![cfg(feature = "integration")]
//! Read-only integration test for the deployed Fast Bridge testnet proxy.
//!
//! Run with: cargo test --features integration --test bridge_integration

use o2_sdk::bridge::{BridgeError, FastBridgeClient, FAST_BRIDGE_TESTNET_URL};

const UNKNOWN_TRANSACTION_ID: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

fn assert_transaction_not_found<T>(result: Result<T, BridgeError>) {
    match result {
        Err(BridgeError::Api { status, code, .. }) => {
            assert_eq!(status, 404);
            assert_eq!(code, "TRANSACTION_NOT_FOUND");
        }
        Err(error) => panic!("expected transaction-not-found API error, got {error}"),
        Ok(_) => panic!("unknown transaction unexpectedly exists"),
    }
}

#[tokio::test]
async fn reads_every_fast_bridge_get_endpoint() {
    let client = FastBridgeClient::new(FAST_BRIDGE_TESTNET_URL).unwrap();

    let info = client.get_info().await.unwrap();
    assert_eq!(info.environment, "testnet");
    assert!(info.api_version.starts_with("1."));
    assert!(!info.chains.is_empty());

    let assets = client.get_assets(None).await.unwrap();
    assert!(!assets.assets.is_empty());

    let selected = assets.assets.iter().find_map(|asset| {
        asset
            .routes
            .iter()
            .find(|route| {
                info.chains
                    .iter()
                    .any(|chain| chain.chain_id == route.chain_id)
            })
            .map(|route| (asset.asset_id.clone(), route.chain_id))
    });
    let (asset_id, chain_id) =
        selected.expect("Testnet proxy returned no asset on a configured chain");
    let chain = info
        .chains
        .iter()
        .find(|chain| chain.chain_id == chain_id)
        .unwrap();

    let filtered_assets = client.get_assets(Some(chain_id)).await.unwrap();
    assert!(filtered_assets.assets.iter().any(|asset| {
        asset.asset_id == asset_id && asset.routes.iter().any(|route| route.chain_id == chain_id)
    }));

    let deposit = client
        .get_deposit_info(chain_id, Some(&asset_id), None)
        .await
        .unwrap();
    assert_eq!(deposit.source_chain_id, chain_id);
    assert_eq!(deposit.messenger_address, chain.messenger_address);
    assert!(deposit
        .assets
        .iter()
        .any(|asset| asset.asset_id == asset_id));

    let withdraw = client
        .get_withdraw_info(chain_id, Some(&asset_id), None)
        .await
        .unwrap();
    assert_eq!(withdraw.destination_chain_id, chain_id);
    assert_eq!(withdraw.messenger_address, chain.messenger_address);
    assert_eq!(withdraw.outpost_address, chain.outpost_address);
    assert!(withdraw
        .assets
        .iter()
        .any(|asset| asset.asset_id == asset_id));

    let fee = client.get_withdraw_fee(chain_id, &asset_id).await.unwrap();
    assert_eq!(fee.destination_chain_id, chain_id);
    assert_eq!(fee.asset_id, asset_id);
    assert!(fee.fee.parse::<u128>().is_ok());

    assert_transaction_not_found(
        client
            .get_deposit_status(chain_id, UNKNOWN_TRANSACTION_ID)
            .await,
    );
    assert_transaction_not_found(client.get_withdraw_status(UNKNOWN_TRANSACTION_ID).await);
}
