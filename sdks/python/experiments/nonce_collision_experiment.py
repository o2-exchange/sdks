"""Does resyncing the cursor on an already-used nonce reduce collisions, or cause them?

Not part of the package. Run it directly; it prints numbers and asserts nothing.

WHY THIS EXISTS
---------------
sdks#59 made ``batch_actions`` reseat the nonce cursor from chain when the venue
rejects a nonce as already used. That was reasoned about, not measured. An
attempt to measure it from fleet logs failed: the collision rate is dominated by
deploy rollovers (947 rejections during one rollout, 660 during the rollback),
which swamped any effect of the code and produced a confident wrong answer in
both directions.

So measure it in isolation instead.

DESIGN
------
The production trigger is two submitters sharing one nonce lane, which is what a
rolling deploy creates. Reproduce that directly: two ``ParallelNonceManager``
instances seeded from the same window, on the same account and the same lane,
submitting concurrently. Both mint from their own local cursor, so they collide
by construction.

Two arms, differing in exactly one behaviour:

* ``resync``   - the cursor is reseated from chain on an already-used rejection
                 (sdks#59 as written)
* ``noresync`` - the rejection is raised without reseating; each cursor simply
                 keeps advancing

The competing predictions are sharp. Reseating asks the chain for "the position
after the highest consumed bit", and BOTH managers get the same answer, so
resync may make them converge on one slot and collide more. Not reseating lets
each cursor run forward independently, so they may drift apart on their own.

ARMS ARE INTERLEAVED (A,B,A,B...), not run back to back. Testnet conditions move
on a timescale of minutes, and a sequential A-then-B comparison silently
attributes that drift to the change. That mistake is the reason this file
exists.

The submitted action is ``settle_balance``: a documented no-op when there is
nothing to sweep, so the experiment places no orders and leaves no book state.

USAGE
-----
    /tmp/o2-test-env/bin/python experiments/nonce_collision_experiment.py
    /tmp/o2-test-env/bin/python experiments/nonce_collision_experiment.py --rounds 6 --ops 30
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from o2_sdk import Network, O2Client, O2Error
from o2_sdk.nonce import (
    ParallelNonceManager,
    WindowResponse,
    is_parallel_nonce_already_used,
    is_parallel_nonce_out_of_window,
)

WALLET_CACHE = Path(__file__).resolve().parents[1] / ".integration-wallets.json"
WALLET_ROLE = "parallel_test_tn"


class InstrumentedManager(ParallelNonceManager):
    """A manager that counts resyncs, and can be told not to perform them.

    ``resync_enabled=False`` is the control arm: the call still happens on the
    same code path and is still counted, it just does not reseat the cursor. So
    the arms differ in the reseat itself and nothing else.
    """

    def __init__(self, *args, resync_enabled: bool = True, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.resync_enabled = resync_enabled
        self.resync_calls = 0

    async def resync_from_chain(self, seen_generation: int | None = None) -> None:
        self.resync_calls += 1
        if not self.resync_enabled:
            return
        await super().resync_from_chain(seen_generation)


def _load_wallet(client: O2Client):
    if not WALLET_CACHE.exists():
        raise SystemExit(f"no wallet cache at {WALLET_CACHE}; run the integration tests once first")
    data = json.loads(WALLET_CACHE.read_text())
    pk = data.get(WALLET_ROLE)
    if not pk:
        raise SystemExit(f"wallet role {WALLET_ROLE!r} missing from {WALLET_CACHE}")
    return client.load_wallet(pk)


async def _build_managers(client, trade_account_id, lane, resync_enabled):
    """Two managers on ONE lane, each seeded from the same window.

    Same account, same lane, independent cursors: the topology a rolling deploy
    produces, and the only way to make collisions happen on demand.
    """

    async def fetch() -> WindowResponse:
        return WindowResponse.from_dict(await client.api.get_account_window(trade_account_id, lane))

    managers = []
    for _ in range(2):
        m = InstrumentedManager(
            window_fetcher=fetch, nonce_session_id=lane, resync_enabled=resync_enabled
        )
        await m.init()
        managers.append(m)
    return managers


SAMPLES: dict[str, str] = {}


def _classify(exc: BaseException) -> str:
    """Bucket a failure by CAUSE, not by which layer happened to catch it.

    An already-used slot surfaces two different ways, and conflating them with
    two different buckets makes the arms look different when they are not:

    * API layer - "Parallel nonce is not usable: nonce already used". The
      indexed window already knows the slot is gone, so nothing is submitted.
    * On chain  - the indexed window still shows the slot free (the indexer
      lags), so the transaction IS submitted and the contract reverts with
      NonceError::AlreadyUsed (REVERT_WITH_LOG, logged variant "AlreadyUsed").

    Both mean the same thing happened to the cursor. They are counted
    separately because the split between them is itself interesting, and summed
    for the comparison.
    """
    if is_parallel_nonce_already_used(exc):
        return "already_used_api"
    raw_all = (
        " ".join(str(getattr(exc, a, "") or "") for a in ("message", "reason", "raw_reason"))
        + f" {exc}"
    )
    if "AlreadyUsed" in raw_all:
        return "already_used_chain"
    if is_parallel_nonce_out_of_window(exc):
        return "out_of_window"
    raw = f"{getattr(exc, 'message', '')} | {getattr(exc, 'reason', '')} | {exc}"
    text = raw.lower()
    if "rate limit" in text or "429" in text:
        return "rate_limited"  # ambient testnet noise, kept out of the comparison
    # An unexplained bucket would invalidate the comparison, so keep a sample.
    SAMPLES.setdefault("other", raw[:400])
    return "other"


async def _run_arm(client, session, market, managers, ops: int) -> Counter:
    """Fire `ops` submissions split across both managers, all concurrent."""
    sessions = []
    for m in managers:
        s = dataclasses.replace(session, nonce_manager=m)
        sessions.append(s)

    async def one(sess):
        try:
            await client.settle_balance(market, session=sess)
            return "ok"
        except O2Error as exc:
            return _classify(exc)
        except Exception as exc:
            return _classify(exc)

    tasks = [one(sessions[i % len(sessions)]) for i in range(ops)]
    return Counter(await asyncio.gather(*tasks))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=4, help="interleaved A/B rounds")
    ap.add_argument("--ops", type=int, default=20, help="concurrent submissions per arm per round")
    ap.add_argument("--lane", type=int, default=0)
    args = ap.parse_args()

    client = O2Client(network=Network.TESTNET)
    totals: dict[str, Counter] = {"resync": Counter(), "noresync": Counter()}
    resync_calls = {"resync": 0, "noresync": 0}

    try:
        wallet = _load_wallet(client)
        account = await client.api.get_account(owner=wallet.b256_address)
        if account.trade_account is None:
            raise SystemExit("test wallet has no trade account on testnet")
        market = (await client.get_markets())[0]

        # One registered session, shared by both arms and both managers. The
        # contract holds a single session per account, so creating more would
        # invalidate each other and measure the wrong thing entirely.
        session = await client.ensure_parallel_session(
            owner=wallet, markets=[market.pair], expiry_days=1, nonce_session_id=args.lane
        )
        print(
            f"market={market.pair} lane={args.lane} rounds={args.rounds} ops/arm/round={args.ops}\n"
        )

        for rnd in range(1, args.rounds + 1):
            # Interleaved, and the order flips each round so neither arm
            # systematically runs on the fresher window.
            arms = ["resync", "noresync"] if rnd % 2 else ["noresync", "resync"]
            for arm in arms:
                managers = await _build_managers(
                    client,
                    session.trade_account_id,
                    args.lane,
                    resync_enabled=(arm == "resync"),
                )
                counts = await _run_arm(client, session, market, managers, args.ops)
                totals[arm] += counts
                resync_calls[arm] += sum(m.resync_calls for m in managers)
                print(f"  round {rnd} {arm:9s} {dict(sorted(counts.items()))}")
        print()
    finally:
        await client.close()

    print("=" * 68)
    print(
        f"{'':12s}{'ok':>6s}{'used(api)':>11s}{'used(chain)':>13s}{'used(all)':>11s}"
        f"{'out_of_win':>12s}{'rate_lim':>10s}{'other':>7s}{'resyncs':>9s}"
    )
    for arm in ("resync", "noresync"):
        c = totals[arm]
        used = c["already_used_api"] + c["already_used_chain"]
        print(
            f"{arm:12s}{c['ok']:>6d}{c['already_used_api']:>11d}"
            f"{c['already_used_chain']:>13d}{used:>11d}{c['out_of_window']:>12d}"
            f"{c['rate_limited']:>10d}{c['other']:>7d}{resync_calls[arm]:>9d}"
        )

    a, b = totals["resync"], totals["noresync"]

    # Compare against attempts that actually reached nonce validation, so
    # ambient rate limiting cannot move the result.
    def rate(c):
        used = c["already_used_api"] + c["already_used_chain"]
        graded = c["ok"] + used + c["out_of_window"]
        return (used / graded * 100) if graded else float("nan")

    if SAMPLES.get("other"):
        print(f"\nsample 'other' error: {SAMPLES['other']}")
    print(f"\ncollision rate (api + chain)  resync={rate(a):.1f}%  noresync={rate(b):.1f}%")
    print(
        "(share of submissions that reached nonce validation; rate-limited and "
        "unclassified errors excluded)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
