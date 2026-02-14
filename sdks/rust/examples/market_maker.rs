/// Market maker bot example for O2 Exchange.
///
/// Places symmetric buy and sell orders around a reference price,
/// cancelling stale orders and replacing them atomically each cycle.
use o2_sdk::crypto::*;
use o2_sdk::*;
use std::time::Duration;

struct MakerConfig {
    market_pair: MarketSymbol,
    spread_pct: UnsignedDecimal,
    order_size: UnsignedDecimal,
    cycle_interval: Duration,
    reference_price: UnsignedDecimal,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = MakerConfig {
        market_pair: MarketSymbol::from("fFUEL/fUSDC"),
        spread_pct: "0.02".parse()?, // 2% spread
        order_size: "100".parse()?,  // base quantity
        cycle_interval: Duration::from_secs(30),
        reference_price: "0.05".parse()?, // starting reference price
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

    let mut active_buy_id: Option<OrderId> = None;
    let mut active_sell_id: Option<OrderId> = None;

    println!("Starting market maker loop...");

    loop {
        let buy_price = config.reference_price * UnsignedDecimal::ONE.try_sub(config.spread_pct)?;
        let sell_price = config.reference_price * (UnsignedDecimal::ONE + config.spread_pct);

        let scaled_buy_price = market.scale_price(&buy_price)?;
        let scaled_sell_price = market.scale_price(&sell_price)?;
        let scaled_quantity = market.scale_quantity(&config.order_size)?;

        println!(
            "Cycle: buy@{} sell@{} qty={}",
            market.format_price(scaled_buy_price),
            market.format_price(scaled_sell_price),
            market.format_quantity(scaled_quantity),
        );

        // Build actions: cancel stale + settle + create new
        let mut actions: Vec<Action> = Vec::new();

        if let Some(ref oid) = active_buy_id {
            actions.push(Action::CancelOrder {
                order_id: oid.clone(),
            });
        }
        if let Some(ref oid) = active_sell_id {
            actions.push(Action::CancelOrder {
                order_id: oid.clone(),
            });
        }

        actions.push(Action::SettleBalance);

        actions.push(Action::CreateOrder {
            side: Side::Buy,
            price: buy_price,
            quantity: config.order_size,
            order_type: OrderType::Spot,
        });

        actions.push(Action::CreateOrder {
            side: Side::Sell,
            price: sell_price,
            quantity: config.order_size,
            order_type: OrderType::Spot,
        });

        // Max 5 actions per batch — trim oldest (cancels) if needed
        while actions.len() > 5 {
            actions.remove(0);
        }

        let market_pair = market.symbol_pair();
        let result = client
            .batch_actions(&mut session, &market_pair, actions, true)
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
                            match order.side {
                                Side::Buy => active_buy_id = Some(order.order_id.clone()),
                                Side::Sell => active_sell_id = Some(order.order_id.clone()),
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
