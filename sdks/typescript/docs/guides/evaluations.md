# Evaluation Accounts

Buy evaluations with a mainnet client. Use `Network.TESTNET` and testnet funds
to test purchases. Trade on the resulting evaluation account with `Network.EVAL`,
which connects to `api.eval.o2.app` on Fuel testnet and has no faucet.

```ts
import { type AssetId, Network, O2Client, type Signer } from "@o2exchange/sdk";

async function buyEvaluation(
  wallet: Signer,
  tierId: bigint,
  paymentAsset: AssetId,
  amount: bigint,
) {
  const checkout = new O2Client({ network: Network.MAINNET });
  try {
    const { eval_shop_id: shopId } = await checkout.api.getMarkets();
    if (!shopId) throw new Error("Evaluation purchases are unavailable");
    await checkout.setupAccount(wallet);
    await checkout.createSession(wallet, [], { extraContractIds: [shopId] });
    return await checkout.buyEvalAccount(tierId, paymentAsset, amount);
  } finally {
    checkout.close();
  }
}

const trading = new O2Client({ network: Network.EVAL });
```

Pass the shop tier ID, payment asset ID and exact price as a bigint in token base
units. The SDK does not fetch prices or convert human amounts. Your trading
account pays for the evaluation; the API pays gas. Include the shop ID in
`extraContractIds` when creating the session.

The result uses the standard session-action response, including transaction
errors. Confirm the transaction before checking whether your account is ready.
Do not retry a purchase blindly after a timeout: it may have succeeded.

## Rules and Progress

`client.api.getMarginTiers()` returns `eval_profit_target_bps` and
`daily_loss_limit_bps`, in basis points of the credit line.
`client.turbo.state()` also returns `session.eval_profit_target_bps`, the current
target for the session's tier version, including policy updates. These fields
are decimal strings or null and may be missing on older APIs. Null disables
the rule; `"0"` sets a breakeven target or allows no daily loss.

Use `client.turbo.state()`, `client.turbo.snapshot()` and
`client.turbo.positions()` to read account state, valuation and positions.
The SDK does not yet fetch product prices, pass status or the daily baseline
needed to calculate remaining daily loss. NAV alone does not confirm a pass.
The backend enforces rules, opens purchased accounts and awards funded accounts.

## Closing Positions

Closing 100% of a position can leave rounding dust. Check remaining balances,
debts and open orders, including triggers, before expecting a pass. Closing the
session is a separate action from closing positions. The backend confirms passes.
