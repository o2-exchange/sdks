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
const tier = await client.turbo.cheapestTier();
if (!tier) throw new Error("No Turbo tiers on sale here");

const account = await client.turbo.open({
  tierId: tier.tier_id,
  collateral: client.turbo.openingCost(tier),
  onProgress: (stage) => console.log(stage),
});
```

`tiers()` returns only what is actually **on sale** — `/v1/margin/tiers`
serves retired versions alongside live ones, and on testnet the first entry
is disabled, so `tiers()[0]` would open nothing. Pass
`{ includeDisabled: true }` if you need the history.

`openingCost()` is the collateral plus the premium: the entry *buys its
first term*, so `required_collateral` alone is not enough to open.

`period` is optional because a **prepaid** tier sells exactly one term — a
flat week on the deployed tiers — and the pool refuses any other. The SDK
reads it off the tier; passing one it does not sell throws before signing
rather than after.

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
round retires debt and the next round takes more. **When the funding clamps,
the order shrinks with it** — a full-size order behind a clamped funding leg
is the same custody revert one step later — so call `closePosition` again to
close the remainder.

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

## How a Turbo batch differs on the wire

Three things change when a batch executes as the margin **child** rather
than the parent, and all three are handled for you:

- **Owner** — a child is owned by the PARENT CONTRACT, not the wallet, so
  the batch is authorised under the parent's contract id. The backend
  refuses "the wallet's owner id" driving a child.
- **Nonce** — margin batches are accepted under a **parallel** nonce only,
  packed as a u256. The cursor is seeded from the chain's own window
  (`GET /v1/accounts/window`) rather than guessed: a position is burned
  whether or not the batch lands, and guessing fails two different ways —
  a spent position is "already used", a word the window has slid past is
  "out of sliding window". The window is re-read whenever the chain says
  the cursor has fallen outside it.
- **Signature** — a parallel nonce requires the `TypedSecp256k1` variant,
  whose digest prefixes the packed nonce as a full u256 instead of the
  sequential u64.

Ordinary spot batches are untouched by all of this. If a child has been
driven from somewhere else, `client.refreshAccountNonce(id)` re-reads its
counter.

## Take-profit and stop-loss

Protection rides the SAME signed batch as the position it protects, so
there is no window where the position exists and the stop does not:

```ts
await client.turbo.long("fETH/fUSDC", { notional: "2000" }, {
  takeProfit: { triggerPrice: "2600", slippageBps: 100 },
  stopLoss:   { triggerPrice: "2400", limitPrice: "2390" },
});
```

Legs inherit the position's size and take the closing side automatically.
Both must be **priced** — give `limitPrice` or `slippageBps`: a margin
account refuses an unbounded market trigger, because an unpriced order
cannot be walked for risk. Spot has no such restriction.

Editing TP/SL on an unfilled resting order is not supported for margin
accounts (it is not in the frontend either); cancel and replace instead.

## Known gap

`closeAccount()` now cancels resting orders, flattens open positions,
retires in-kind debts and settles `drawn_quote` before closing, and that
sequence closes an ordinary account cleanly.

What it cannot do is conjure funds. An account whose draw is tied up in a
position it cannot afford to buy back has no self-serve exit —
`ReturnQuote` needs cash it does not hold, and `RepayFromCollateral` needs
collateral the line already converted. **Add margin first**, then close:

```ts
await client.turbo.addMargin(30_000_000_000n);
await client.turbo.closeAccount();
```

The rejection says so explicitly rather than leaving you to work it out.

## Units

Everything is **raw**. Quantities are in their asset's base units, prices are
1e18-scaled as the oracle serves them, and every collateral-denominated
figure is in the collateral asset's base units — whose scale is
`collateral_decimals` on the state wire, served rather than inferred because
it is per-deployment.

`long`/`short` accept human decimal strings and scale them for you; the read
methods return raw `bigint`s.
