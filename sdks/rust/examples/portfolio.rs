use o2_sdk::crypto::*;
/// Portfolio monitoring example: streams balances and orders via WebSocket,
/// displays formatted portfolio state and P&L from trade history.
use o2_sdk::*;
use tokio_stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = O2Client::new(Network::Testnet);

    // Setup
    let wallet = client.generate_wallet()?;
    let owner_hex = to_hex_string(&wallet.b256_address);
    println!("Owner: {owner_hex}");

    let account = client.setup_account(&wallet).await?;
    let trade_account_id = account.trade_account_id.unwrap();
    println!("Trade account: {trade_account_id}");

    // Fetch markets and display initial balances
    let markets = client.get_markets().await?;
    println!("\n--- Available Markets ---");
    for m in &markets {
        println!(
            "  {} | min_order: {} | base_decimals: {} | quote_decimals: {}",
            m.symbol_pair(),
            m.min_order,
            m.base.decimals,
            m.quote.decimals
        );
    }

    // Display balances
    println!("\n--- Balances ---");
    let balances = client.get_balances(&trade_account_id).await?;
    for (symbol, bal) in &balances {
        let available = bal.trading_account_balance;
        let locked = bal.total_locked;
        let unlocked = bal.total_unlocked;
        println!("  {symbol}: available={available}, locked={locked}, unlocked={unlocked}");
    }

    // Display open orders for each market
    for market in &markets {
        let pair = market.symbol_pair();
        let orders_resp = client
            .get_orders(&trade_account_id, &pair, Some(true), 20)
            .await?;

        if !orders_resp.orders.is_empty() {
            println!("\n--- Open Orders ({pair}) ---");
            for order in &orders_resp.orders {
                let side = order.side;
                let price = order.price;
                let qty = order.quantity;
                let fill = order.quantity_fill.unwrap_or(0);
                let oid = &order.order_id;
                println!("  {side} {qty} @ {price} (filled: {fill}) [{oid}]");
            }
        }
    }

    // Display recent trades
    if let Some(market) = markets.first() {
        let pair = market.symbol_pair();
        let trades = client.get_trades(&pair, 10).await?;
        if !trades.trades.is_empty() {
            println!("\n--- Recent Trades ({pair}) ---");
            for trade in &trades.trades {
                let side = trade.side;
                let price = trade.price;
                let qty = trade.quantity;
                let ts = trade.timestamp;
                println!("  {side} {qty} @ {price} at {ts}");
            }
        }
    }

    // Stream balances in real-time
    println!("\n--- Streaming Balance Updates ---");
    let identity = Identity::ContractId(trade_account_id.to_string());
    let mut balance_stream = client.stream_balances(&[identity]).await?;

    while let Some(Ok(update)) = balance_stream.next().await {
        for entry in &update.balance {
            let asset = entry.asset_id.as_str();
            let available = entry.trading_account_balance;
            let locked = entry.total_locked;
            let unlocked = entry.total_unlocked;
            println!(
                "[balance] asset={} available={} locked={} unlocked={}",
                &asset[..10.min(asset.len())],
                available,
                locked,
                unlocked
            );
        }
    }

    Ok(())
}
