# O2 SDK for Rust -- LLM Reference

## Installation

```toml
[dependencies]
o2-sdk = { path = "sdks/rust" }
tokio = { version = "1", features = ["full"] }
```

## Quick Start

```rust
use o2_sdk::{O2Client, Network, Side, OrderType};

#[tokio::main]
async fn main() -> Result<(), o2_sdk::O2Error> {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet()?;
    let _account = client.setup_account(&wallet).await?;
    let market_symbol: o2_sdk::MarketSymbol = "fFUEL/fUSDC".into();
    let mut session = client.create_session(&wallet, &[&market_symbol], std::time::Duration::from_secs(30 * 24 * 3600)).await?;
    let market = client.get_market(&market_symbol).await?;
    let price = market.price("0.05")?;
    let quantity = market.quantity("100")?;
    let _order = client
        .create_order(
            &mut session,
            &market,
            Side::Buy,
            price,
            quantity,
            OrderType::Spot,
            true,
            true,
        )
        .await?;
    Ok(())
}
```

## API Reference

### O2Client

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `new(network)` | `Network` | `O2Client` | Create client for network |
| `with_config(config)` | `NetworkConfig` | `O2Client` | Create with custom config |
| `generate_wallet()` | - | `Result<Wallet>` | Generate Fuel keypair |
| `generate_evm_wallet()` | - | `Result<EvmWallet>` | Generate EVM keypair |
| `load_wallet(hex)` | `&str` | `Result<Wallet>` | Load from private key |
| `load_evm_wallet(hex)` | `&str` | `Result<EvmWallet>` | Load EVM from private key |
| `setup_account(wallet)` | `&Wallet` | `Result<AccountResponse>` | Idempotent account setup |
| `create_session(owner, markets, ttl)` | `&impl SignableWallet, &[&MarketSymbol], Duration` | `Result<Session>` | Create trading session |
| `create_session_until(owner, markets, expiry_unix_secs)` | `&impl SignableWallet, &[&MarketSymbol], u64` | `Result<Session>` | Create session with absolute expiry |
| `set_metadata_policy(policy)` | `MetadataPolicy` | `()` | Configure market metadata refresh strategy |
| `create_order(session, market, side, price, qty, type, settle, collect)` | `&mut Session, &Market, Side, Price, Quantity, ...` | `Result<SessionActionsResponse>` | Place order (first-class typed API) |
| `create_order_untyped(session, market_name, side, price, qty, type, settle, collect)` | `&mut Session, &MarketSymbol, Side, UnsignedDecimal, UnsignedDecimal, ...` | `Result<SessionActionsResponse>` | Lower-level decimal escape hatch |
| `cancel_order(session, order_id, market)` | `&mut Session, &OrderId, &MarketSymbol` | `Result<SessionActionsResponse>` | Cancel order |
| `cancel_all_orders(session, market)` | `&mut Session, &MarketSymbol` | `Result<Vec<...>>` | Cancel all open orders |
| `settle_balance(session, market)` | `&mut Session, &MarketSymbol` | `Result<SessionActionsResponse>` | Settle balance |
| `batch_actions(session, actions, calls, collect)` | advanced | `Result<SessionActionsResponse>` | Raw batch submit |
| `get_markets()` | - | `Result<Vec<Market>>` | List markets |
| `get_market(name)` | `&MarketSymbol` | `Result<Market>` | Get by symbol pair |
| `get_depth(market, precision)` | `&MarketSymbol, u64` | `Result<DepthSnapshot>` | Order book depth |
| `get_trades(market, count)` | `&MarketSymbol, u32` | `Result<TradesResponse>` | Recent trades |
| `get_bars(market, res, from, to)` | `&MarketSymbol, &str, u64, u64` | `Result<Vec<Bar>>` | OHLCV data |
| `get_ticker(market)` | `&MarketSymbol` | `Result<MarketTicker>` | Ticker data |
| `get_balances(trade_account_id)` | `&TradeAccountId` | `Result<HashMap<String, BalanceResponse>>` | All balances |
| `get_orders(account, market, is_open, count)` | `&TradeAccountId, &MarketSymbol, Option<bool>, u32` | `Result<OrdersResponse>` | Order history |
| `get_nonce(trade_account_id)` | `&str` | `Result<u64>` | Current nonce |
| `refresh_nonce(session)` | `&mut Session` | `Result<u64>` | Re-sync nonce from API |
| `stream_depth(market_id, precision)` | `&str, &str` | `Result<TypedStream<DepthUpdate>>` | Stream depth |
| `stream_orders(identities)` | `&[Identity]` | `Result<TypedStream<OrderUpdate>>` | Stream orders |
| `stream_trades(market_id)` | `&str` | `Result<TypedStream<TradeUpdate>>` | Stream trades |
| `stream_balances(identities)` | `&[Identity]` | `Result<TypedStream<BalanceUpdate>>` | Stream balances |
| `stream_nonce(identities)` | `&[Identity]` | `Result<TypedStream<NonceUpdate>>` | Stream nonce |

Note: `unsubscribe_orders` is currently connection-global in the backend API (not identity-scoped), so it removes all order subscriptions for that socket.

### Low-Level: crypto

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `generate_keypair()` | - | `Result<Wallet>` | Fuel-native keypair |
| `generate_evm_keypair()` | - | `Result<EvmWallet>` | EVM keypair |
| `fuel_compact_sign(key, digest)` | `&[u8;32], &[u8;32]` | `Result<[u8;64]>` | Sign with recovery ID in MSB |
| `personal_sign(key, msg)` | `&[u8;32], &[u8]` | `Result<[u8;64]>` | Fuel prefix + SHA-256 |
| `raw_sign(key, msg)` | `&[u8;32], &[u8]` | `Result<[u8;64]>` | Plain SHA-256 signing |
| `evm_personal_sign(key, msg)` | `&[u8;32], &[u8]` | `Result<[u8;64]>` | Ethereum prefix + keccak256 |
| `to_hex_string(bytes)` | `&[u8]` | `String` | "0x"-prefixed hex |
| `parse_hex_32(s)` | `&str` | `Result<[u8;32]>` | Parse hex to 32 bytes |

### Low-Level: encoding

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `u64_be(value)` | `u64` | `[u8;8]` | Big-endian u64 |
| `function_selector(name)` | `&str` | `Vec<u8>` | Fuel ABI selector (NOT hash) |
| `encode_identity(disc, addr)` | `u64, &[u8;32]` | `Vec<u8>` | Identity enum encoding |
| `encode_order_args(price, qty, ot)` | `u64, u64, &OrderTypeEncoding` | `Vec<u8>` | OrderArgs struct |
| `build_session_signing_bytes(...)` | nonce, chain_id, addr, contracts, expiry | `Vec<u8>` | Session creation bytes |
| `build_actions_signing_bytes(nonce, calls)` | `u64, &[CallArg]` | `Vec<u8>` | Action signing bytes |
| `create_order_to_call(...)` | contract, side, price, qty, ot, decimals, assets | `CallArg` | Order call arg |
| `cancel_order_to_call(contract, oid)` | `&[u8;32], &[u8;32]` | `CallArg` | Cancel call arg |
| `settle_balance_to_call(contract, disc, addr)` | `&[u8;32], u64, &[u8;32]` | `CallArg` | Settle call arg |

## Common Patterns

### 1. Setup & First Trade

```rust
let mut client = O2Client::new(Network::Testnet);
let wallet = client.generate_wallet()?;
let account = client.setup_account(&wallet).await?;
let market_symbol: o2_sdk::MarketSymbol = "fFUEL/fUSDC".into();
let mut session = client.create_session(&wallet, &[&market_symbol], std::time::Duration::from_secs(30 * 24 * 3600)).await?;
let market = client.get_market(&market_symbol).await?;
let resp = client.create_order(
    &mut session,
    &market,
    Side::Buy,
    market.price("0.05")?,
    market.quantity("100")?,
    OrderType::Spot,
    true,
    true,
).await?;
```

### 2. Market Maker Loop

```rust
loop {
    let buy_price = ref_price * (1.0 - spread);
    let sell_price = ref_price * (1.0 + spread);
    // Build calls: cancel old + settle + create new (max 5 actions)
    let result = client.batch_actions(&mut session, market_actions, calls, true).await?;
    // Track order IDs from result.orders for next cycle cancellation
    tokio::time::sleep(interval).await;
}
```

### 3. Real-Time Depth Monitoring

```rust
let mut stream = client.stream_depth(&market.market_id, "10").await?;
while let Some(update) = stream.next().await {
    // update.view = initial snapshot, update.changes = incremental
}
```

### 4. Order Management

```rust
client.cancel_order(&mut session, "0xorder_id...", "fFUEL/fUSDC").await?;
client.cancel_all_orders(&mut session, "fFUEL/fUSDC").await?;
client.settle_balance(&mut session, "fFUEL/fUSDC").await?;
```

### 5. Balance Tracking

```rust
let balances = client.get_balances(&trade_account_id).await?;
for (symbol, bal) in &balances {
    println!("{}: available={}", symbol, bal.trading_account_balance);
}
```

## Error Handling

| Code | Name | Recovery |
|------|------|----------|
| 1000 | InternalError | Retry with backoff |
| 1003 | RateLimitExceeded | Exponential backoff |
| 2000 | MarketNotFound | Verify market_id |
| 3000 | OrderNotFound | Verify order_id |
| 4000 | InvalidSignature | Check signing logic (personalSign vs rawSign) |
| 4001 | InvalidSession | Create new session |
| 4002 | AccountNotFound | Create account first |
| 7004 | TooManyActions | Split into batches (max 5) |
| OnChainRevert | No code, has `reason` | Check `reason` field, re-fetch nonce |

```rust
match client.create_order(&mut session, &market, ...).await {
    Ok(resp) if resp.is_success() => { /* tx_id present */ }
    Ok(resp) => { /* check resp.message, resp.reason */ }
    Err(O2Error::RateLimitExceeded(_)) => { /* backoff */ }
    Err(O2Error::InvalidSignature(_)) => { /* check signing */ }
    Err(e) => { client.refresh_nonce(&mut session).await?; }
}
```

## Type Reference

| Type | Key Fields | Description |
|------|-----------|-------------|
| `Wallet` | `private_key, public_key, b256_address` | Fuel-native wallet |
| `EvmWallet` | `private_key, evm_address, b256_address` | EVM wallet |
| `Session` | `session_private_key, trade_account_id, nonce` | Trading session state |
| `Market` | `market_id, contract_id, base, quote, min_order` | Market config |
| `MarketAsset` | `symbol, asset, decimals, max_precision` | Asset within market |
| `Order` | `order_id, side, price, quantity, close, cancel` | Order data |
| `DepthLevel` | `price, quantity` | Single depth level |
| `DepthSnapshot` | `buys, sells` | Full depth data |
| `BalanceResponse` | `trading_account_balance, total_locked, total_unlocked` | Balance info |
| `Identity` | `Address(String)` or `ContractId(String)` | Fuel identity enum |
| `OrderTypeEncoding` | `Spot, Market, Limit{..}, BoundedMarket{..}, ...` | Order type for encoding |
| `CallArg` | `contract_id, function_selector, amount, asset_id, gas, call_data` | Low-level call |

## Critical Notes

- Session creation uses `personal_sign`; session actions use `raw_sign`
- Nonce increments on-chain even on reverts; always re-fetch on error
- `setup_account` is idempotent; safe on every bot restart
- Function selectors are `u64(len) + utf8(name)`, NOT hashes
- OrderType encoding is tightly packed (no padding)
- gas = `u64::MAX`; chain_id can be 0 on testnet
- Markets accept both hex IDs and symbol pairs (e.g., "fFUEL/fUSDC")
