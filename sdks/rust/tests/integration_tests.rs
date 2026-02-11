/// Integration tests for O2 SDK against testnet.
///
/// These tests require network access and hit the live testnet API.
/// Run with: cargo test -- --ignored

use o2_sdk::*;

#[tokio::test]
#[ignore]
async fn test_fetch_markets() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    assert!(!markets.is_empty(), "Should have at least one market");

    let first = &markets[0];
    assert!(!first.market_id.is_empty());
    assert!(!first.contract_id.is_empty());
    assert!(!first.base.symbol.is_empty());
    assert!(!first.quote.symbol.is_empty());
}

#[tokio::test]
#[ignore]
async fn test_get_depth() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];

    let depth = client
        .api
        .get_depth(&market.market_id, 10)
        .await
        .unwrap();

    // Depth should have buys and sells (may be empty on thin testnet)
    assert!(depth.buys.is_some() || depth.sells.is_some());
}

#[tokio::test]
#[ignore]
async fn test_get_trades() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];

    let trades = client
        .api
        .get_trades(&market.market_id, "desc", 10, None, None)
        .await
        .unwrap();

    // Trades list may be empty on testnet, but should parse
    assert!(trades.trades.is_some() || trades.market_id.is_some());
}

#[tokio::test]
#[ignore]
async fn test_create_account_and_whitelist() {
    let client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();
    let owner_hex = crypto::to_hex_string(&wallet.b256_address);

    // Create account
    let account = client.api.create_account(&owner_hex).await.unwrap();
    assert!(
        account.trade_account_id.is_some(),
        "Should return trade_account_id"
    );

    let trade_account_id = account.trade_account_id.unwrap();

    // Whitelist (idempotent)
    let whitelist = client
        .api
        .whitelist_account(&trade_account_id)
        .await
        .unwrap();
    assert!(whitelist.success.unwrap_or(false));
}

#[tokio::test]
#[ignore]
async fn test_setup_account_idempotent() {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();

    // First call
    let account1 = client.setup_account(&wallet).await.unwrap();
    let trade_account_id = account1.trade_account_id.clone().unwrap();

    // Second call (should be idempotent)
    let account2 = client.setup_account(&wallet).await.unwrap();
    assert_eq!(
        account2.trade_account_id.unwrap(),
        trade_account_id,
        "Idempotent setup should return same trade_account_id"
    );
}

#[tokio::test]
#[ignore]
async fn test_faucet_mint() {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();

    // Setup account (handles create + whitelist)
    let account = match client.setup_account(&wallet).await {
        Ok(a) => a,
        Err(_) => {
            eprintln!("setup_account failed (rate limit expected on testnet)");
            return;
        }
    };
    let trade_account_id = account.trade_account_id.unwrap();

    // Mint to contract
    let result = client.api.mint_to_contract(&trade_account_id).await;
    // May fail due to cooldown, but should not panic
    match result {
        Ok(resp) => {
            assert!(
                resp.message.is_some() || resp.error.is_some(),
                "Faucet should return message or error"
            );
        }
        Err(_) => {
            // Acceptable — cooldown or network error
        }
    }
}

#[tokio::test]
#[ignore]
async fn test_full_session_creation() {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();

    // Setup account
    let _account = client.setup_account(&wallet).await.unwrap();

    // Wait for faucet cooldown if needed
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Get a market name
    let markets = client.get_markets().await.unwrap();
    let market_pair = markets[0].symbol_pair();

    // Create session
    let session = client
        .create_session(&wallet, &[&market_pair], 30)
        .await
        .unwrap();

    assert!(!session.trade_account_id.is_empty());
    assert!(!session.contract_ids.is_empty());
    assert!(session.expiry > 0);
}

#[tokio::test]
#[ignore]
async fn test_order_placement_and_cancellation() {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();

    // Setup
    let _account = client.setup_account(&wallet).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(65)).await; // faucet cooldown
    let _ = client.setup_account(&wallet).await; // second mint

    let markets = client.get_markets().await.unwrap();
    let market_pair = markets[0].symbol_pair();

    let mut session = client
        .create_session(&wallet, &[&market_pair], 30)
        .await
        .unwrap();

    // Place a spot buy order at a very low price (unlikely to fill)
    let result = client
        .create_order(
            &mut session,
            &market_pair,
            "Buy",
            0.001,
            100.0,
            "Spot",
            true,
            true,
        )
        .await;

    match result {
        Ok(resp) => {
            if resp.is_success() {
                let orders = resp.orders.unwrap_or_default();
                if let Some(order) = orders.first() {
                    if let Some(ref oid) = order.order_id {
                        // Cancel the order
                        let cancel = client
                            .cancel_order(&mut session, oid, &market_pair)
                            .await;
                        assert!(
                            cancel.is_ok(),
                            "Cancel should succeed"
                        );
                    }
                }
            }
        }
        Err(e) => {
            // May fail due to insufficient balance on testnet
            eprintln!("Order placement failed (may be expected on testnet): {e}");
        }
    }
}

#[tokio::test]
#[ignore]
async fn test_balance_check() {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();
    let account = match client.setup_account(&wallet).await {
        Ok(a) => a,
        Err(_) => {
            eprintln!("setup_account failed (rate limit expected on testnet)");
            return;
        }
    };
    let trade_account_id = account.trade_account_id.unwrap();

    let balances = client.get_balances(&trade_account_id).await.unwrap();
    // May be empty if faucet hasn't funded yet, but should parse
    let _ = &balances;
}

#[tokio::test]
#[ignore]
async fn test_aggregated_endpoints() {
    let client = O2Client::new(Network::Testnet);

    // Aggregated endpoints may not be available on testnet; just ensure no panics
    let _assets = client.api.get_aggregated_assets().await;
    let _summary = client.api.get_aggregated_summary().await;
    let _ticker = client.api.get_aggregated_ticker().await;
}

#[tokio::test]
#[ignore]
async fn test_market_resolution_by_pair() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();

    if !markets.is_empty() {
        let pair = markets[0].symbol_pair();
        let market = client.get_market(&pair).await.unwrap();
        assert_eq!(market.market_id, markets[0].market_id);
    }
}
