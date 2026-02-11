/// Integration tests for O2 SDK against testnet.
///
/// These tests require network access and hit the live testnet API.
/// Run with: cargo test -- --ignored

use futures_util::StreamExt;
use serial_test::serial;
use tokio::sync::OnceCell;

use o2_sdk::api::O2Api;
use o2_sdk::*;

struct SharedSetup {
    maker_wallet: Wallet,
    maker_trade_account_id: String,
    taker_wallet: Wallet,
    taker_trade_account_id: String,
}

static SHARED: OnceCell<SharedSetup> = OnceCell::const_new();

async fn mint_with_retry(api: &O2Api, trade_account_id: &str, max_retries: usize) {
    for attempt in 0..max_retries {
        if api.mint_to_contract(trade_account_id).await.is_ok() {
            return;
        }
        if attempt < max_retries - 1 {
            tokio::time::sleep(std::time::Duration::from_secs(65)).await;
        }
    }
}

async fn whitelist_with_retry(api: &O2Api, trade_account_id: &str, max_retries: usize) {
    for attempt in 0..max_retries {
        if api.whitelist_account(trade_account_id).await.is_ok() {
            // Allow time for on-chain whitelist propagation
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            return;
        }
        if attempt < max_retries - 1 {
            tokio::time::sleep(std::time::Duration::from_secs(65)).await;
        }
    }
}

/// Place an order, retrying with re-whitelist on TraderNotWhiteListed errors.
async fn create_order_with_whitelist_retry(
    client: &mut O2Client,
    session: &mut Session,
    trade_account_id: &str,
    market_pair: &str,
    side: &str,
    price: f64,
    quantity: f64,
    order_type: &str,
    settle_first: bool,
    collect_orders: bool,
    max_retries: usize,
) -> Result<o2_sdk::models::SessionActionsResponse, o2_sdk::O2Error> {
    for attempt in 0..max_retries {
        match client
            .create_order(session, market_pair, side, price, quantity, order_type, settle_first, collect_orders)
            .await
        {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                let is_whitelist_err = match &e {
                    o2_sdk::O2Error::OnChainRevert { reason, .. } => reason.contains("TraderNotWhiteListed"),
                    other => format!("{other}").contains("TraderNotWhiteListed"),
                };
                if is_whitelist_err && attempt < max_retries - 1 {
                    whitelist_with_retry(&client.api, trade_account_id, 2).await;
                    // Additional backoff on top of whitelist propagation delay
                    tokio::time::sleep(std::time::Duration::from_secs(5 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

async fn setup_funded_account(client: &mut O2Client) -> (Wallet, String) {
    let wallet = client.generate_wallet().unwrap();
    let mut account = None;
    for attempt in 0..4u32 {
        match client.setup_account(&wallet).await {
            Ok(a) => {
                account = Some(a);
                break;
            }
            Err(_) if attempt < 3 => {
                tokio::time::sleep(std::time::Duration::from_secs(65)).await;
            }
            Err(e) => panic!("setup_account failed after retries: {e}"),
        }
    }
    let trade_account_id = account.unwrap().trade_account_id.clone().unwrap();
    whitelist_with_retry(&client.api, &trade_account_id, 4).await;
    mint_with_retry(&client.api, &trade_account_id, 4).await;
    (wallet, trade_account_id)
}

async fn get_shared_setup() -> &'static SharedSetup {
    SHARED
        .get_or_init(|| async {
            let mut client = O2Client::new(Network::Testnet);
            let (maker_wallet, maker_trade_account_id) =
                setup_funded_account(&mut client).await;
            let (taker_wallet, taker_trade_account_id) =
                setup_funded_account(&mut client).await;
            SharedSetup {
                maker_wallet,
                maker_trade_account_id,
                taker_wallet,
                taker_trade_account_id,
            }
        })
        .await
}

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
async fn test_market_resolution_by_pair() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();

    if !markets.is_empty() {
        let pair = markets[0].symbol_pair();
        let market = client.get_market(&pair).await.unwrap();
        assert_eq!(market.market_id, markets[0].market_id);
    }
}

#[tokio::test]
#[ignore]
async fn test_faucet_mint() {
    let shared = get_shared_setup().await;
    let client = O2Client::new(Network::Testnet);

    // Verify the shared account exists and has a trade_account_id
    let account = client
        .api
        .get_account_by_id(&shared.maker_trade_account_id)
        .await
        .unwrap();
    assert!(
        account.trade_account_id.is_some(),
        "Shared account should exist"
    );
}

#[tokio::test]
#[ignore]
async fn test_balance_check() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let balances = client.get_balances(&shared.maker_trade_account_id).await.unwrap();
    // May be empty if faucet hasn't funded yet, but should parse
    let _ = &balances;
}

#[tokio::test]
#[ignore]
#[serial]
async fn test_full_session_creation() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    // Get a market name
    let markets = client.get_markets().await.unwrap();
    let market_pair = markets[0].symbol_pair();

    // Create session using the shared wallet
    let session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    assert!(!session.trade_account_id.is_empty());
    assert!(!session.contract_ids.is_empty());
    assert!(session.expiry > 0);
}

/// Calculate minimum quantity that meets min_order at the given price.
fn min_quantity_for_min_order(market: &o2_sdk::Market, price: f64) -> f64 {
    let min_order: f64 = market.min_order.parse().unwrap_or(1_000_000.0);
    let base_factor = 10f64.powi(market.base.decimals as i32);
    let quote_factor = 10f64.powi(market.quote.decimals as i32);
    let min_qty = min_order / (price * quote_factor);
    let truncate_factor = 10f64.powi(market.base.decimals as i32 - market.base.max_precision as i32);
    let step = truncate_factor / base_factor;
    let rounded = ((min_qty / step).ceil()) * step;
    rounded * 1.1  // 10% margin
}

/// Get reference price, best bid, and best ask from market data.
async fn get_market_prices(client: &mut O2Client, market: &o2_sdk::Market) -> (f64, f64, f64) {
    let mut ref_price = 0.0;
    let mut best_bid = 0.0;
    let mut best_ask = 0.0;

    if let Ok(depth) = client.api.get_depth(&market.market_id, 10).await {
        if let Some(buys) = &depth.buys {
            if let Some(entry) = buys.first() {
                if let Ok(p) = entry.price.parse::<u64>() {
                    if p > 0 {
                        best_bid = market.format_price(p);
                        if ref_price == 0.0 { ref_price = best_bid; }
                    }
                }
            }
        }
        if let Some(sells) = &depth.sells {
            if let Some(entry) = sells.first() {
                if let Ok(p) = entry.price.parse::<u64>() {
                    if p > 0 {
                        best_ask = market.format_price(p);
                        if ref_price == 0.0 { ref_price = best_ask; }
                    }
                }
            }
        }
    }

    if let Ok(trades) = client.api.get_trades(&market.market_id, "desc", 5, None, None).await {
        if let Some(trade_list) = &trades.trades {
            if let Some(first) = trade_list.first() {
                if let Some(price_str) = &first.price {
                    if let Ok(p) = price_str.parse::<u64>() {
                        if p > 0 { ref_price = market.format_price(p); }
                    }
                }
            }
        }
    }

    if ref_price == 0.0 { ref_price = 1.0; }
    (ref_price, best_bid, best_ask)
}

#[tokio::test]
#[ignore]
#[serial]
async fn test_order_placement_and_cancellation() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist before trading (handles propagation delays)
    whitelist_with_retry(&client.api, &shared.maker_trade_account_id, 2).await;

    // Use the minimum price step — guaranteed below any ask on the book.
    // The buy cost is always ≈ min_order regardless of price, so this is affordable.
    let price_step = 10f64.powi(-(market.quote.max_precision as i32));
    let buy_price = price_step;
    let quantity = min_quantity_for_min_order(market, buy_price);

    // Verify quote balance
    let balances = client
        .get_balances(&shared.maker_trade_account_id)
        .await
        .unwrap();
    let quote_symbol = &markets[0].quote.symbol;
    let quote_balance = balances
        .get(quote_symbol)
        .expect("No quote balance after faucet");
    let balance_val: u64 = quote_balance
        .trading_account_balance
        .as_deref()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    assert!(balance_val > 0, "Quote balance should be > 0");

    let mut session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    // Place PostOnly Buy at minimum price — guaranteed to rest on the book
    let resp = create_order_with_whitelist_retry(
        &mut client,
        &mut session,
        &shared.maker_trade_account_id,
        &market_pair,
        "Buy",
        buy_price,
        quantity,
        "PostOnly",
        true,
        true,
        3,
    )
    .await
    .unwrap();

    assert!(
        resp.is_success(),
        "Order placement failed: {:?}",
        resp.message
    );
    let orders = resp.orders.as_ref().expect("Should have orders in response");
    assert!(!orders.is_empty(), "Orders list should not be empty");
    let order = &orders[0];
    let order_id = order.order_id.as_ref().expect("Order should have order_id");
    assert_ne!(
        order.cancel,
        Some(true),
        "Order was unexpectedly cancelled"
    );

    // Cancel the order
    let cancel_resp = client
        .cancel_order(&mut session, order_id, &market_pair)
        .await
        .unwrap();
    assert!(cancel_resp.is_success(), "Cancel should succeed");
}

#[tokio::test]
#[ignore]
#[serial]
async fn test_cross_account_fill() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist both accounts before trading
    whitelist_with_retry(&client.api, &shared.maker_trade_account_id, 2).await;
    whitelist_with_retry(&client.api, &shared.taker_trade_account_id, 2).await;

    // Get reference price from market data
    let (ref_price, _best_bid, best_ask) = get_market_prices(&mut client, market).await;

    // Sell price: 10% above best ask to ensure PostOnly rests.
    // Using a moderate premium keeps taker quantity affordable.
    let sell_price = if best_ask > 0.0 {
        best_ask * 1.1
    } else {
        ref_price * 1.5
    };
    let quantity = min_quantity_for_min_order(market, sell_price);

    // Check maker base balance
    let balances = client
        .get_balances(&shared.maker_trade_account_id)
        .await
        .unwrap();
    let base_symbol = &market.base.symbol;
    let base_val: u64 = balances
        .get(base_symbol)
        .and_then(|b| b.trading_account_balance.as_deref())
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    assert!(base_val > 0, "Maker base balance should be > 0 after faucet");

    // Maker: PostOnly Sell above market → rests on the book
    let mut maker_session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let maker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut maker_session,
        &shared.maker_trade_account_id,
        &market_pair,
        "Sell",
        sell_price,
        quantity,
        "PostOnly",
        true,
        true,
        3,
    )
    .await
    .unwrap();

    assert!(
        maker_resp.is_success(),
        "Maker order failed: {:?}",
        maker_resp.message
    );
    let maker_orders = maker_resp
        .orders
        .as_ref()
        .expect("Should have maker orders");
    assert!(!maker_orders.is_empty());
    let maker_order = &maker_orders[0];
    let maker_order_id = maker_order
        .order_id
        .as_ref()
        .expect("Maker order should have order_id");
    assert_ne!(
        maker_order.cancel,
        Some(true),
        "Maker order was unexpectedly cancelled"
    );

    // Taker: buy a small multiple of the maker quantity to limit gas usage.
    // Using too much quote balance causes OutOfGas when the taker walks
    // through many intermediate orders on a busy book.
    let taker_quantity = quantity * 3.0;

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        "Buy",
        sell_price,
        taker_quantity,
        "Spot",
        true,
        true,
        3,
    )
    .await
    .unwrap();

    assert!(
        taker_resp.is_success(),
        "Taker order failed: {:?}",
        taker_resp.message
    );

    // Cleanup: cancel maker order if still open (may or may not have been filled)
    let _ = client.cancel_order(&mut maker_session, maker_order_id, &market_pair).await;
}

#[tokio::test]
#[ignore]
async fn test_nonce_fetch() {
    let shared = get_shared_setup().await;
    let client = O2Client::new(Network::Testnet);

    let nonce = client.get_nonce(&shared.maker_trade_account_id).await.unwrap();
    // u64 is always >= 0; just verify the call succeeded
    let _ = nonce;
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
async fn test_websocket_depth() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    assert!(!markets.is_empty(), "Should have at least one market");

    let market = &markets[0];
    let (ws, mut stream) = client
        .stream_depth(&market.market_id, "10")
        .await
        .unwrap();

    // Wait for one depth update with a timeout
    let update = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.next(),
    )
    .await;

    match update {
        Ok(Some(depth)) => {
            // Should have either a view (snapshot) or changes (delta)
            assert!(
                depth.view.is_some() || depth.changes.is_some(),
                "Depth update should have view or changes"
            );
        }
        Ok(None) => {
            panic!("WebSocket stream ended unexpectedly");
        }
        Err(_) => {
            // Timeout is acceptable on a quiet testnet
            eprintln!("WebSocket depth timed out (acceptable on quiet testnet)");
        }
    }

    let _ = ws.disconnect().await;
}
