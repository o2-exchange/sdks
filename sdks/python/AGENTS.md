# O2 SDK for Python -- LLM Reference

## Installation

```bash
pip install o2-sdk
# or from source:
pip install -e sdks/python
```

## Quick Start (5 lines)

```python
import asyncio
from o2_sdk import O2Client, Network, OrderSide, OrderType

async def main():
    client = O2Client(network=Network.TESTNET)
    owner = client.generate_wallet()
    account = await client.setup_account(owner)
    session = await client.create_session(owner=owner, markets=["FUEL/USDC"])
    result = await client.create_order("FUEL/USDC", OrderSide.BUY, 0.02, 100.0)
    batch = (
        client.actions_for("FUEL/USDC")
        .settle_balance()
        .create_order(OrderSide.SELL, "0.03", "50", OrderType.POST_ONLY)
        .build()
    )
    await client.batch_actions([batch], collect_orders=True)
    print(result.tx_id)
    await client.close()

asyncio.run(main())
```

## API Reference

### O2Client

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `__init__` | `network=Network.TESTNET, custom_config=None` | `O2Client` | Initialize client |
| `generate_wallet()` | - | `Wallet` | New Fuel wallet (static) |
| `generate_evm_wallet()` | - | `EvmWallet` | New EVM wallet (static) |
| `load_wallet(pk_hex)` | `private_key_hex: str` | `Wallet` | Load Fuel wallet |
| `load_evm_wallet(pk_hex)` | `private_key_hex: str` | `EvmWallet` | Load EVM wallet |
| `setup_account(wallet)` | `wallet: Wallet\|EvmWallet` | `AccountInfo` | Idempotent account setup (create+fund+whitelist) |
| `create_session(owner, markets, expiry_days=30)` | `owner, markets: list[str], expiry_days: int` | `SessionInfo` | Create trading session |
| `create_order(market, side, price, quantity, ..., session=None)` | see below | `ActionsResponse` | Place an order |
| `cancel_order(order_id, market=None, market_id=None, session=None)` | - | `ActionsResponse` | Cancel an order |
| `cancel_all_orders(market, session=None)` | - | `ActionsResponse` | Cancel all open orders |
| `settle_balance(market, session=None)` | - | `ActionsResponse` | Settle filled order proceeds |
| `actions_for(market)` | `market: str \| Market` | `MarketActionsBuilder` | Fluent high-level action builder |
| `batch_actions(actions, collect_orders=False, session=None)` | `Sequence[MarketActions \| MarketActionGroup]` | `ActionsResponse` | Submit low/high-level batch actions |
| `get_markets()` | - | `list[Market]` | List all markets |
| `get_market(symbol_pair)` | `"FUEL/USDC"` | `Market` | Get specific market |
| `get_depth(market, precision=10)` | - | `DepthSnapshot` | Order book depth |
| `get_trades(market, count=50)` | - | `list[Trade]` | Recent trades |
| `get_bars(market, resolution, from_ts, to_ts)` | - | `list[Bar]` | OHLCV candles |
| `get_ticker(market)` | - | `dict` | Ticker data |
| `get_balances(account)` | `AccountInfo\|str` | `dict[str, Balance]` | Balances by symbol |
| `get_orders(account, market, is_open=None, count=20)` | - | `list[Order]` | Order history |
| `get_order(market, order_id)` | - | `Order` | Single order |
| `stream_depth(market, precision=10)` | - | `AsyncIterator[DepthUpdate]` | WS depth |
| `stream_orders(account)` | - | `AsyncIterator[OrderUpdate]` | WS orders |
| `stream_trades(market)` | - | `AsyncIterator[TradeUpdate]` | WS trades |
| `stream_balances(account)` | - | `AsyncIterator[BalanceUpdate]` | WS balances |
| `stream_nonce(account)` | - | `AsyncIterator[NonceUpdate]` | WS nonce |
| `withdraw(owner, asset, amount, to=None)` | - | `WithdrawResponse` | Withdraw funds |
| `get_nonce(trade_account_id)` | - | `int` | Current nonce |
| `refresh_nonce(session)` | - | `int` | Re-fetch nonce from API |
| `close()` | - | `None` | Close all connections |

#### `create_order` Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `session` | `SessionInfo \| None` | optional | Explicit session override (defaults to active client session) |
| `market` | `str` | required | Market pair or ID |
| `side` | `OrderSide` | required | `OrderSide.BUY` or `OrderSide.SELL` |
| `price` | `NumericInput` | required | Human-readable (`str`/`float`) or `ChainInt` raw |
| `quantity` | `NumericInput` | required | Human-readable (`str`/`float`) or `ChainInt` raw |
| `order_type` | `OrderType \| LimitOrder \| BoundedMarketOrder` | `OrderType.SPOT` | Simple enum or typed class |
| `settle_first` | `bool` | `True` | Auto-prepend SettleBalance |
| `collect_orders` | `bool` | `True` | Return order details |

#### Enums & Order Type Parameters

| Type | Values / Fields | Description |
|------|-----------------|-------------|
| `OrderSide` | `BUY`, `SELL` | Side of an order |
| `OrderType` | `SPOT`, `MARKET`, `FILL_OR_KILL`, `POST_ONLY` | Simple order type enum (use `LimitOrder` / `BoundedMarketOrder` for parameterized types) |
| `LimitOrder` | `price: NumericInput, timestamp: int \| None` | Limit order with expiry (prices auto-scaled unless `ChainInt`) |
| `BoundedMarketOrder` | `max_price: NumericInput, min_price: NumericInput` | Bounded market order (auto-scaled unless `ChainInt`) |
| `ChainInt` | `value: int` | Explicit already-scaled chain integer wrapper |

#### Action Types (for `batch_actions`)

| Type | Fields | Description |
|------|--------|-------------|
| `CreateOrderAction` | `side: OrderSide, price: str, quantity: str, order_type: OrderType \| LimitOrder \| BoundedMarketOrder` | Pre-scaled order |
| `CancelOrderAction` | `order_id: Id` | Cancel an order |
| `SettleBalanceAction` | `to: Identity \| Id` | Settle balance (`Id` auto-wraps as `ContractIdentity`) |
| `RegisterRefererAction` | `to: Identity \| Id` | Register a referer |
| `MarketActions` | `market_id: str, actions: list[Action]` | Group of actions for a market |

`Action = CreateOrderAction | CancelOrderAction | SettleBalanceAction | RegisterRefererAction`

High-level batch action models:
- `MarketActionGroup(market=..., actions=[...])`
- `CreateOrderRequestAction(side, price, quantity, order_type=...)`
- `CancelOrderRequestAction(order_id)`
- `SettleBalanceRequestAction()`

### Low-Level Modules

#### Crypto (`o2_sdk.crypto`)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `fuel_personal_sign_digest(msg)` | message bytes | `bytes(32)` | Fuel personalSign digest (prefix + SHA-256) |
| `evm_personal_sign_digest(msg)` | message bytes | `bytes(32)` | Ethereum personal_sign digest (prefix + keccak256) |
| `fuel_compact_sign(pk_bytes, digest)` | 32B key, 32B digest | `bytes(64)` | Sign with recovery ID in MSB of s[0] |
| `personal_sign(pk_bytes, msg)` | 32B key, message | `bytes(64)` | Fuel personalSign (session creation) |
| `raw_sign(pk_bytes, msg)` | 32B key, message | `bytes(64)` | Raw SHA-256 sign (session actions) |
| `evm_personal_sign(pk_bytes, msg)` | 32B key, message | `bytes(64)` | Ethereum personal_sign + keccak256 |

#### Encoding (`o2_sdk.encoding`)

| Function | Returns | Description |
|----------|---------|-------------|
| `u64_be(value)` | `bytes(8)` | Big-endian u64 |
| `function_selector(name)` | `bytes` | `u64(len) + utf8(name)` -- NOT a hash |
| `encode_identity(disc, addr)` | `bytes(40)` | 0=Address, 1=ContractId + 32B |
| `encode_order_args(price, qty, type, data)` | `bytes` | Tightly packed OrderArgs |
| `build_session_signing_bytes(...)` | `bytes` | Session creation payload |
| `build_actions_signing_bytes(nonce, calls)` | `bytes` | Action signing payload |
| `action_to_call(action, market_info)` | `dict` | High-level action to low-level call |

## Common Patterns

### 1. Setup & First Trade

```python
client = O2Client(network=Network.TESTNET)
owner = client.generate_wallet()
account = await client.setup_account(owner)
session = await client.create_session(owner=owner, markets=["FUEL/USDC"])
result = await client.create_order("FUEL/USDC", OrderSide.BUY, "0.02", "100")
```

### 2. Market Maker Loop

```python
from o2_sdk import OrderSide, OrderType

while True:
    builder = client.actions_for(market)
    if active_buy_id:
        builder = builder.cancel_order(active_buy_id)
    result = await client.batch_actions(
        session,
        [
            builder
            .settle_balance()
            .create_order(OrderSide.BUY, buy_price, qty, OrderType.SPOT)
            .create_order(OrderSide.SELL, sell_price, qty, OrderType.SPOT)
            .build()
        ],
        collect_orders=True,
    )
    await asyncio.sleep(15)
```

### 3. Taker Bot (BoundedMarket Order)

```python
from o2_sdk import BoundedMarketOrder, OrderSide

result = await client.create_order(
    session, "FUEL/USDC",
    side=OrderSide.BUY,
    price=ask_price,
    quantity=quantity,
    order_type=BoundedMarketOrder(max_price=ask_price * 1.005, min_price=0.0),
)
```

### 4. Real-Time Depth Monitoring

```python
async for update in client.stream_depth("FUEL/USDC", precision=10):
    if update.changes.best_bid:
        print(f"Best bid: {update.changes.best_bid.price}")
```

### 5. Order Management

```python
# Cancel specific order
await client.cancel_order(order_id="0x...", market="FUEL/USDC", session=session)

# Cancel all open orders
await client.cancel_all_orders("FUEL/USDC", session=session)

# Settle balance
await client.settle_balance("FUEL/USDC", session=session)
```

### 6. Identity Construction

```python
from o2_sdk import AddressIdentity, ContractIdentity, Identity

# Construct directly
addr = AddressIdentity("0xabc...")
contract = ContractIdentity("0xdef...")

# Parse from API response dict
identity = Identity.from_dict({"Address": "0xabc..."})   # returns AddressIdentity
identity = Identity.from_dict({"ContractId": "0xdef..."}) # returns ContractIdentity

# Both are subtypes of Identity and work wherever Identity is expected
```

### 7. Balance Tracking & Withdrawals

```python
balances = await client.get_balances(account.trade_account_id)
for symbol, bal in balances.items():
    print(f"{symbol}: {bal.trading_account_balance}")

await client.withdraw(owner=owner, asset="USDC", amount=10.0)
```

## Error Handling

| Code | Name | Recovery |
|------|------|----------|
| 1000 | InternalError | Retry with backoff |
| 1003 | RateLimitExceeded | Wait 3-5s, retry (auto-handled) |
| 2000 | MarketNotFound | Verify market_id |
| 4000 | InvalidSignature | Check signing method (personalSign vs rawSign) |
| 4001 | InvalidSession | Create new session |
| 4002 | AccountNotFound | Call setup_account() |
| 7004 | TooManyActions | Max 5 actions per request |

```python
from o2_sdk import O2Error, InvalidSignature, RateLimitExceeded

try:
    result = await client.create_order(...)
except InvalidSignature:
    # Check signing logic
except RateLimitExceeded:
    await asyncio.sleep(5)
except O2Error as e:
    print(f"Error {e.code}: {e.message}")
```

On-chain reverts (no code field) raise `OnChainRevert` with `.reason` (e.g., `"NotEnoughBalance"`).

## Type Reference

| Type | Key Fields | Description |
|------|------------|-------------|
| `OrderSide` | `BUY`, `SELL` | Enum for order side |
| `OrderType` | `SPOT`, `MARKET`, `FILL_OR_KILL`, `POST_ONLY` | Enum for simple order types (use `LimitOrder` / `BoundedMarketOrder` for parameterized types) |
| `LimitOrder` | `price: NumericInput, timestamp: int \| None` | Limit order params |
| `BoundedMarketOrder` | `max_price: NumericInput, min_price: NumericInput` | Bounded market params |
| `ChainInt` | `value: int` | Explicit raw chain integer (already scaled) |
| `CreateOrderAction` | `side, price, quantity, order_type` | Typed create order action |
| `CancelOrderAction` | `order_id: Id` | Typed cancel action |
| `SettleBalanceAction` | `to: Identity \| Id` | Typed settle action |
| `RegisterRefererAction` | `to: Identity \| Id` | Typed referer action |
| `MarketActions` | `market_id: str, actions: list[Action]` | Actions grouped by market |
| `Identity` | `value` | Base identity (use subclasses) |
| `AddressIdentity` | `value: str` | Address identity |
| `ContractIdentity` | `value: str` | ContractId identity |
| `Wallet` | `private_key, public_key, b256_address` | Fuel-native wallet |
| `EvmWallet` | `private_key, evm_address, b256_address` | EVM wallet |
| `Market` | `contract_id, market_id, base, quote, pair` | Market config |
| `MarketAsset` | `symbol, asset, decimals, max_precision` | Asset in a market |
| `AccountInfo` | `trade_account_id, nonce, exists` | Account state |
| `SessionInfo` | `session_id, trade_account_id, session_private_key, nonce` | Session state |
| `Order` | `order_id, side, price, quantity, close, cancel, is_open` | Order state |
| `Balance` | `trading_account_balance, total_locked, total_unlocked, available` | Balance |
| `DepthSnapshot` | `buys, sells, best_bid, best_ask` | Order book depth |
| `DepthUpdate` | `changes, market_id, is_snapshot` | Depth stream update |
| `ActionsResponse` | `tx_id, orders, success, message` | Action result |
| `Trade` | `trade_id, side, price, quantity, timestamp` | Trade record |
| `Bar` | `time, open, high, low, close, volume` | OHLCV candle |

## Key Concepts

- **personalSign** for session creation, **rawSign** for session actions
- Session wallet always uses Fuel-style signing (even with EVM owner)
- Nonce increments on-chain even on reverts -- re-fetch on error
- Always settle before creating orders (`settle_first=True` by default)
- Max 5 actions per batch, max 5 markets per request
- `setup_account()` is idempotent -- safe on every bot startup
- Prices/quantities accept dual-mode `NumericInput` (human values auto-scaled, `ChainInt` pass-through)

## Integration Test Strategy

- Integration tests reuse deterministic maker/taker wallets via `sdks/python/.integration-wallets.json` (gitignored).
- Account setup avoids unnecessary faucet calls: minting happens only when balance is below a conservative threshold for test workloads.
- Write-path retries are bounded and cooldown-aware for whitelist/faucet transient failures.
- Order placement in live-book fill tests uses conservative post-only bid pricing derived from current depth (with deterministic fallback) to reduce flakiness.
