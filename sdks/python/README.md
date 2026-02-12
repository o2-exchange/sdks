<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="80" alt="O2 Exchange">
</p>

<h1 align="center">O2 SDK for Python</h1>

<p align="center">
  <a href="https://github.com/o2-exchange/contracts/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/contracts/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
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

```python
import logging
import asyncio
from o2_sdk import O2Client, Network

async def main():
    logging.basicConfig(level=logging.DEBUG)
    client = O2Client(network=Network.TESTNET)
    owner = client.generate_wallet()
    account = await client.setup_account(owner)
    session = await client.create_session(owner=owner, markets=["fFUEL/fUSDC"])
    result = await client.create_order(session, "fFUEL/fUSDC", "Buy", price=0.02, quantity=100.0)
    print(f"Created order with transaction ID {result.tx_id}")
    await client.close()

asyncio.run(main())
```

## Features

- **Trading** — Place, cancel, and manage orders with automatic price/quantity scaling
- **Market Data** — Fetch order book depth, recent trades, OHLCV candles, and ticker data
- **WebSocket Streams** — Real-time depth, order, trade, balance, and nonce updates via `async for`
- **Wallet Support** — Fuel-native and EVM wallets with session-based signing
- **Batch Actions** — Submit up to 5 actions per request (cancel + settle + create in one call)
- **Error Handling** — Typed exceptions (`O2Error`, `InvalidSignature`, `RateLimitExceeded`, etc.)

## API Overview

| Method | Description |
|--------|-------------|
| `generate_wallet()` / `load_wallet(pk)` | Create or load a Fuel wallet |
| `generate_evm_wallet()` / `load_evm_wallet(pk)` | Create or load an EVM wallet |
| `setup_account(wallet)` | Idempotent account setup (create + fund + whitelist) |
| `create_session(owner, markets)` | Create a trading session |
| `create_order(session, market, side, price, qty)` | Place an order |
| `cancel_order(session, order_id, market)` | Cancel a specific order |
| `cancel_all_orders(session, market)` | Cancel all open orders |
| `settle_balance(session, market)` | Settle filled order proceeds |
| `batch_actions(session, actions)` | Submit raw action batch |
| `get_markets()` / `get_market(pair)` | Fetch market info |
| `get_depth(market)` / `get_trades(market)` | Order book and trade data |
| `get_balances(account)` / `get_orders(account, market)` | Account data |
| `stream_depth(market)` | Real-time order book stream |
| `stream_orders(account)` / `stream_trades(market)` | Real-time updates |
| `withdraw(owner, asset, amount)` | Withdraw funds |

See [AGENTS.md](AGENTS.md) for the complete API reference with all parameters and types.

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

## AI Agent Integration

See [AGENTS.md](AGENTS.md) for an LLM-optimized reference covering all methods, types, error codes, and common patterns.
