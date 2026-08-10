#![cfg(feature = "integration")]

use std::time::Duration;

use o2_sdk::{crypto::to_hex_string, Identity, Network, O2Client, Session};

async fn wait_for_balance(client: &O2Client, trade_account_id: &str, asset_id: &str) -> u128 {
    for _ in 0..24 {
        let balance = client
            .api
            .get_balance(asset_id, Some(trade_account_id), None)
            .await
            .expect("fetch testnet balance");
        if balance.trading_account_balance >= 2 {
            return balance.trading_account_balance;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    panic!("testnet faucet balance did not arrive within 120 seconds");
}

async fn wait_for_nonce(client: &O2Client, trade_account_id: &str, previous: u64) {
    for _ in 0..24 {
        let nonce = client
            .get_nonce(trade_account_id)
            .await
            .expect("fetch testnet nonce");
        if nonce > previous {
            return;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    panic!("testnet account nonce did not advance within 120 seconds");
}

#[tokio::test]
async fn withdraws_to_address_and_contract_id() {
    let mut source_client = O2Client::new(Network::Testnet);
    let recipient_client = O2Client::new(Network::Testnet);

    let source_wallet = source_client
        .generate_wallet()
        .expect("generate source wallet");
    let source = source_client
        .setup_account(&source_wallet)
        .await
        .expect("set up funded testnet account");
    let source_trade_account_id = source
        .trade_account_id
        .expect("source account has a trade account ID");

    let recipient_wallet = recipient_client
        .generate_wallet()
        .expect("generate recipient wallet");
    let recipient = recipient_client
        .api
        .create_account(&to_hex_string(&recipient_wallet.b256_address))
        .await
        .expect("create recipient account");

    let markets = source_client
        .get_markets()
        .await
        .expect("fetch testnet markets");
    let asset = markets
        .iter()
        .flat_map(|market| [&market.base, &market.quote])
        .find(|candidate| candidate.symbol == "fUSDC")
        .expect("fUSDC is configured on testnet");
    let before = wait_for_balance(
        &source_client,
        source_trade_account_id.as_str(),
        asset.asset.as_str(),
    )
    .await;
    let nonce_before = source_client
        .get_nonce(source_trade_account_id.as_str())
        .await
        .expect("fetch initial testnet nonce");

    let session = Session {
        owner_address: source_wallet.b256_address,
        session_private_key: [0; 32],
        session_address: [0; 32],
        trade_account_id: source_trade_account_id.clone(),
        contract_ids: Vec::new(),
        expiry: 0,
        nonce: 0,
    };

    let address = source_client
        .withdraw(&source_wallet, &session, &asset.asset, "1", None)
        .await
        .expect("withdraw to owner address");
    assert!(
        address.tx_id.is_some(),
        "address withdrawal returned no tx ID"
    );
    wait_for_nonce(
        &source_client,
        source_trade_account_id.as_str(),
        nonce_before,
    )
    .await;

    let contract = source_client
        .withdraw(
            &source_wallet,
            &session,
            &asset.asset,
            "1",
            Identity::ContractId(recipient.trade_account_id.to_string()),
        )
        .await
        .expect("withdraw to ContractId");
    assert!(
        contract.tx_id.is_some(),
        "ContractId withdrawal returned no tx ID"
    );

    let after = source_client
        .api
        .get_balance(
            asset.asset.as_str(),
            Some(source_trade_account_id.as_str()),
            None,
        )
        .await
        .expect("fetch final source balance")
        .trading_account_balance;
    assert_eq!(after, before - 2);
}
