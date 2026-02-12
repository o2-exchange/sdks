# Error Handling Guide

This guide covers error handling patterns for the O2 Rust SDK.

> See also: [`O2Error`](crate::O2Error) API reference.

## Error Type

All SDK errors are represented by the [`O2Error`](crate::O2Error) enum, which implements
`std::error::Error` and `Display` via `thiserror`:

```rust,ignore
use o2_sdk::O2Error;

match client.create_order(&mut session, "fFUEL/fUSDC", Side::Buy, 0.02, 100.0, OrderType::Spot, true, true).await {
    Ok(resp) => println!("Success: {:?}", resp.tx_id),
    Err(e) => println!("Error: {}", e),
}
```

## Error Variant Reference

### General Errors (1xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 1000 | `InternalError` | Unexpected server error | Retry with backoff |
| 1001 | `InvalidRequest` | Malformed or invalid request | Fix request |
| 1002 | `ParseError` | Failed to parse request body | Fix request format |
| 1003 | `RateLimitExceeded` | Too many requests | Wait 3-5s, retry |
| 1004 | `GeoRestricted` | Region not allowed | Use different region |

### Market Errors (2xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 2000 | `MarketNotFound` | Market not found | Check market_id |
| 2001 | `MarketPaused` | Market is paused | Wait for market to resume |
| 2002 | `MarketAlreadyExists` | Market already exists | Use existing market |

### Order Errors (3xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 3000 | `OrderNotFound` | Order not found | Order may be filled/cancelled |
| 3001 | `OrderNotActive` | Order is not active | Order already closed |
| 3002 | `InvalidOrderParams` | Invalid order parameters | Check price/quantity |

### Account/Session Errors (4xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 4000 | `InvalidSignature` | Signature verification failed | Check signing logic |
| 4001 | `InvalidSession` | Session invalid or expired | Recreate session |
| 4002 | `AccountNotFound` | Trading account not found | Call `setup_account()` |
| 4003 | `WhitelistNotConfigured` | Whitelist not configured | Whitelist the account |

### Trade Errors (5xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 5000 | `TradeNotFound` | Trade not found | Check trade_id |
| 5001 | `InvalidTradeCount` | Invalid trade count | Adjust count parameter |

### Subscription Errors (6xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 6000 | `AlreadySubscribed` | Already subscribed | Skip duplicate subscription |
| 6001 | `TooManySubscriptions` | Subscription limit reached | Unsubscribe from unused streams |
| 6002 | `SubscriptionError` | General subscription error | Reconnect WebSocket |

### Validation Errors (7xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 7000 | `InvalidAmount` | Invalid amount | Check amount value |
| 7001 | `InvalidTimeRange` | Invalid time range | Fix from/to timestamps |
| 7002 | `InvalidPagination` | Invalid pagination params | Fix count/offset |
| 7003 | `NoActionsProvided` | No actions in request | Add at least one action |
| 7004 | `TooManyActions` | Too many actions (max 5) | Split into multiple batches |

### Block/Events Errors (8xxx)

| Code | Variant | Description | Recovery |
|------|---------|-------------|----------|
| 8000 | `BlockNotFound` | Block not found | Block may not be indexed yet |
| 8001 | `EventsNotFound` | Events not found | Events may not be indexed yet |

## Matching Specific Errors

Use Rust's `match` expression to handle specific error variants:

```rust,ignore
use o2_sdk::{O2Error, O2Client, Side, OrderType};

match client.create_order(
    &mut session, "fFUEL/fUSDC", Side::Buy, 0.02, 100.0,
    OrderType::Spot, true, true,
).await {
    Ok(resp) if resp.is_success() => {
        println!("Order placed: {}", resp.tx_id.unwrap_or_default());
    }
    Ok(resp) if resp.is_onchain_error() => {
        // On-chain revert (has message but no code)
        println!("Revert: {}", resp.reason.as_deref().unwrap_or("unknown"));
    }
    Ok(resp) => {
        // Pre-flight error (has code)
        println!("Error {}: {}", resp.code.unwrap_or(0), resp.message.as_deref().unwrap_or("?"));
    }
    Err(O2Error::SessionExpired(_)) => {
        // Create a new session
        session = client.create_session(&wallet, &["fFUEL/fUSDC"], 30).await?;
    }
    Err(O2Error::RateLimitExceeded(_)) => {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    Err(O2Error::InvalidSignature(_)) => {
        // Check your key/signer setup
        panic!("Signing verification failed");
    }
    Err(O2Error::AccountNotFound(_)) => {
        // Set up the account first
        client.setup_account(&wallet).await?;
    }
    Err(e) => {
        println!("Unexpected error: {}", e);
    }
}
```

## On-Chain Reverts

On-chain reverts occur when a transaction is submitted but fails during
execution. These are returned as [`O2Error::OnChainRevert`](crate::O2Error::OnChainRevert) with `message`
and `reason` fields:

```rust,ignore
match client.create_order(&mut session, "fFUEL/fUSDC", Side::Buy, 0.02, 100.0, OrderType::Spot, true, true).await {
    Err(O2Error::OnChainRevert { reason, message, .. }) => {
        match reason.as_str() {
            "NotEnoughBalance" => {
                println!("Insufficient funds");
            }
            "TraderNotWhiteListed" => {
                // Re-whitelist the account
                client.api.whitelist_account(&session.trade_account_id).await?;
            }
            _ => {
                println!("Revert: {} ({})", message, reason);
            }
        }
    }
    _ => {}
}
```

Common revert reasons:

| Reason | Description |
|--------|-------------|
| `NotEnoughBalance` | Insufficient funds for the operation |
| `TraderNotWhiteListed` | The trading account is not whitelisted |
| `InvalidPrice` | Price violates on-chain constraints |
| `OrderNotFound` | The order to cancel does not exist |
| `PricePrecision` | Price exceeds maximum precision |
| `FractionalPrice` | Price * quantity is not evenly divisible |
| `MinOrderNotReached` | Order value below minimum |

## Response-Level Error Detection

The [`SessionActionsResponse`](crate::SessionActionsResponse) provides helper methods to distinguish
between success and different error types:

```rust,ignore
let resp = client.create_order(&mut session, "fFUEL/fUSDC", Side::Buy, 0.02, 100.0, OrderType::Spot, true, true).await?;

if resp.is_success() {
    // Transaction succeeded — tx_id is present
    println!("TX: {}", resp.tx_id.unwrap_or_default());
} else if resp.is_preflight_error() {
    // Pre-flight validation error — code field is present
    println!("Pre-flight error {}: {}", resp.code.unwrap_or(0), resp.message.as_deref().unwrap_or("?"));
} else if resp.is_onchain_error() {
    // On-chain revert — message present but no code
    println!("On-chain revert: {}", resp.reason.as_deref().unwrap_or("?"));
}
```

## Error Utility Methods

The [`O2Error`](crate::O2Error) enum provides helper methods:

```rust,ignore
// Get the numeric error code (if applicable)
if let Some(code) = error.error_code() {
    println!("Error code: {}", code);
}

// Check if the error is retryable
if error.is_retryable() {
    // Retry with backoff
}
```

## Nonce Errors

The on-chain nonce increments **even on reverted transactions**. The SDK
handles this automatically by calling [`O2Client::refresh_nonce`](crate::client::O2Client::refresh_nonce) after any action
failure.

If you manage nonces manually, always re-fetch after errors:

```rust,ignore
match client.batch_actions(&mut session, "fFUEL/fUSDC", actions, true).await {
    Err(_) => {
        // Nonce was already refreshed by the SDK
        // The next call will use the correct nonce
    }
    Ok(resp) => { /* ... */ }
}
```

## Robust Trading Loop

A production-grade pattern with error recovery:

```rust,ignore
use o2_sdk::{O2Client, Network, O2Error, Side, OrderType};
use std::time::Duration;

async fn trading_loop() -> Result<(), O2Error> {
    let mut client = O2Client::new(Network::Mainnet);
    let wallet = client.load_wallet(&std::env::var("O2_PRIVATE_KEY").unwrap())?;
    let _account = client.setup_account(&wallet).await?;
    let mut session = client.create_session(&wallet, &["FUEL/USDC"], 30).await?;

    loop {
        match client.create_order(
            &mut session, "FUEL/USDC", Side::Buy, 0.02, 100.0,
            OrderType::PostOnly, true, true,
        ).await {
            Ok(resp) if resp.is_success() => {
                println!("Order placed: {}", resp.tx_id.unwrap_or_default());
            }
            Ok(resp) => {
                if let Some(reason) = &resp.reason {
                    println!("Revert: {}", reason);
                    if reason == "NotEnoughBalance" {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            Err(O2Error::SessionExpired(_)) => {
                session = client.create_session(&wallet, &["FUEL/USDC"], 30).await?;
                continue;
            }
            Err(O2Error::RateLimitExceeded(_)) => {
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            Err(O2Error::OnChainRevert { reason, .. }) => {
                println!("Revert: {}", reason);
                if reason == "NotEnoughBalance" {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            Err(e) => {
                println!("Error: {}", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        }

        tokio::time::sleep(Duration::from_secs(15)).await;
    }

    client.disconnect_ws().await?;
    Ok(())
}
```
