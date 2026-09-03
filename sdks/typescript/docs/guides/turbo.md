# Turbo (Margin) Trading

A **Turbo account** trades on a credit line instead of its own cash. It is a
margin *child* of your ordinary trade account: you post collateral once, the
pool issues a line against it, and you trade that line.

The one thing to internalise: **a Turbo account holds no money.** The
collateral went to the pool at `start_session`, so an order that forwarded
coins from the account would find none there. Every trade therefore carries a
funding leg in the same signed batch as the order:

| You want to | The batch actually does |
|---|---|
| Go **long** | sweep the book → `Draw` quote against the line → **buy** |
| Go **short** | sweep the book → `Borrow` the asset in kind → **sell** |

`client.turbo` composes those for you. You say `long` or `short`.

---

## Setup

```ts
import { Network, O2Client } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = O2Client.generateWallet();

await client.setupAccount(wallet);
await client.createSession(wallet, ["fETH/fUSDC"], { turbo: true });
```

### `turbo: true` is not optional

The trade account checks every call's target against the session's
`contract_ids`, and a margin action targets the **pool**, the **margin
child**, or the **registry** — none of which is a market. Without them in
scope the first Turbo action fails with `MarginAccountNotInSessionScope`.

That scope is part of what the wallet signed, so **it cannot be widened
afterwards**. A session created without `turbo: true` can do nothing with a
Turbo account, and the only repair is a new session — a fresh wallet
signature. The flag also scopes the next few accounts you *could* open, so
one signature covers opening a second and third: a child's id is a pure
function of `(oracle, parent, index)`, which is what makes signing for an
account that does not exist yet possible at all.

---

## Opening an account

```ts
const tiers = await client.turbo.tiers();
const tier = tiers[0];

// The entry buys its first term, so it costs the tier's collateral plus
// `open_fee + prolong_fee[period]`.
const collateral =
  BigInt(tier.required_collateral) + BigInt(tier.open_fee) + BigInt(tier.prolong_fee[3]);

const account = await client.turbo.open({
  tierId: tier.tier_id,
  collateral,
  period: "Month",
  onProgress: (stage) => console.log(stage),
});
```

Opening is **two submissions with a wait between them**, and they cannot be
merged: the backend requires the child *absent* from storage to register it
and *present* to start a session on it, and storage only learns of it once
the on-chain registration event is indexed. Hence `onProgress` — otherwise
this reads as a hung call for up to a minute.

Neither submission costs a wallet prompt. Every margin action is
session-signed.

If a previous run registered an account but never started a session on it,
`open()` **adopts** that account rather than registering a new one. A
registered-but-unstarted account is invisible to every Turbo surface (they
key off a live session), so registering again would strand it forever.

---

## Trading

Size by base quantity or by collateral notional:

```ts
await client.turbo.long("fETH/fUSDC", { notional: "2000" });
await client.turbo.long("fETH/fUSDC", { quantity: "0.5" }, { price: "2000" });
await client.turbo.short("fETH/fUSDC", { quantity: "0.5" });
```

Omit `price` and the book's own top on the side you are taking is used. A
price is needed even for a market order, because the **escrow** the order
forwards is priced from it and the funding leg must cover that escrow
exactly.

### Opens refuse; closes clamp

An opening trade that the line cannot fully fund **throws before signing**
rather than submitting a short funding leg. There is no second round on an
open — an under-funded leg behind a full-size order is a custody revert with
extra steps, discovered after you signed.

`closePosition` clamps instead, because a close *loops*: taking less this
round retires debt and the next round takes more.

### What is shortable

Shorting borrows from the pool, so it needs all three of:

- the **tier** to list the asset (`tier.assets`),
- the **pool** to actually hold some (a line is permission to borrow, not a
  promise the coins exist), and
- the **loan cap** to have room.

`maxSell(assetId)` answers all three at once. Everything else is long-only.
The collateral asset itself is never shortable — it is drawn, not borrowed.

---

## Closing

```ts
await client.turbo.closePosition("fETH/fUSDC");
await client.turbo.repayDrawn();
```

`closePosition` submits the closing order. Retiring the debt behind it is a
**separate step**, because the fill is not known at signing time.

`repayDrawn()` has two routes and the difference matters:

- **`ReturnQuote`** (default) pays the draw back with cash the account
  holds.
- **`repayDrawn(amount, { fromCollateral: true })`** nets it against your own
  posted collateral and moves no coins at all. This is the only exit for a
  position that moved against you — you cannot return quote you no longer
  have, and a clean close demands `drawn_quote == 0`.

```ts
await client.turbo.repayDrawn(undefined, { fromCollateral: true });
await client.turbo.closeAccount();
```

A clean close needs no in-kind debts and no drawn quote. Positions are swept
**in kind** rather than sold, so leaving never forces a market exit.

---

## Reading the account

```ts
const snapshot = await client.turbo.snapshot();
// creditLine, equity, availableToTrade, secondsRemaining, frozen, liquidatable

const positions = await client.turbo.positions(); // negative quantity = short
const limits = await client.turbo.limits();       // the full gate stack
```

`frozen` and `liquidatable` are **not** terminal states:

- `frozen` — close-only. The pool admits no new exposure, but closes,
  repays and cancels still work. **Add margin here.**
- `liquidatable` — keeper-eligible, still recoverable.

A genuinely liquidated session leaves no `session` on the wire at all.

`secondsRemaining` is computed from the **server's** clock (`wire.now`),
never the client's.

---

## Managing

```ts
await client.turbo.addMargin(100_000000n);  // straight to the pool
await client.turbo.extend("Week", 2);        // buy more session life
await client.turbo.setAutoExtend("Week");    // or let it renew itself
await client.turbo.claim(assetId, amount);   // withdraw to the parent
```

---

## Referrals

```ts
const { code } = await client.turbo.referral.mintCode();       // idempotent
await client.turbo.referral.activate("SOMECODE");
const status = await client.turbo.referral.status();
```

Both writes are signed with your session key. That is not ceremony:
activation is **permanent** and first-code-wins, so an unauthenticated
endpoint would let anyone bind any wallet to their own code forever. The code
travels *inside* the signed payload for the same reason — beside it, anything
in between could swap it.

**Gate any discounted purchase on `status.discount_active`**, never on the
activation call merely succeeding. Until the on-chain grant lands the
discount does not exist.

---

## Units

Everything is **raw**. Quantities are in their asset's base units, prices are
1e18-scaled as the oracle serves them, and every collateral-denominated
figure is in the collateral asset's base units — whose scale is
`collateral_decimals` on the state wire, served rather than inferred because
it is per-deployment.

`long`/`short` accept human decimal strings and scale them for you; the read
methods return raw `bigint`s.
