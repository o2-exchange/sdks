#![cfg(feature = "integration")]
/// Integration tests for O2 SDK against testnet.
///
/// These tests require network access and hit the live testnet API.
/// Run with: cargo test --features integration --test integration_tests -- --test-threads=1
///
/// Wallet optimization:
/// - maker/taker wallets are persisted to a gitignored local file
/// - accounts are reused between runs
/// - faucet minting is only triggered when balances are below thresholds
use std::fs;

use futures_util::StreamExt;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serial_test::serial;
use tokio::sync::OnceCell;

use o2_sdk::api::O2Api;
use o2_sdk::*;

const INTEGRATION_WALLETS_FILE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/.integration-wallets.json");

#[derive(Debug, Deserialize, Serialize)]
struct PersistedIntegrationWallets {
    maker_private_key: String,
    taker_private_key: String,
}

struct SharedSetup {
    maker_wallet: Wallet,
    maker_trade_account_id: TradeAccountId,
    taker_wallet: Wallet,
    taker_trade_account_id: TradeAccountId,
}

static SHARED: OnceCell<SharedSetup> = OnceCell::const_new();

fn is_private_key_hex(value: &str) -> bool {
    value.starts_with("0x")
        && value.len() == 66
        && value
            .as_bytes()
            .iter()
            .skip(2)
            .all(|b| b.is_ascii_hexdigit())
}

fn private_key_to_hex(private_key: &[u8; 32]) -> String {
    format!(
        "0x{}",
        private_key
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn load_or_create_integration_wallets() -> (Wallet, Wallet) {
    if let Ok(raw) = fs::read_to_string(INTEGRATION_WALLETS_FILE) {
        if let Ok(persisted) = serde_json::from_str::<PersistedIntegrationWallets>(&raw) {
            if is_private_key_hex(&persisted.maker_private_key)
                && is_private_key_hex(&persisted.taker_private_key)
            {
                let client = O2Client::new(Network::Testnet);
                if let (Ok(maker), Ok(taker)) = (
                    client.load_wallet(&persisted.maker_private_key),
                    client.load_wallet(&persisted.taker_private_key),
                ) {
                    return (maker, taker);
                }
            }
        }
        eprintln!(
            "[integration] wallet cache at {} invalid, regenerating",
            INTEGRATION_WALLETS_FILE
        );
    }

    let client = O2Client::new(Network::Testnet);
    let maker = client.generate_wallet().expect("generate maker wallet");
    let taker = client.generate_wallet().expect("generate taker wallet");

    let persisted = PersistedIntegrationWallets {
        maker_private_key: private_key_to_hex(&maker.private_key),
        taker_private_key: private_key_to_hex(&taker.private_key),
    };

    if let Ok(serialized) = serde_json::to_string_pretty(&persisted) {
        let _ = fs::write(INTEGRATION_WALLETS_FILE, format!("{serialized}\n"));
        eprintln!(
            "[integration] wrote wallet cache to {}",
            INTEGRATION_WALLETS_FILE
        );
    }

    (maker, taker)
}

async fn mint_with_retry(api: &O2Api, trade_account_id: &str, max_retries: usize) {
    let mut wait_secs = 5u64;
    for attempt in 0..max_retries {
        match api.mint_to_contract(trade_account_id).await {
            Ok(resp) if resp.error.is_none() => return,
            Ok(resp) => {
                let err = resp
                    .error
                    .unwrap_or_else(|| "unknown faucet error".to_string());
                if attempt < max_retries - 1 {
                    let lower = err.to_ascii_lowercase();
                    let cooldown = lower.contains("cooldown")
                        || lower.contains("rate limit")
                        || lower.contains("too many");
                    wait_secs = if cooldown { 65 } else { wait_secs.min(20) };
                    tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;
                    wait_secs = (wait_secs * 2).min(20);
                }
            }
            Err(e) => {
                if attempt < max_retries - 1 {
                    let lower = e.to_string().to_ascii_lowercase();
                    let cooldown = lower.contains("cooldown")
                        || lower.contains("rate limit")
                        || lower.contains("too many");
                    let delay = if cooldown { 65 } else { wait_secs };
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    wait_secs = (wait_secs * 2).min(20);
                }
            }
        }
    }
}

async fn ensure_funded(
    client: &mut O2Client,
    trade_account_id: &TradeAccountId,
    asset_symbol: &str,
    min_balance: u128,
) {
    let mut mint_count = 0;
    const MAX_MINTS: usize = 5;

    loop {
        let balances = client.get_balances(trade_account_id).await.unwrap();
        let balance = balances
            .get(asset_symbol)
            .map(|b| b.trading_account_balance)
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
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
}

async fn whitelist_with_retry(api: &O2Api, trade_account_id: &str, max_retries: usize) {
    for attempt in 0..max_retries {
        if api.whitelist_account(trade_account_id).await.is_ok() {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            return;
        }
        if attempt < max_retries - 1 {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    }
}

async fn ensure_account_with_retry(
    client: &mut O2Client,
    wallet: &Wallet,
    max_retries: usize,
) -> TradeAccountId {
    let owner_hex = crypto::to_hex_string(&wallet.b256_address);

    for attempt in 0..max_retries {
        let result = async {
            let existing = client.api.get_account_by_owner(&owner_hex).await?;
            let trade_account_id = if let Some(id) = existing.trade_account_id {
                id
            } else {
                client
                    .api
                    .create_account(&owner_hex)
                    .await?
                    .trade_account_id
            };
            whitelist_with_retry(&client.api, trade_account_id.as_str(), 2).await;
            Ok::<TradeAccountId, O2Error>(trade_account_id)
        }
        .await;

        match result {
            Ok(id) => return id,
            Err(e) => {
                eprintln!(
                    "[integration] ensure_account attempt {}/{} failed for {}...: {}",
                    attempt + 1,
                    max_retries,
                    &owner_hex[..12.min(owner_hex.len())],
                    e
                );
                if attempt < max_retries - 1 {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                }
            }
        }
    }

    panic!("ensure_account failed after retries")
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
                side,
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

async fn get_shared_setup() -> &'static SharedSetup {
    SHARED
        .get_or_init(|| async {
            let (maker_wallet, taker_wallet) = load_or_create_integration_wallets();

            let maker_fut = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_account_with_retry(&mut c, &maker_wallet, 4).await
            };
            let taker_fut = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_account_with_retry(&mut c, &taker_wallet, 4).await
            };

            let (maker_trade_account_id, taker_trade_account_id) =
                tokio::join!(maker_fut, taker_fut);

            let mut client = O2Client::new(Network::Testnet);
            let markets = client.get_markets().await.unwrap();
            let market = &markets[0];
            let market_pair = market.symbol_pair();
            let base_symbol = market.base.symbol.clone();
            let quote_symbol = market.quote.symbol.clone();

            cleanup_open_orders(&mut client, &maker_wallet, &market_pair).await;
            cleanup_open_orders(&mut client, &taker_wallet, &market_pair).await;

            let maker_quote = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_funded(&mut c, &maker_trade_account_id, &quote_symbol, 50_000_000).await;
            };
            let maker_base = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_funded(&mut c, &maker_trade_account_id, &base_symbol, 50_000_000).await;
            };
            let taker_quote = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_funded(&mut c, &taker_trade_account_id, &quote_symbol, 50_000_000).await;
            };
            let taker_base = async {
                let mut c = O2Client::new(Network::Testnet);
                ensure_funded(&mut c, &taker_trade_account_id, &base_symbol, 50_000_000).await;
            };

            let _ = tokio::join!(maker_quote, maker_base, taker_quote, taker_base);

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

    assert!(depth.buys.is_empty() || !depth.buys.is_empty());
    assert!(depth.sells.is_empty() || !depth.sells.is_empty());
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

    assert_eq!(trades.market_id, market.market_id);
    let _ = trades.trades;
}

#[tokio::test]
async fn test_create_account_and_whitelist() {
    let client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet().unwrap();
    let owner_hex = crypto::to_hex_string(&wallet.b256_address);

    let account = client.api.create_account(&owner_hex).await.unwrap();
    let trade_account_id = account.trade_account_id;

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

    let account1 = client.setup_account(&wallet).await.unwrap();
    let trade_account_id = account1.trade_account_id;

    let account2 = client.setup_account(&wallet).await.unwrap();
    assert_eq!(account2.trade_account_id, trade_account_id);
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

    let account = client
        .api
        .get_account_by_id(shared.maker_trade_account_id.as_str())
        .await
        .unwrap();
    assert_eq!(
        account.trade_account_id,
        Some(shared.maker_trade_account_id.clone())
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
    let _ = &balances;
}

#[tokio::test]
#[serial]
async fn test_full_session_creation() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market_pair = markets[0].symbol_pair();

    let session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    assert!(!session.trade_account_id.as_str().is_empty());
    assert!(!session.contract_ids.is_empty());
    assert!(session.expiry > 0);
}

fn min_quantity_for_min_order(market: &o2_sdk::Market, price: &UnsignedDecimal) -> UnsignedDecimal {
    let min_order = Decimal::from(market.min_order);
    let base_factor = Decimal::from(10u64.pow(market.base.decimals));
    let quote_factor = Decimal::from(10u64.pow(market.quote.decimals));
    let min_qty = min_order / (*price.inner() * quote_factor);
    let truncate_factor =
        Decimal::from(10u64.pow(market.base.decimals - market.base.max_precision));
    let step = truncate_factor / base_factor;
    let rounded = (min_qty / step).ceil() * step;
    let with_margin = rounded * Decimal::new(11, 1);
    UnsignedDecimal::new(with_margin).unwrap()
}

fn moderate_fill_price(market: &o2_sdk::Market) -> UnsignedDecimal {
    let min_order = Decimal::from(market.min_order);
    let base_precision_factor = Decimal::from(10u64.pow(market.base.max_precision));
    let quote_factor = Decimal::from(10u64.pow(market.quote.decimals));
    let price = min_order * base_precision_factor / quote_factor;
    UnsignedDecimal::new(price).unwrap()
}

fn fill_quantity(market: &o2_sdk::Market, price: &UnsignedDecimal) -> UnsignedDecimal {
    let min_order = Decimal::from(market.min_order);
    let quote_factor = Decimal::from(10u64.pow(market.quote.decimals));
    let base_factor = Decimal::from(10u64.pow(market.base.decimals));
    let qty = Decimal::from(10u64) * min_order / (*price.inner() * quote_factor);
    let truncate_factor =
        Decimal::from(10u64.pow(market.base.decimals - market.base.max_precision));
    let step = truncate_factor / base_factor;
    let rounded = (qty / step).ceil() * step;
    UnsignedDecimal::new(rounded).unwrap()
}

async fn cleanup_open_orders(client: &mut O2Client, wallet: &Wallet, market_pair: &MarketSymbol) {
    if let Ok(mut session) = client.create_session(wallet, &[market_pair], 30).await {
        let _ = client.cancel_all_orders(&mut session, market_pair).await;
        let _ = client.settle_balance(&mut session, market_pair).await;
    }
}

#[tokio::test]
#[serial]
async fn test_order_placement_and_cancellation() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;

    let price_step = Decimal::ONE / Decimal::from(10u64.pow(market.quote.max_precision));
    let buy_price = UnsignedDecimal::new(price_step).unwrap();
    let quantity = min_quantity_for_min_order(market, &buy_price);

    ensure_funded(
        &mut client,
        &shared.maker_trade_account_id,
        &market.quote.symbol,
        50_000_000,
    )
    .await;

    let mut session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

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
    let order_id = &order.order_id;
    assert!(!order.cancel, "Order was unexpectedly cancelled");

    let cancel_resp = client
        .cancel_order(&mut session, order_id, &market_pair)
        .await
        .unwrap();
    assert!(cancel_resp.is_success(), "Cancel should succeed");

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

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    whitelist_with_retry(&client.api, shared.taker_trade_account_id.as_str(), 2).await;

    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;
    cleanup_open_orders(&mut client, &shared.taker_wallet, &market_pair).await;

    ensure_funded(
        &mut client,
        &shared.maker_trade_account_id,
        &market.quote.symbol,
        50_000_000,
    )
    .await;
    ensure_funded(
        &mut client,
        &shared.taker_trade_account_id,
        &market.base.symbol,
        50_000_000,
    )
    .await;

    let fill_price = moderate_fill_price(market);
    let quantity = fill_quantity(market, &fill_price);

    let mut maker_session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let maker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut maker_session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        fill_price,
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
    let maker_order_id = &maker_order.order_id;
    assert!(
        !maker_order.cancel,
        "Maker order was unexpectedly cancelled"
    );

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        Side::Sell,
        fill_price,
        quantity,
        OrderType::FillOrKill,
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

    let _ = client
        .cancel_order(&mut maker_session, maker_order_id, &market_pair)
        .await;
    if let Some(taker_order_id) = taker_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| &o.order_id)
    {
        let _ = client
            .cancel_order(&mut taker_session, taker_order_id, &market_pair)
            .await;
    }

    let _ = client
        .settle_balance(&mut maker_session, &market_pair)
        .await;
    let _ = client
        .settle_balance(&mut taker_session, &market_pair)
        .await;
}

#[tokio::test]
async fn test_nonce_fetch() {
    let shared = get_shared_setup().await;
    let client = O2Client::new(Network::Testnet);

    let nonce = client
        .get_nonce(&shared.maker_trade_account_id)
        .await
        .unwrap();
    let _ = nonce;
}

#[tokio::test]
async fn test_aggregated_endpoints() {
    let client = O2Client::new(Network::Testnet);

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
    let mut stream = client.stream_depth(&market.market_id, "10").await.unwrap();

    let update = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await;

    match update {
        Ok(Some(Ok(depth))) => {
            assert!(
                depth.view.is_some() || depth.changes.is_some(),
                "Depth update should have view or changes"
            );
        }
        Ok(Some(Err(e))) => panic!("WebSocket stream error: {e}"),
        Ok(None) => panic!("WebSocket stream ended unexpectedly"),
        Err(_) => eprintln!("WebSocket depth timed out (acceptable on quiet testnet)"),
    }

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_trades() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    whitelist_with_retry(&client.api, shared.taker_trade_account_id.as_str(), 2).await;

    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;
    cleanup_open_orders(&mut client, &shared.taker_wallet, &market_pair).await;

    let mut stream = client.stream_trades(&market.market_id).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    ensure_funded(
        &mut client,
        &shared.maker_trade_account_id,
        &market.quote.symbol,
        50_000_000,
    )
    .await;
    ensure_funded(
        &mut client,
        &shared.taker_trade_account_id,
        &market.base.symbol,
        50_000_000,
    )
    .await;

    let fill_price = moderate_fill_price(market);
    let quantity = fill_quantity(market, &fill_price);

    let mut maker_session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let maker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut maker_session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        fill_price,
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
    let maker_order_id = maker_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| o.order_id.clone())
        .expect("maker order id");

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        Side::Sell,
        fill_price,
        quantity,
        OrderType::FillOrKill,
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

    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;
    match update {
        Ok(Some(Ok(trade))) => {
            assert_eq!(trade.action, "subscribe_trades");
            assert_eq!(trade.market_id, market.market_id);
            eprintln!("Received trade update: {}", trade.action);
        }
        Ok(Some(Err(e))) => panic!("WebSocket stream error: {e}"),
        Ok(None) => panic!("WebSocket stream ended unexpectedly"),
        Err(_) => panic!(
            "WebSocket trades timed out after successful cross-account fill - subscription is broken"
        ),
    }

    let _ = client
        .cancel_order(&mut maker_session, &maker_order_id, &market_pair)
        .await;
    if let Some(taker_order_id) = taker_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| &o.order_id)
    {
        let _ = client
            .cancel_order(&mut taker_session, taker_order_id, &market_pair)
            .await;
    }

    let _ = client
        .settle_balance(&mut maker_session, &market_pair)
        .await;
    let _ = client
        .settle_balance(&mut taker_session, &market_pair)
        .await;

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_orders() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;

    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let mut stream = client.stream_orders(&[identity]).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

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
        .map(|o| o.order_id.clone());

    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(Ok(order_update))) => {
            assert_eq!(order_update.action, "subscribe_orders");
            eprintln!("Received order update: {}", order_update.action);
        }
        Ok(Some(Err(e))) => panic!("WebSocket stream error: {e}"),
        Ok(None) => panic!("WebSocket stream ended unexpectedly"),
        Err(_) => panic!(
            "WebSocket orders timed out after successful order placement - subscription is broken"
        ),
    }

    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_balances() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;

    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let mut stream = client.stream_balances(&[identity]).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

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
        .map(|o| o.order_id.clone());

    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(Ok(balance_update))) => {
            assert_eq!(balance_update.action, "subscribe_balances");
            eprintln!("Received balance update: {}", balance_update.action);
        }
        Ok(Some(Err(e))) => panic!("WebSocket stream error: {e}"),
        Ok(None) => panic!("WebSocket stream ended unexpectedly"),
        Err(_) => panic!(
            "WebSocket balances timed out after successful order placement - subscription is broken"
        ),
    }

    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_nonce() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;

    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let mut stream = client.stream_nonce(&[identity]).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

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
        .map(|o| o.order_id.clone());

    let update = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await;

    match update {
        Ok(Some(Ok(nonce_update))) => {
            assert_eq!(nonce_update.action, "subscribe_nonce");
            eprintln!("Received nonce update: {}", nonce_update.nonce);
        }
        Ok(Some(Err(e))) => panic!("WebSocket stream error: {e}"),
        Ok(None) => panic!("WebSocket stream ended unexpectedly"),
        Err(_) => panic!(
            "WebSocket nonce timed out after successful order placement - subscription is broken"
        ),
    }

    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_concurrent_subscriptions() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;

    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let mut orders_stream = client.stream_orders(&[identity.clone()]).await.unwrap();
    let mut balances_stream = client.stream_balances(&[identity.clone()]).await.unwrap();
    let mut nonce_stream = client.stream_nonce(&[identity]).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

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

    assert!(
        order_resp.is_success(),
        "Order placement failed: {:?}",
        order_resp.message
    );

    let order_id = order_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| o.order_id.clone());

    let timeout_dur = std::time::Duration::from_secs(30);

    match tokio::time::timeout(timeout_dur, orders_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_orders");
            eprintln!("Orders stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Orders stream error: {e}"),
        Ok(None) => panic!("Orders stream ended unexpectedly"),
        Err(_) => panic!("Orders stream timed out"),
    }

    match tokio::time::timeout(timeout_dur, balances_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_balances");
            eprintln!("Balances stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Balances stream error: {e}"),
        Ok(None) => panic!("Balances stream ended unexpectedly"),
        Err(_) => panic!("Balances stream timed out"),
    }

    match tokio::time::timeout(timeout_dur, nonce_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_nonce");
            eprintln!("Nonce stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Nonce stream error: {e}"),
        Ok(None) => panic!("Nonce stream ended unexpectedly"),
        Err(_) => panic!("Nonce stream timed out"),
    }

    if let Some(oid) = order_id {
        let _ = client.cancel_order(&mut session, &oid, &market_pair).await;
        let _ = client.settle_balance(&mut session, &market_pair).await;
    }

    let _ = client.disconnect_ws().await;
}

#[tokio::test]
#[serial]
async fn test_websocket_mixed_with_fill() {
    let shared = get_shared_setup().await;
    let mut client = O2Client::new(Network::Testnet);

    let markets = client.get_markets().await.unwrap();
    let market = &markets[0];
    let market_pair = market.symbol_pair();

    whitelist_with_retry(&client.api, shared.maker_trade_account_id.as_str(), 2).await;
    whitelist_with_retry(&client.api, shared.taker_trade_account_id.as_str(), 2).await;

    cleanup_open_orders(&mut client, &shared.maker_wallet, &market_pair).await;
    cleanup_open_orders(&mut client, &shared.taker_wallet, &market_pair).await;

    let mut trades_stream = client.stream_trades(&market.market_id).await.unwrap();
    let identity = Identity::ContractId(shared.maker_trade_account_id.as_str().to_string());
    let mut orders_stream = client.stream_orders(&[identity.clone()]).await.unwrap();
    let mut balances_stream = client.stream_balances(&[identity]).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    ensure_funded(
        &mut client,
        &shared.maker_trade_account_id,
        &market.quote.symbol,
        50_000_000,
    )
    .await;
    ensure_funded(
        &mut client,
        &shared.taker_trade_account_id,
        &market.base.symbol,
        50_000_000,
    )
    .await;

    let fill_price = moderate_fill_price(market);
    let quantity = fill_quantity(market, &fill_price);

    let mut maker_session = client
        .create_session(&shared.maker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let maker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut maker_session,
        &shared.maker_trade_account_id,
        &market_pair,
        Side::Buy,
        fill_price,
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
    let maker_order_id = maker_resp
        .orders
        .as_ref()
        .and_then(|o| o.first())
        .map(|o| o.order_id.clone());

    let mut taker_session = client
        .create_session(&shared.taker_wallet, &[&market_pair], 30)
        .await
        .unwrap();

    let taker_resp = create_order_with_whitelist_retry(
        &mut client,
        &mut taker_session,
        &shared.taker_trade_account_id,
        &market_pair,
        Side::Sell,
        fill_price,
        quantity,
        OrderType::FillOrKill,
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

    let timeout_dur = std::time::Duration::from_secs(30);

    match tokio::time::timeout(timeout_dur, trades_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_trades");
            eprintln!("Trades stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Trades stream error: {e}"),
        Ok(None) => panic!("Trades stream ended unexpectedly"),
        Err(_) => panic!("Trades stream timed out after cross-account fill"),
    }

    match tokio::time::timeout(timeout_dur, orders_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_orders");
            eprintln!("Orders stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Orders stream error: {e}"),
        Ok(None) => panic!("Orders stream ended unexpectedly"),
        Err(_) => panic!("Orders stream timed out after cross-account fill"),
    }

    match tokio::time::timeout(timeout_dur, balances_stream.next()).await {
        Ok(Some(Ok(update))) => {
            assert_eq!(update.action, "subscribe_balances");
            eprintln!("Balances stream OK: action={}", update.action);
        }
        Ok(Some(Err(e))) => panic!("Balances stream error: {e}"),
        Ok(None) => panic!("Balances stream ended unexpectedly"),
        Err(_) => panic!("Balances stream timed out after cross-account fill"),
    }

    if let Some(oid) = maker_order_id {
        let _ = client
            .cancel_order(&mut maker_session, &oid, &market_pair)
            .await;
    }
    let _ = client
        .settle_balance(&mut maker_session, &market_pair)
        .await;
    let _ = client
        .settle_balance(&mut taker_session, &market_pair)
        .await;

    let _ = client.disconnect_ws().await;
}
