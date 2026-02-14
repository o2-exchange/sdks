# Quick Start

This guide walks you through the five steps needed to place your first trade
on the O2 Exchange using the TypeScript SDK.

> For background on how the O2 Exchange works, see the
> [O2 Exchange documentation](https://docs.o2.app).

## Step 1: Initialize the Client

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
```

The client connects to the O2 testnet by default. Pass `Network.MAINNET`
for production trading. You can also provide a custom `NetworkConfig`
for private deployments:

```ts
const client = new O2Client({
  config: {
    apiBase: "https://my-gateway.example.com",
    wsUrl: "wss://my-gateway.example.com/v1/ws",
    fuelRpc: "https://mainnet.fuel.network/v1/graphql",
    faucetUrl: null,
  },
});
```

## Step 2: Create a Wallet

Wallet creation is a static method — no client instance needed:

```ts
// Fuel-native wallet
const wallet = O2Client.generateWallet();
console.log(wallet.b256Address); // 0x-prefixed, 66-character hex

// — or load an existing private key —
const loaded = O2Client.loadWallet("0xabcd...1234");
```

The SDK supports both Fuel-native wallets and EVM-compatible wallets:

```ts
// EVM wallet (Ethereum-style address, zero-padded for Fuel)
const evmWallet = O2Client.generateEvmWallet();
console.log(evmWallet.evmAddress);   // 0x-prefixed, 42-character hex
console.log(evmWallet.b256Address);  // zero-padded to 32 bytes
```

> **Warning:** Never hard-code private keys in source code. Use environment
> variables or a secrets manager for production deployments.

## Step 3: Set Up a Trading Account

```ts
const { tradeAccountId } = await client.setupAccount(wallet);
console.log(tradeAccountId);
```

`setupAccount` is **idempotent** — it is safe to call on every bot startup.
It performs the following steps automatically:

1. Checks whether an account already exists for the wallet address
2. Creates a new trading account if needed
3. Mints test tokens via the faucet (testnet/devnet only)
4. Whitelists the account for trading

## Step 4: Create a Trading Session

```ts
await client.createSession(
  wallet,
  ["fFUEL/fUSDC"],
  30, // expiry in days (default)
);
```

The trade account ID is resolved automatically from the wallet address.
The session is **stored on the client** and used implicitly by all trading
methods. A **session** delegates signing authority from your owner wallet to a
temporary session key. This allows the SDK to sign trade actions without
needing the owner key for every request. Sessions are scoped to specific
markets and expire after the specified number of days.

To restore a previously serialized session (e.g., from a database or file),
use `setSession()`:

```ts
client.setSession(deserializedSession);
```

## Step 5: Place an Order

Prices and quantities accept dual-mode `Numeric` values:
- **`string`** — human-readable decimal (e.g., `"0.02"`, `"100"`) — auto-scaled
- **`bigint`** — raw chain integer (e.g., `20000000n`) — pass-through

```ts
const response = await client.createOrder(
  "fFUEL/fUSDC",
  "buy",
  "0.02",   // price (human-readable string, auto-scaled)
  "100",    // quantity
);

if (response.success) {
  console.log(`Order placed! txId=${response.txId}`);
  if (response.orders) {
    console.log(`Order ID: ${response.orders[0].order_id}`);
  }
} else {
  console.log(`Failed: ${response.reason ?? response.message}`);
}
```

## Cleanup

Always close the client when done to release WebSocket connections:

```ts
client.close();
```

Or use `Symbol.asyncDispose` for automatic cleanup:

```ts
await using client = new O2Client({ network: Network.TESTNET });
// client.close() called automatically when scope exits
```

## Complete Example

```ts
import { O2Client, Network } from "@o2exchange/sdk";

async function main() {
  const client = new O2Client({ network: Network.TESTNET });

  // Wallet + account
  const wallet = O2Client.generateWallet();
  const { tradeAccountId } = await client.setupAccount(wallet);

  // Session (stored on client, tradeAccountId resolved from wallet)
  await client.createSession(wallet, ["fFUEL/fUSDC"]);

  // Place order (string prices, auto-scaled — session used implicitly)
  const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "100");
  if (response.success) {
    console.log(`txId=${response.txId}`);
  }

  // Check balances (fields are bigint)
  const balances = await client.getBalances(tradeAccountId);
  for (const [symbol, bal] of Object.entries(balances)) {
    console.log(`${symbol}: ${bal.trading_account_balance}`);
  }

  client.close();
}

main().catch(console.error);
```

## Next Steps

- **Trading Guide** — Order types, batch actions, cancel/replace patterns
- **Market Data** — Fetching depth, trades, candles, and ticker data
- **WebSocket Streams** — Real-time data with `for await`
- **Error Handling** — Error types and recovery patterns
