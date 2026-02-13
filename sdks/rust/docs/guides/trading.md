# Trading Guide

This guide covers common trading patterns using the O2 Rust SDK.

> See also: [`O2Client`](crate::client::O2Client) API reference.

## Order Types

The O2 Exchange supports six order types, specified via the [`OrderType`](crate::OrderType) enum
passed to [`O2Client::create_order`](crate::client::O2Client::create_order).

```rust,ignore
use o2_sdk::{O2Client, Network, Side, OrderType};
```

### Spot (default)

A standard limit order that rests on the book if not immediately filled.

```rust,ignore
client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.02".parse()?, "100".parse()?,
    OrderType::Spot, true, true,
).await?;
```

### PostOnly

Guaranteed to be a maker order. Rejected immediately if it would cross
the spread and match an existing order.

```rust,ignore
client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.02".parse()?, "100".parse()?,
    OrderType::PostOnly, true, true,
).await?;
```

### Market

Executes immediately at the best available price. Fails if the order
book is empty.

```rust,ignore
client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.03".parse()?, "100".parse()?,
    OrderType::Market, true, true,
).await?;
```

### FillOrKill

Must be filled entirely in a single match, or the entire order is
rejected.

```rust,ignore
client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.03".parse()?, "100".parse()?,
    OrderType::FillOrKill, true, true,
).await?;
```

### Limit

Like Spot, but includes a limit price and timestamp for time-in-force
semantics:

```rust,ignore
use std::time::{SystemTime, UNIX_EPOCH};

let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.02".parse()?, "100".parse()?,
    OrderType::Limit { price: "0.025".parse()?, timestamp: now },
    true, true,
).await?;
```

### BoundedMarket

A market order with price bounds — executes at market price but only
within the specified range:

```rust,ignore
client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, "0.025".parse()?, "100".parse()?,
    OrderType::BoundedMarket { max_price: "0.03".parse()?, min_price: "0.01".parse()? },
    true, true,
).await?;
```

## Cancel and Replace

Cancel an existing order:

```rust,ignore
// Cancel by order ID
client.cancel_order(&mut session, "0xabc...", "fFUEL/fUSDC").await?;

// Cancel all open orders
client.cancel_all_orders(&mut session, "fFUEL/fUSDC").await?;
```

To atomically cancel-and-replace in a single transaction, use
[`O2Client::batch_actions`](crate::client::O2Client::batch_actions) with typed [`Action`](crate::Action) variants:

```rust,ignore
use o2_sdk::{Action, Side, OrderType};

let actions = vec![
    Action::CancelOrder { order_id: old_order_id.into() },
    Action::SettleBalance,
    Action::CreateOrder {
        side: Side::Buy,
        price: new_price,
        quantity: new_qty,
        order_type: OrderType::Spot,
    },
];

let result = client.batch_actions(&mut session, "fFUEL/fUSDC", actions, true).await?;
```

> **Important:** Prices and quantities in [`Action::CreateOrder`](crate::Action::CreateOrder) are
> human-readable values. The SDK automatically scales them to on-chain
> integers using the market's decimal configuration. For manual scaling,
> use [`Market::scale_price`](crate::Market::scale_price) and
> [`Market::scale_quantity`](crate::Market::scale_quantity).

## Settling Balances

When your orders are filled, the proceeds remain locked in the order book
contract until they are settled back to your trading account.

[`O2Client::create_order`](crate::client::O2Client::create_order) handles this automatically when `settle_first`
is `true` (the default). You can also settle manually:

```rust,ignore
client.settle_balance(&mut session, "fFUEL/fUSDC").await?;
```

## Market Maker Pattern

A simple two-sided quoting loop using typed actions:

```rust,ignore
use o2_sdk::{O2Client, Network, Action, Side, OrderType};
use std::time::Duration;

let mut client = O2Client::new(Network::Testnet);
// ... setup wallet, account, session ...

let spread = 0.001;
let qty = 50.0;
let mut active_buy: Option<String> = None;
let mut active_sell: Option<String> = None;

loop {
    // Get current mid price
    let depth = client.get_depth("fFUEL/fUSDC", 10).await?;
    let buys = depth.buys.as_deref().unwrap_or_default();
    let sells = depth.sells.as_deref().unwrap_or_default();

    let mid = if let (Some(bid), Some(ask)) = (buys.first(), sells.first()) {
        let bid_price: f64 = bid.price.parse().unwrap_or(0.0);
        let ask_price: f64 = ask.price.parse().unwrap_or(0.0);
        (bid_price + ask_price) / 2.0
    } else {
        tokio::time::sleep(Duration::from_secs(5)).await;
        continue;
    };

    let buy_price = mid - spread / 2.0;
    let sell_price = mid + spread / 2.0;

    // Build batch: cancel old + settle + place new
    let mut actions = Vec::new();
    if let Some(ref id) = active_buy {
        actions.push(Action::CancelOrder { order_id: id.clone().into() });
    }
    if let Some(ref id) = active_sell {
        actions.push(Action::CancelOrder { order_id: id.clone().into() });
    }
    actions.push(Action::SettleBalance);
    actions.push(Action::CreateOrder {
        side: Side::Buy,
        price: format!("{buy_price}").parse()?,
        quantity: format!("{qty}").parse()?,
        order_type: OrderType::PostOnly,
    });
    actions.push(Action::CreateOrder {
        side: Side::Sell,
        price: format!("{sell_price}").parse()?,
        quantity: format!("{qty}").parse()?,
        order_type: OrderType::PostOnly,
    });

    let result = client.batch_actions(&mut session, "fFUEL/fUSDC", actions, true).await?;

    if let Some(ref orders) = result.orders {
        active_buy = orders.iter()
            .find(|o| o.side.as_deref() == Some("Buy"))
            .and_then(|o| o.order_id.as_ref().map(|id| id.to_string()));
        active_sell = orders.iter()
            .find(|o| o.side.as_deref() == Some("Sell"))
            .and_then(|o| o.order_id.as_ref().map(|id| id.to_string()));
    }

    tokio::time::sleep(Duration::from_secs(15)).await;
}
```

## Order Monitoring

Query order status:

```rust,ignore
// All orders for an account
let orders = client.get_orders(
    &session.trade_account_id, "fFUEL/fUSDC", None, 20,
).await?;

// Open orders only
let open_orders = client.get_orders(
    &session.trade_account_id, "fFUEL/fUSDC", Some(true), 20,
).await?;

// Single order by ID
let order = client.get_order("fFUEL/fUSDC", "0xabc...").await?;
let is_open = order.close != Some(true);
println!("Status: {}", if is_open { "open" } else { "closed" });
println!(
    "Filled: {} / {}",
    order.quantity_fill.as_deref().unwrap_or("0"),
    order.quantity.as_deref().unwrap_or("0"),
);
```

For real-time order updates, use [`O2Client::stream_orders`](crate::client::O2Client::stream_orders):

```rust,ignore
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let identity = Identity::ContractId(session.trade_account_id.to_string());
let mut stream = client.stream_orders(&[identity]).await?;

while let Some(Ok(update)) = stream.next().await {
    if let Some(ref orders) = update.orders {
        for order in orders {
            let status = if order.close == Some(true) { "closed" } else { "open" };
            println!("Order {}: {}", order.order_id.as_deref().unwrap_or("?"), status);
        }
    }
}
```

## Withdrawals

Withdraw funds from the trading account to the owner wallet:

```rust,ignore
let result = client.withdraw(
    &wallet,
    &session,
    &asset_id,       // hex asset ID
    "1000000000",    // amount in chain integer string
    None,            // defaults to owner address
).await?;
println!("Withdrawal tx: {}", result.tx_id.unwrap_or_default());
```

> **Note:** Withdrawals require the **owner wallet** (not the session key)
> and use `personalSign`.

## Nonce Management

The SDK automatically manages nonces during trading. If you encounter nonce
errors after a failed transaction, refresh the nonce:

```rust,ignore
client.refresh_nonce(&mut session).await?;
```

You can also fetch the current nonce directly:

```rust,ignore
let nonce = client.get_nonce(&session.trade_account_id).await?;
```
