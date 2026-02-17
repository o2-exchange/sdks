/// Quickstart example: minimal end-to-end O2 Exchange flow.
///
/// Demonstrates: generate wallet, setup account, create session, place order,
/// check order status, cancel order.
use o2_sdk::{crypto, Network, O2Client, OrderType, Side};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = O2Client::new(Network::Testnet);

    // 1. Generate a wallet
    let wallet = client.generate_wallet()?;
    println!(
        "Owner address: {}",
        crypto::to_hex_string(&wallet.b256_address)
    );

    // 2. Setup account (creates account, mints via faucet, whitelists)
    println!("Setting up account...");
    let account = client.setup_account(&wallet).await?;
    let trade_account_id = account.trade_account_id.unwrap();
    println!("Trade account: {trade_account_id}");

    // 3. Fetch available markets
    let markets = client.get_markets().await?;
    println!("Available markets:");
    for m in &markets {
        println!("  {} ({})", m.symbol_pair(), m.market_id);
    }

    let market = markets[0].clone();
    let market_pair = market.symbol_pair();
    println!("\nTrading on: {market_pair}");

    // 4. Create a trading session
    println!("Creating session...");
    let mut session = client
        .create_session(
            &wallet,
            &[&market_pair],
            std::time::Duration::from_secs(30 * 24 * 3600),
        )
        .await?;
    println!("Session created, expiry: {}", session.expiry);

    // 5. Place a spot buy order (low price, unlikely to fill)
    println!("Placing buy order...");
    let price = market.price("0.001")?;
    let quantity = market.quantity("100")?;
    let result = client
        .create_order(
            &mut session,
            &market,
            Side::Buy,
            price,
            quantity,
            OrderType::Spot,
            true, // settle first
            true, // collect orders
        )
        .await;

    match result {
        Ok(resp) => {
            if resp.is_success() {
                println!(
                    "Order placed! tx_id: {}",
                    resp.tx_id.as_deref().unwrap_or("?")
                );
                if let Some(orders) = &resp.orders {
                    for order in orders {
                        println!("  Order ID: {}", order.order_id);
                        println!("  Side: {}", order.side);
                        println!("  Price: {}", order.price);
                        println!("  Quantity: {}", order.quantity);

                        // 6. Cancel the order
                        let oid = &order.order_id;
                        println!("\nCancelling order {oid}...");
                        let cancel = client.cancel_order(&mut session, oid, &market_pair).await;
                        match cancel {
                            Ok(_) => println!("Order cancelled successfully."),
                            Err(e) => println!("Cancel failed: {e}"),
                        }
                    }
                }
            } else {
                println!("Order failed: {:?}", resp.message);
            }
        }
        Err(e) => {
            println!("Order error: {e}");
            println!("(This is expected if account has insufficient balance.)");
        }
    }

    // 7. Check balances
    println!("\nChecking balances...");
    let balances = client.get_balances(&trade_account_id).await?;
    for (symbol, bal) in &balances {
        println!(
            "  {}: available={}, locked={}, unlocked={}",
            symbol, bal.trading_account_balance, bal.total_locked, bal.total_unlocked,
        );
    }

    println!("\nQuickstart complete!");
    Ok(())
}
