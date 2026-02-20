# Identifiers and Wallet Types

This guide explains when to use Fuel-native vs EVM wallets, and how identifiers
map to O2 API/SDK calls.

## Wallet Choice

- **Fuel-native wallet**: best when you want interoperability with other Fuel ecosystem apps.
- **EVM wallet**: best when you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

## Owner Identity Rule

O2 owner identity is always **Fuel B256** (`0x` + 64 hex chars).

- Fuel-native wallets provide `b256Address` directly.
- EVM wallets provide:
  - `evmAddress` (`0x` + 40 hex chars)
  - `b256Address` (`0x` + 64 hex chars)

For EVM wallets:

```text
owner_b256 = 0x000000000000000000000000 + evmAddress.slice(2)
```

So `evmAddress` is not passed directly as O2 `ownerId`; `b256Address` is.

## `ownerId` vs `tradeAccountId`

`ownerId` and `tradeAccountId` are intentionally different:

- **`ownerId`**:
  - Wallet identity (B256) for ownership/authentication.
  - Stable for a given wallet.
  - Used by setup/session/owner-scoped APIs.
- **`tradeAccountId`**:
  - Trading account contract ID that actually holds exchange balances/positions.
  - Produced by account setup and stored in the session.
  - Used by account-state APIs such as balances/orders.

Think of it as: owner identity (`ownerId`) controls an on-exchange account (`tradeAccountId`).

## Which Identifier Goes Where

- **Account/session owner lookups**: owner `b256Address`
- **Trading account state**: `tradeAccountId` (contract ID)
- **Market selection**: pair string (`"fFUEL/fUSDC"`) or `market_id`
- **EVM display/bridge context**: `evmAddress`

## Example

```ts
const evmWallet = O2Client.generateEvmWallet();
console.log(evmWallet.evmAddress);   // 20-byte Ethereum address
console.log(evmWallet.b256Address);  // 32-byte Fuel owner identity (zero-left-padded)

await client.setupAccount(evmWallet);   // uses b256Address as ownerId
await client.createSession(evmWallet, ["fFUEL/fUSDC"]);
```
