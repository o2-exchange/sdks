# Evaluation Accounts

Buy evaluations with a mainnet client. For test purchases, use `Network::Testnet`
and testnet funds. Discover the shop and authorize it when creating a session:

```rust,no_run
use o2_sdk::{AssetId, Network, O2Client, O2Error, SignableWallet};
use std::time::Duration;

async fn buy_evaluation(
    owner: &impl SignableWallet,
    tier_id: u64,
    asset_id: &AssetId,
    amount: u64,
) -> Result<o2_sdk::SessionActionsResponse, O2Error> {
    let mut client = O2Client::new(Network::Mainnet);
    let shop_id = client.fetch_markets().await?.eval_shop_id.clone()
        .ok_or_else(|| O2Error::Other("Evaluation purchases are unavailable".into()))?;
    client.setup_account(owner).await?;
    let mut session = client.create_session_with_contracts(
        owner,
        &[] as &[&str],
        Duration::from_secs(3600),
        &[shop_id],
    ).await?;
    client.buy_eval_account(&mut session, tier_id, asset_id, amount).await
}
```

Pass the payment asset's full 32-byte hex ID and the exact price in token base
units. Both tier and amount use `u64`. The SDK does not fetch product prices or
convert human amounts. Your trading account pays for the evaluation; the API
pays gas. Check the returned action response and confirm the transaction before
expecting the purchased account to be available. Reconcile a timeout or
connection failure before submitting another purchase.

`create_session_with_contracts` takes a relative TTL. Use
`create_session_until_with_contracts` for an absolute expiry. Both append extra
contracts to the markets' contracts and deduplicate the extras by their bytes.
Existing `create_session` and `create_session_until` calls retain their signatures.

## Network and trading scope

`Network::Eval` connects to `https://api.eval.o2.app` and
`wss://api.eval.o2.app/v1/ws` using Fuel testnet RPC. It has no faucet.
Purchases use mainnet (or testnet for testing), separately from the eval network.

Rust currently supports purchases and eval network configuration. The Turbo
account lifecycle, margin trading, positions, valuation and rule helpers remain
available in the TypeScript SDK. Configuring `Network::Eval` alone does not
provide those helpers. The backend enforces evaluation rules and confirms passes.
