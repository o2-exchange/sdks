<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="80" alt="O2 Exchange">
</p>

<h1 align="center">O2 SDK for Python</h1>

<p align="center">
  <a href="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center">
  Official Python SDK for the <a href="https://o2.app">O2 Exchange</a> — a fully on-chain order book DEX on the Fuel Network.
</p>

---

## Installation

```bash
pip install o2-sdk
```

Or install from source:

```bash
pip install -e sdks/python
```

Requires **Python 3.10+**.

## Quick Start

Recommended first integration path on testnet:

1. Create/load owner wallet
2. Call `setup_account()` (idempotent setup + faucet mint attempt on testnet/devnet)
3. (Optional) Call `top_up_from_faucet()` for an explicit testnet/devnet top-up
4. Create session
5. Place orders
6. Read balances/orders
7. Settle balances back to your trading account after fills

```python
import asyncio
from o2_sdk import Network, O2Client, OrderSide


async def main():
    client = O2Client(network=Network.TESTNET)
    owner = client.generate_wallet()

    account = await client.setup_account(owner)
    await client.top_up_from_faucet(owner)
    await client.create_session(owner=owner, markets=["fFUEL/fUSDC"])

    order = await client.create_order("fFUEL/fUSDC", OrderSide.BUY, "0.02", "50")
    print(f"order tx={order.tx_id}")

    balances = await client.get_balances(account.trade_account_id)
    fusdc = balances.get("fUSDC")
    print(f"fUSDC balance={fusdc.trading_account_balance if fusdc else 0}")

    settle = await client.settle_balance("fFUEL/fUSDC")
    print(f"settle tx={settle.tx_id}")

    await client.close()


asyncio.run(main())
```

## Network Configuration

Default network configs:

| Network | REST API | WebSocket | Fuel RPC | Faucet |
|---------|----------|-----------|----------|--------|
| `Network.TESTNET` | `https://api.testnet.o2.app` | `wss://api.testnet.o2.app/v1/ws` | `https://testnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2` |
| `Network.DEVNET` | `https://api.devnet.o2.app` | `wss://api.devnet.o2.app/v1/ws` | `https://devnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2` |
| `Network.MAINNET` | `https://api.o2.app` | `wss://api.o2.app/v1/ws` | `https://mainnet.fuel.network/v1/graphql` | none |

API rate limits: <https://docs.o2.app/api-endpoints-reference.html#rate-limits>.

Use a custom deployment config:

```python
from o2_sdk import NetworkConfig, O2Client

client = O2Client(
    custom_config=NetworkConfig(
        api_base="https://my-gateway.example.com",
        ws_url="wss://my-gateway.example.com/v1/ws",
        fuel_rpc="https://mainnet.fuel.network/v1/graphql",
        faucet_url=None,
    )
)
```

> [!IMPORTANT]
> Mainnet note: there is no faucet; account setup requires an owner wallet that already has funds deposited for trading. SDK-native bridging flows are coming soon.

## Wallet Security

- `generate_wallet()` / `generate_evm_wallet()` use cryptographically secure randomness and are suitable for mainnet key generation.
- For production custody, use external signers (KMS/HSM/hardware wallets) instead of long-lived in-process private keys.
- See `docs/guides/external_signers.rst` for production signer integration.

## Wallet Types and Identifiers

Why choose each wallet type:

- **Fuel-native wallet** — best for interoperability with other apps in the Fuel ecosystem.
- **EVM wallet** — best if you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

O2 owner identity model:

- O2 `owner_id` is always a Fuel B256 (`0x` + 64 hex chars).
- Fuel-native wallets already expose that directly as `b256_address`.
- EVM wallets expose both:
  - `evm_address` (`0x` + 40 hex chars)
  - `b256_address` (`0x` + 64 hex chars)
- For EVM wallets, `b256_address` is the EVM address zero-left-padded to 32 bytes:
  - `owner_b256 = 0x000000000000000000000000 + evm_address[2:]`

Identifier usage:

| Context | Identifier |
|---------|------------|
| Owner/account/session APIs | `owner_id` = wallet `b256_address` |
| Trading account state | `trade_account_id` (contract ID) |
| Human-visible EVM identity | `evm_address` |
| Markets | pair (`"fFUEL/fUSDC"`) or `market_id` |

`owner_id` vs `trade_account_id`:

- `owner_id` is wallet identity (`b256_address`) used for ownership/auth and session setup.
- `trade_account_id` is the trading account contract ID used for balances/orders/account state.
- `setup_account(wallet)` links these by creating/fetching the trading account for that owner.

## Features

- **Trading** — Place, cancel, and manage orders with automatic price/quantity scaling
- **Dual-Mode Numeric Inputs** — Pass human values (`"0.02"`, `100.0`) or explicit raw chain integers (`ChainInt(...)`)
- **Strongly Typed** — Enums for order sides/types, dataclasses for actions and order parameters
- **Market Data** — Fetch order book depth, recent trades, OHLCV candles, and ticker data
- **WebSocket Streams** — Real-time depth, order, trade, balance, and nonce updates via `async for`
- **Wallet Support** — Fuel-native and EVM wallets with session-based signing
- **Batch Actions** — Submit up to 5 typed actions per request (cancel + settle + create in one call)
- **Error Handling** — Typed exceptions (`O2Error`, `InvalidSignature`, `RateLimitExceeded`, etc.)

## API Overview

| Method | Description |
|--------|-------------|
| `generate_wallet()` / `load_wallet(pk)` | Create or load a Fuel wallet |
| `generate_evm_wallet()` / `load_evm_wallet(pk)` | Create or load an EVM wallet |
| `setup_account(wallet)` | Idempotent account setup (create + fund + whitelist) |
| `top_up_from_faucet(owner)` | Explicit faucet top-up to the owner's trading account (testnet/devnet) |
| `create_session(owner, markets)` | Create a trading session |
| `create_order(market, side, price, qty)` | Place an order (`price/qty` accept human or `ChainInt`) |
| `cancel_order(order_id, market)` | Cancel a specific order |
| `cancel_all_orders(market)` | Cancel all open orders |
| `settle_balance(market)` | Settle filled order proceeds |
| `actions_for(market)` | Build typed market actions with fluent helpers |
| `batch_actions(actions)` | Submit typed action batch (`MarketActions` or `MarketActionGroup`) |
| `get_markets()` / `get_market(pair)` | Fetch market info |
| `get_depth(market)` / `get_trades(market)` | Order book and trade data |
| `get_balances(account)` / `get_orders(account, market)` | Account data |
| `stream_depth(market)` | Real-time order book stream |
| `stream_orders(account)` / `stream_trades(market)` | Real-time updates |
| `withdraw(owner, asset, amount)` | Withdraw funds |

See [AGENTS.md](AGENTS.md) for the complete API reference with all parameters and types.

## Guides

- [`docs/guides/identifiers.rst`](docs/guides/identifiers.rst)
- [`docs/guides/trading.rst`](docs/guides/trading.rst)
- [`docs/guides/market_data.rst`](docs/guides/market_data.rst)
- [`docs/guides/websocket_streams.rst`](docs/guides/websocket_streams.rst)
- [`docs/guides/error_handling.rst`](docs/guides/error_handling.rst)
- [`docs/guides/external_signers.rst`](docs/guides/external_signers.rst)

## Examples

| Example | Description |
|---------|-------------|
| [`quickstart.py`](examples/quickstart.py) | Connect, create a wallet, place your first order |
| [`market_maker.py`](examples/market_maker.py) | Two-sided quoting loop with cancel/replace |
| [`taker_bot.py`](examples/taker_bot.py) | Monitor depth and take liquidity |
| [`portfolio.py`](examples/portfolio.py) | Multi-market balance tracking and management |

Run an example:

```bash
python examples/quickstart.py
```

## Testing

Unit tests (no network required):

```bash
pytest tests/ -m "not integration" -v
```

Integration tests (requires `O2_PRIVATE_KEY` env var):

```bash
O2_PRIVATE_KEY=0x... pytest tests/test_integration.py -m integration -v --timeout=120
```

Integration tests reuse cached wallets in `sdks/python/.integration-wallets.json` (gitignored)
and only faucet when balances are below a conservative threshold, which improves repeat-run speed.

## AI Agent Integration

See [AGENTS.md](AGENTS.md) for an LLM-optimized reference covering all methods, types, error codes, and common patterns.
