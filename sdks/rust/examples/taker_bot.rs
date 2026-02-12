use o2_sdk::crypto::*;
/// Taker bot example: monitors depth via WebSocket and executes when price
/// crosses a configurable threshold.
use o2_sdk::*;
use tokio_stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let buy_below_price: UnsignedDecimal = "0.04".parse()?;
    let max_quantity: UnsignedDecimal = "50".parse()?;

    let mut client = O2Client::new(Network::Testnet);

    // Setup
    let wallet = client.generate_wallet()?;
    println!("Owner: {}", to_hex_string(&wallet.b256_address));

    let account = client.setup_account(&wallet).await?;
    let trade_account_id = account.trade_account_id.unwrap();
    println!("Trade account: {trade_account_id}");

    // Wait for faucet cooldown and mint again
    println!("Waiting for faucet cooldown...");
    tokio::time::sleep(std::time::Duration::from_secs(65)).await;
    let _ = client.setup_account(&wallet).await;

    let markets = client.get_markets().await?;
    let market_pair = markets[0].symbol_pair();
    let market = &markets[0];
    println!("Monitoring: {market_pair}");

    let mut session = client.create_session(&wallet, &[&market_pair], 30).await?;
    println!("Session created");

    // Connect to WebSocket for real-time depth
    let ws = O2WebSocket::connect(&client.config.ws_url).await?;
    let mut depth_stream = ws.stream_depth(market.market_id.as_str(), "10").await?;

    println!("Listening for depth updates (buy when ask <= {buy_below_price})...");

    while let Some(update) = depth_stream.next().await {
        // Get best ask from snapshot or update
        let sells = update
            .view
            .as_ref()
            .and_then(|v| v.sells.as_ref())
            .or_else(|| update.changes.as_ref().and_then(|c| c.sells.as_ref()));

        if let Some(sell_levels) = sells {
            if let Some(best_ask) = sell_levels.first() {
                let ask_price: u64 = best_ask.price.parse().unwrap_or(0);
                if ask_price == 0 {
                    continue;
                }
                let ask_human = market.format_price(ask_price);

                if ask_human <= buy_below_price {
                    println!("Target price hit! Best ask: {ask_human}");

                    // Use a price slightly above the ask (0.5% slippage)
                    let slippage_factor: UnsignedDecimal = "1.005".parse()?;
                    let taker_price = ask_human * slippage_factor;

                    let result = client
                        .create_order(
                            &mut session,
                            &market_pair,
                            Side::Buy,
                            taker_price,
                            max_quantity,
                            OrderType::Spot,
                            true,
                            true,
                        )
                        .await;

                    match result {
                        Ok(resp) if resp.is_success() => {
                            println!("Order placed! tx: {}", resp.tx_id.as_deref().unwrap_or("?"));
                        }
                        Ok(resp) => {
                            eprintln!("Order failed: {:?}", resp.message);
                        }
                        Err(e) => {
                            eprintln!("Order error: {e}");
                            let _ = client.refresh_nonce(&mut session).await;
                        }
                    }
                } else {
                    println!("Best ask: {ask_human} (waiting for <= {buy_below_price})");
                }
            }
        }
    }

    Ok(())
}
