#![cfg(feature = "integration")]
/// Integration tests for O2 SDK against testnet.
///
/// These tests require network access and hit the live testnet API.
/// Run with: cargo test --features integration --test integration_tests -- --test-threads=1
use futures_util::StreamExt;
use rust_decimal::Decimal;
use serial_test::serial;
use tokio::sync::OnceCell;

use o2_sdk::api::O2Api;
use o2_sdk::*;

struct SharedSetup {
    maker_wallet: Wallet,
    maker_trade_account_id: TradeAccountId,
    taker_wallet: Wallet,
    taker_trade_account_id: TradeAccountId,
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

async fn ensure_funded(
    client: &mut O2Client,
    trade_account_id: &TradeAccountId,
    asset_symbol: &str,
    min_balance: u64,
) {
    let mut balance: u64;
    let mut mint_count = 0;
    const MAX_MINTS: usize = 5;

    loop {
        let balances = client.get_balances(trade_account_id).await.unwrap();
        balance = balances
            .get(asset_symbol)
            .and_then(|b| b.trading_account_balance.as_deref())
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);

        if balance >= min_balance {
            if mint_count > 0 {
                eprintln!(
                    "Balance for {} is now {} (needed {})",
                    asset_symbol, balance, min_balance
                );
            }
            break;
        }

        if mint_count >= MAX_MINTS {
            eprintln!(
                "Warning: Balance for {} is {} after {} mints (need {})",
                asset_symbol, balance, mint_count, min_balance
            );
            break;
        }

        eprintln!(
            "Balance for {} is {} (need {}), minting... (attempt {}/{})",
            asset_symbol,
            balance,
            min_balance,
            mint_count + 1,
            MAX_MINTS
        );

        mint_with_retry(&client.api, trade_account_id.as_str(), 3).await;
        mint_count += 1;

        // Allow time for on-chain balance to update after mint
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
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
#[allow(clippy::too_many_arguments)]
async fn create_order_with_whitelist_retry(
    client: &mut O2Client,
    session: &mut Session,
    trade_account_id: &TradeAccountId,
    market_pair: &MarketSymbol,
    side: Side,
    price: UnsignedDecimal,
    quantity: UnsignedDecimal,
    order_type: OrderType,
    settle_first: bool,
    collect_orders: bool,
    max_retries: usize,
) -> Result<o2_sdk::models::SessionActionsResponse, o2_sdk::O2Error> {
    for attempt in 0..max_retries {
        match client
            .create_order(
                session,
                market_pair,
                side.clone(),
                price,
                quantity,
                order_type.clone(),
                settle_first,
                collect_orders,
            )
            .await
        {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                let is_whitelist_err = match &e {
                    o2_sdk::O2Error::OnChainRevert { reason, .. } => {
                        reason.contains("TraderNotWhiteListed")
                    }
                    other => format!("{other}").contains("TraderNotWhiteListed"),
                };
                if is_whitelist_err && attempt < max_retries - 1 {
                    whitelist_with_retry(&client.api, trade_account_id.as_str(), 2).await;
                    // Additional backoff on top of whitelist propagation delay
                    tokio::time::sleep(std::time::Duration::from_secs(5 * (attempt as u64 + 1)))
                        .await;
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

async fn setup_funded_account(client: &mut O2Client) -> (Wallet, TradeAccountId) {
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
    whitelist_with_retry(&client.api, trade_account_id.as_str(), 4).await;
    mint_with_retry(&client.api, trade_account_id.as_str(), 4).await;
    (wallet, trade_account_id)
}

async fn get_shared_setup() -> &'static SharedSetup {
    SHARED
        .get_or_init(|| async {
            let mut client = O2Client::new(Network::Testnet);
            let (maker_wallet, maker_trade_account_id) = setup_funded_account(&mut client).await;
            let (taker_wallet, taker_trade_account_id) = setup_funded_account(&mut client).await;
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
async fn test_fetch_markets() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    assert!(!markets.is_empty(), "Should have at least one market");

    let first = &markets[0];
    assert!(!first.market_id.as_str().is_empty());
    assert!(!first.contract_id.is_empty());
    assert!(!first.base.symbol.is_empty());
    assert!(!first.quote.symbol.is_empty());
}

#[tokio::test]
async fn test_get_depth() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];

    let depth = client
        .api
        .get_depth(market.market_id.as_str(), 10)
        .await
        .unwrap();

    // Depth should have buys and sells (may be empty on thin testnet)
    assert!(depth.buys.is_some() || depth.sells.is_some());
}

#[tokio::test]
async fn test_get_trades() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];

    let trades = client
        .api
        .get_trades(market.market_id.as_str(), "desc", 10, None, None)
        .await
        .unwrap();

    // Trades list may be empty on testnet, but should parse
    assert!(trades.trades.is_some() || trades.market_id.is_some());
}

#[tokio::test]
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
        .whitelist_account(trade_account_id.as_str())
        .await
        .unwrap();
    assert!(whitelist.success.unwrap_or(false));
}

#[tokio::test]
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
async fn test_faucet_mint() {
    let shared = get_shared_setup().await;
    let client = O2Client::new(Network::Testnet);

    // Verify the shared account exists and has a trade_account_id
    let account = client
        .api
        .get_account_by_id(shared.maker_trade_account_id.as_str())
        .await
        .unwrap();
    assert!(
        account.trade_account_id.is_some(),
        "Shared account should exist"
    );
}

#[tokio::test]
async fn test_balance_check() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let balances = client
        .get_balances(&shared.maker_trade_account_id)
        .await
        .unwrap();
    // May be empty if faucet hasn't funded yet, but should parse
    let _ = &balances;
}

#[tokio::test]
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

    assert!(!session.trade_account_id.as_str().is_empty());
    assert!(!session.contract_ids.is_empty());
    assert!(session.expiry > 0);
}

/// Calculate minimum quantity that meets min_order at the given price.
fn min_quantity_for_min_order(market: &o2_sdk::Market, price: &UnsignedDecimal) -> UnsignedDecimal {
    let min_order: Decimal = market
        .min_order
        .parse()
        .unwrap_or(Decimal::new(1_000_000, 0));
    let base_factor = Decimal::from(10u64.pow(market.base.decimals));
    let quote_factor = Decimal::from(10u64.pow(market.quote.decimals));
    let min_qty = min_order / (*price.inner() * quote_factor);
    let truncate_factor =
        Decimal::from(10u64.pow(market.base.decimals - market.base.max_precision));
    let step = truncate_factor / base_factor;
    let rounded = (min_qty / step).ceil() * step;
    let with_margin = rounded * Decimal::new(11, 1); // 1.1x margin
    UnsignedDecimal::new(with_margin).unwrap()
}

/// Calculate a safe sell price that is book-independent and balance-safe.
/// Returns a very high price that requires only a tiny base token amount,
/// ensuring the taker buy cost is always affordable with faucet funds.
fn safe_sell_price(market: &o2_sdk::Market, base_balance: u64) -> UnsignedDecimal {
    let min_order: Decimal = market
        .min_order
        .parse()
        .unwrap_or(Decimal::new(1_000_000, 0));
    let base_factor = Decimal::from(10u64.pow(market.base.decimals));
    let quote_factor = Decimal::from(10u64.pow(market.quote.decimals));

    // Pick a tiny base budget: 0.1% of balance, capped at 1000 chain units to ensure very high price
    let budget_chain = Decimal::from(base_balance) * Decimal::new(1, 3); // 0.1%
    let budget_chain = budget_chain.min(Decimal::from(1_000u64));
    let budget = budget_chain.max(Decimal::ONE) / base_factor;

    // Compute price where price * budget * quote_factor >= min_order, with 2x margin
    let price = (min_order / (budget * quote_factor)) * Decimal::from(2u64);
    UnsignedDecimal::new(price).unwrap()
}

#[tokio::test]
#[serial]
async fn test_order_placement_and_cancellation() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist before trading (handles propagation delays)
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;

    // Use the minimum price step — guaranteed below any ask on the book.
    // The buy cost is always ≈ min_order regardless of price, so this is affordable.
    let price_step = Decimal::ONE / Decimal::from(10u64.pow(market.quote.max_precision));
    let buy_price = UnsignedDecimal::new(price_step).unwrap();
    let quantity = min_quantity_for_min_order(market, &buy_price);

    // Ensure maker has quote balance — re-mint if depleted from prior test runs
    ensure_funded(&mut client, &shared.maker_trade_account_id, &market.quote.symbol, 50_000_000).await;

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
        Side::Buy,
        buy_price,
        quantity,
        OrderType::PostOnly,
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
    let orders = resp
        .orders
        .as_ref()
        .expect("Should have orders in response");
    assert!(!orders.is_empty(), "Orders list should not be empty");
    let order = &orders[0];
    let order_id = order.order_id.as_ref().expect("Order should have order_id");
    assert_ne!(order.cancel, Some(true), "Order was unexpectedly cancelled");

    // Cancel the order
    let cancel_resp = client
        .cancel_order(&mut session, order_id, &market_pair)
        .await
        .unwrap();
    assert!(cancel_resp.is_success(), "Cancel should succeed");

    // Settle balance to release locked funds
    let _ = client.settle_balance(&mut session, &market_pair).await;
}

#[tokio::test]
#[serial]
async fn test_cross_account_fill() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist both accounts before trading
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    whitelist_with_retry(&client.api, shared.taker_trade_account_id.as_str(), 2).await;

    // Ensure maker has base and taker has quote — re-mint if depleted from prior test runs
    ensure_funded(&mut client, &shared.maker_trade_account_id, &market.base.symbol, 50_000_000).await;
    ensure_funded(&mut client, &shared.taker_trade_account_id, &market.quote.symbol, 50_000_000).await;

    // Get maker's base balance to compute a safe sell price (book-independent)
    let maker_balances = client
        .get_balances(&shared.maker_trade_account_id)
        .await
        .unwrap();
    let base_balance: u64 = maker_balances
        .get(&market.base.symbol)
        .and_then(|b| b.trading_account_balance.as_deref())
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);

    // Use safe_sell_price: very high price needing trivial base tokens,
    // taker cost always affordable (~2x min_order in chain units)
    let sell_price = safe_sell_price(market, base_balance);
    let quantity = min_quantity_for_min_order(market, &sell_price);

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
        Side::Sell,
        sell_price,
        quantity,
        OrderType::PostOnly,
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
    let taker_quantity = UnsignedDecimal::new(*quantity.inner() * Decimal::from(3u64)).unwrap();

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        Side::Buy,
        sell_price,
        taker_quantity,
        OrderType::Spot,
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
    let _ = client
        .cancel_order(&mut maker_session, maker_order_id, &market_pair)
        .await;

    // Settle balances to release locked funds for both accounts
    let _ = client.settle_balance(&mut maker_session, &market_pair).await;
    let _ = client.settle_balance(&mut taker_session, &market_pair).await;
}

#[tokio::test]
async fn test_nonce_fetch() {
    let shared = get_shared_setup().await;
    let client = O2Client::new(Network::Testnet);

    let nonce = client
        .get_nonce(&shared.maker_trade_account_id)
        .await
        .unwrap();
    // u64 is always >= 0; just verify the call succeeded
    let _ = nonce;
}

#[tokio::test]
async fn test_aggregated_endpoints() {
    let client = O2Client::new(Network::Testnet);

    // Aggregated endpoints may not be available on testnet; just ensure no panics
    let _assets = client.api.get_aggregated_assets().await;
    let _summary = client.api.get_aggregated_summary().await;
    let _ticker = client.api.get_aggregated_ticker().await;
}

#[tokio::test]
async fn test_websocket_depth() {
    let mut client = O2Client::new(Network::Testnet);
    let markets = client.get_markets().await.unwrap();
    assert!(!markets.is_empty(), "Should have at least one market");

    let market = &markets[0];
    let (ws, mut stream) = client.stream_depth(&market.market_id, "10").await.unwrap();

    // Wait for one depth update with a timeout
    let update = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await;

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

#[tokio::test]
#[serial]
async fn test_websocket_trades() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist both accounts before trading
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    whitelist_with_retry(&client.api, shared.taker_trade_account_id.as_str(), 2).await;

    // Subscribe to trades WebSocket
    let (ws, mut stream) = client.stream_trades(&market.market_id).await.unwrap();

    // Allow time for subscription to be registered on server
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Ensure both accounts have funds — may be depleted from prior test runs
    ensure_funded(&mut client, &shared.maker_trade_account_id, &market.base.symbol, 50_000_000).await;
    ensure_funded(&mut client, &shared.taker_trade_account_id, &market.quote.symbol, 50_000_000).await;

    // Get maker's base balance to compute a safe sell price (book-independent)
    let maker_balances = client
        .get_balances(&shared.maker_trade_account_id)
        .await
        .unwrap();
    let base_balance: u64 = maker_balances
        .get(&market.base.symbol)
        .and_then(|b| b.trading_account_balance.as_deref())
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);

    // Use safe_sell_price: very high price needing trivial base tokens,
    // taker cost always affordable (~2x min_order in chain units)
    let sell_price = safe_sell_price(market, base_balance);
    let quantity = min_quantity_for_min_order(market, &sell_price);

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
        Side::Sell,
        sell_price,
        quantity,
        OrderType::PostOnly,
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

    // Taker: buy a small multiple of the maker quantity to limit gas usage
    let taker_quantity = UnsignedDecimal::new(*quantity.inner() * Decimal::from(3u64)).unwrap();

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        Side::Buy,
        sell_price,
        taker_quantity,
        OrderType::Spot,
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

    // Wait for trade update with timeout
    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(trade)) => {
            // Verify the TradeUpdate structure is valid
            assert!(
                trade.action.is_some() || trade.trades.is_some() || trade.market_id.is_some(),
                "Trade update should have at least one field populated"
            );
            eprintln!("Received trade update: {:?}", trade.action);
        }
        Ok(None) => {
            panic!("WebSocket stream ended unexpectedly");
        }
        Err(_) => {
            // Cross-account fill generated a trade, so a TradeUpdate MUST arrive
            panic!(
                "WebSocket trades timed out after successful cross-account fill - subscription is broken"
            );
        }
    }

    // Cleanup: cancel maker order if still open
    let _ = client
        .cancel_order(&mut maker_session, maker_order_id, &market_pair)
        .await;

    // Settle balances to release locked funds for both accounts
    let _ = client.settle_balance(&mut maker_session, &market_pair).await;
    let _ = client.settle_balance(&mut taker_session, &market_pair).await;

    let _ = ws.disconnect().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_orders() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist before trading
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;

    // Connect to WebSocket and subscribe to orders
    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let (ws, mut stream) = client.stream_orders(&[identity]).await.unwrap();

    // Allow time for subscription to be registered on server
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Create a session and place an order
    let mut session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    // Use minimum price step for PostOnly Buy
    let price_step = Decimal::ONE / Decimal::from(10u64.pow(market.quote.max_precision));
    let buy_price = UnsignedDecimal::new(price_step).unwrap();
    let quantity = min_quantity_for_min_order(market, &buy_price);

    let order_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        buy_price,
        quantity,
        OrderType::PostOnly,
        true,
        true,
        3,
    )
    .await
    .unwrap();

    let order_id = order_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .and_then(|o| o.order_id.clone());

    // Wait for order update with timeout
    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(order_update)) => {
            assert!(
                order_update.action.is_some() || order_update.orders.is_some(),
                "Order update should have action or orders"
            );
            eprintln!("Received order update: {:?}", order_update.action);
        }
        Ok(None) => {
            panic!("WebSocket stream ended unexpectedly");
        }
        Err(_) => {
            // Order placement succeeded, so an OrderUpdate MUST arrive
            panic!(
                "WebSocket orders timed out after successful order placement - subscription is broken"
            );
        }
    }

    // Cleanup: cancel the order if it exists
    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        // Settle balance to release locked funds
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = ws.disconnect().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_balances() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist before trading
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;

    // Connect to WebSocket and subscribe to balances
    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let (ws, mut stream) = client.stream_balances(&[identity]).await.unwrap();

    // Allow time for subscription to be registered on server
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Create a session and place an order (which locks balance)
    let mut session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let price_step = Decimal::ONE / Decimal::from(10u64.pow(market.quote.max_precision));
    let buy_price = UnsignedDecimal::new(price_step).unwrap();
    let quantity = min_quantity_for_min_order(market, &buy_price);

    let order_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        buy_price,
        quantity,
        OrderType::PostOnly,
        true,
        true,
        3,
    )
    .await
    .unwrap();

    let order_id = order_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .and_then(|o| o.order_id.clone());

    // Wait for balance update with timeout
    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(balance_update)) => {
            assert!(
                balance_update.action.is_some() || balance_update.balance.is_some(),
                "Balance update should have action or balance"
            );
            eprintln!("Received balance update: {:?}", balance_update.action);
        }
        Ok(None) => {
            panic!("WebSocket stream ended unexpectedly");
        }
        Err(_) => {
            // Order placement locks balance, so a BalanceUpdate MUST arrive
            panic!(
                "WebSocket balances timed out after successful order placement - subscription is broken"
            );
        }
    }

    // Cleanup
    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        // Settle balance to release locked funds
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = ws.disconnect().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_nonce() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    // Re-whitelist before trading
    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;

    // Connect to WebSocket and subscribe to nonce
    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let (ws, mut stream) = client.stream_nonce(&[identity]).await.unwrap();

    // Allow time for subscription to be registered on server
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Create a session and place an order (which bumps nonce)
    let mut session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let price_step = Decimal::ONE / Decimal::from(10u64.pow(market.quote.max_precision));
    let buy_price = UnsignedDecimal::new(price_step).unwrap();
    let quantity = min_quantity_for_min_order(market, &buy_price);

    let order_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        buy_price,
        quantity,
        OrderType::PostOnly,
        true,
        true,
        3,
    )
    .await
    .unwrap();

    let order_id = order_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .and_then(|o| o.order_id.clone());

    // Wait for nonce update with timeout
    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(nonce_update)) => {
            assert!(
                nonce_update.action.is_some() || nonce_update.nonce.is_some(),
                "Nonce update should have action or nonce"
            );
            eprintln!("Received nonce update: {:?}", nonce_update.nonce);
        }
        Ok(None) => {
            panic!("WebSocket stream ended unexpectedly");
        }
        Err(_) => {
            // Order placement bumps nonce, so a NonceUpdate MUST arrive
            panic!(
                "WebSocket nonce timed out after successful order placement - subscription is broken"
            );
        }
    }

    // Cleanup
    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        // Settle balance to release locked funds
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = ws.disconnect().await;
}
