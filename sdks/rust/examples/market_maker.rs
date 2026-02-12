use o2_sdk::crypto::*;
use o2_sdk::encoding::*;
/// Market maker bot example for O2 Exchange.
///
/// Places symmetric buy and sell orders around a reference price,
/// cancelling stale orders and replacing them atomically each cycle.
use o2_sdk::*;
use serde_json::json;
use std::time::Duration;

struct MakerConfig {
    market_pair: String,
    spread_pct: f64,
    order_size: f64,
    cycle_interval: Duration,
    reference_price: f64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = MakerConfig {
        market_pair: "fFUEL/fUSDC".to_string(),
        spread_pct: 0.02,  // 2% spread
        order_size: 100.0, // base quantity
        cycle_interval: Duration::from_secs(30),
        reference_price: 0.05, // starting reference price
    };

    let mut client = O2Client::new(Network::Testnet);

    // Setup wallet and account
    let wallet = client.generate_wallet()?;
    println!("Owner: {}", to_hex_string(&wallet.b256_address));

    let account = client.setup_account(&wallet).await?;
    let trade_account_id = account.trade_account_id.unwrap();
    println!("Trade account: {trade_account_id}");

    // Wait for faucet and do second mint for more balance
    println!("Waiting for faucet cooldown...");
    tokio::time::sleep(Duration::from_secs(65)).await;
    let _ = client.setup_account(&wallet).await;

    // Create session
    let mut session = client
        .create_session(&wallet, &[&config.market_pair], 30)
        .await?;
    println!("Session created");

    let market = client.get_market(&config.market_pair).await?;

    let mut active_buy_id: Option<String> = None;
    let mut active_sell_id: Option<String> = None;

    println!("Starting market maker loop...");

    loop {
        let ref_price = config.reference_price;
        let buy_price = ref_price * (1.0 - config.spread_pct);
        let sell_price = ref_price * (1.0 + config.spread_pct);

        let scaled_buy_price = market.scale_price(buy_price);
        let scaled_sell_price = market.scale_price(sell_price);
        let scaled_quantity = market.scale_quantity(config.order_size);

        println!(
            "Cycle: buy@{} sell@{} qty={}",
            market.format_price(scaled_buy_price),
            market.format_price(scaled_sell_price),
            market.format_quantity(scaled_quantity),
        );

        // Build actions: cancel stale + settle + create new
        let contract_id = parse_hex_32(&market.contract_id)?;
        let trade_account_bytes = parse_hex_32(&session.trade_account_id)?;
        let base_asset = parse_hex_32(&market.base.asset)?;
        let quote_asset = parse_hex_32(&market.quote.asset)?;

        let mut calls: Vec<CallArg> = Vec::new();
        let mut actions_json: Vec<serde_json::Value> = Vec::new();

        // Cancel existing orders (if any)
        if let Some(ref oid) = active_buy_id {
            let oid_bytes = parse_hex_32(oid)?;
            calls.push(cancel_order_to_call(&contract_id, &oid_bytes));
            actions_json.push(json!({"CancelOrder": {"order_id": oid}}));
        }

        if let Some(ref oid) = active_sell_id {
            let oid_bytes = parse_hex_32(oid)?;
            calls.push(cancel_order_to_call(&contract_id, &oid_bytes));
            actions_json.push(json!({"CancelOrder": {"order_id": oid}}));
        }

        // Settle balance
        calls.push(settle_balance_to_call(
            &contract_id,
            1,
            &trade_account_bytes,
        ));
        actions_json.push(json!({
            "SettleBalance": {
                "to": {"ContractId": session.trade_account_id}
            }
        }));

        // Create buy order
        calls.push(create_order_to_call(
            &contract_id,
            "Buy",
            scaled_buy_price,
            scaled_quantity,
            &OrderTypeEncoding::Spot,
            market.base.decimals,
            &base_asset,
            &quote_asset,
        ));
        actions_json.push(json!({
            "CreateOrder": {
                "side": "Buy",
                "price": scaled_buy_price.to_string(),
                "quantity": scaled_quantity.to_string(),
                "order_type": "Spot"
            }
        }));

        // Create sell order
        calls.push(create_order_to_call(
            &contract_id,
            "Sell",
            scaled_sell_price,
            scaled_quantity,
            &OrderTypeEncoding::Spot,
            market.base.decimals,
            &base_asset,
            &quote_asset,
        ));
        actions_json.push(json!({
            "CreateOrder": {
                "side": "Sell",
                "price": scaled_sell_price.to_string(),
                "quantity": scaled_quantity.to_string(),
                "order_type": "Spot"
            }
        }));

        // Check action count (max 5)
        if calls.len() > 5 {
            eprintln!("Too many actions ({}), trimming cancels", calls.len());
            // Remove cancels to fit within limit
            while calls.len() > 5 {
                calls.remove(0);
                actions_json.remove(0);
            }
        }

        // Sign and submit
        let market_actions = vec![MarketActions {
            market_id: market.market_id.clone(),
            actions: actions_json,
        }];

        let result = client
            .batch_actions_raw(&mut session, market_actions, calls, true)
            .await;

        match result {
            Ok(resp) => {
                if resp.is_success() {
                    println!("  tx: {}", resp.tx_id.as_deref().unwrap_or("?"));

                    // Track new order IDs
                    active_buy_id = None;
                    active_sell_id = None;
                    if let Some(orders) = &resp.orders {
                        for order in orders {
                            match order.side.as_deref() {
                                Some("Buy") => active_buy_id = order.order_id.clone(),
                                Some("Sell") => active_sell_id = order.order_id.clone(),
                                _ => {}
                            }
                        }
                    }
                    println!(
                        "  buy: {} sell: {}",
                        active_buy_id.as_deref().unwrap_or("none"),
                        active_sell_id.as_deref().unwrap_or("none")
                    );
                } else {
                    eprintln!("  Failed: {:?}", resp.message);
                    // Re-fetch nonce on failure
                    let _ = client.refresh_nonce(&mut session).await;
                    active_buy_id = None;
                    active_sell_id = None;
                }
            }
            Err(e) => {
                eprintln!("  Error: {e}");
                let _ = client.refresh_nonce(&mut session).await;
                active_buy_id = None;
                active_sell_id = None;
            }
        }

        tokio::time::sleep(config.cycle_interval).await;
    }
}
