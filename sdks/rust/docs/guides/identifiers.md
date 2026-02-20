# Identifiers and Wallet Types

This guide explains when to use Fuel-native vs EVM wallets, and how identifiers
map to O2 API/SDK calls.

## Wallet Choice

- **Fuel-native wallet**: best when you want interoperability with other Fuel ecosystem apps.
- **EVM wallet**: best when you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

## Owner Identity Rule

O2 owner identity is always **Fuel B256** (`0x` + 64 hex chars).

- Fuel-native wallets expose B256 directly.
- EVM wallets expose both EVM and B256 forms.

For EVM wallets:

```text
owner_b256 = 0x000000000000000000000000 + evm_address[2:]
```

So the EVM address is not passed directly as O2 owner identity; the padded B256 form is.

## Which Identifier Goes Where

- **Account/session owner lookups**: owner B256
- **Trading account state**: `trade_account_id` (contract ID)
- **Market selection**: pair string (`"fFUEL/fUSDC"`) or `market_id`
- **EVM display/bridge context**: `evm_address`

## Example

```rust,ignore
let evm_wallet = client.generate_evm_wallet()?;
println!("evm={}", o2_sdk::crypto::to_hex_string(&evm_wallet.evm_address));
println!("b256={}", o2_sdk::crypto::to_hex_string(&evm_wallet.b256_address));

client.setup_account(&evm_wallet).await?; // uses b256 owner identity
client
    .create_session(
        &evm_wallet,
        &["fFUEL/fUSDC"],
        std::time::Duration::from_secs(30 * 24 * 3600),
    )
    .await?;
```
