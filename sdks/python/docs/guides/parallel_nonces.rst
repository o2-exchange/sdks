Parallel Nonces Guide
=====================

Every action a session submits carries a nonce that the trade-account contract
checks. By default that nonce is a single monotonic ``u64``, so submissions
serialize: the second request cannot be signed until the first has landed and
the nonce has advanced. For a market maker refreshing quotes, that ceiling is
the loop time.

Parallel nonces remove it. A parallel-capable trade account keeps a sliding
window of 8 words x 128 bits = **1024 concurrent nonce slots** per lane, and
**5 independent lanes** (``nonce_session_id`` 0 to 4) per account. Any free bit
in the window is a valid nonce, so many actions can be in flight at once with no
serialization, no rollback and no manual retry.


Quick start
-----------

.. code-block:: python

   import asyncio
   from o2_sdk import O2Client, Network, OrderSide

   async def main():
       client = O2Client(network=Network.MAINNET)
       owner = client.load_wallet("0x...")

       # Opens a parallel session AND proves the account can use it.
       session = await client.ensure_parallel_session(
           owner=owner, markets=["FUEL/USDC"]
       )

       # Concurrent from here on. No nonce argument, ever.
       await asyncio.gather(*[
           client.create_order("FUEL/USDC", OrderSide.BUY, 0.02, 100.0, session=session)
           for _ in range(10)
       ])
       await client.close()

   asyncio.run(main())

Once the session exists, parallel nonces are an invariant rather than a mode:
:meth:`~o2_sdk.client.O2Client.batch_actions` draws a fresh slot per submission
internally. The only knobs are set at session creation.


Capability cannot be read, only probed
--------------------------------------

.. important::

   There is **no read-only signal** for whether a trade account supports
   parallel nonces. Do not gate on a version field. Probe.

An account only supports parallel nonces if its proxy targets an
implementation that has the parallel entry points. Nothing the API exposes
reports that target. In particular ``sync_state``, surfaced as
:attr:`~o2_sdk.models.TradeAccount.sync_generation`, describes the shape of the
record the *indexer* holds, not the deployed contract: on mainnet every synced
account reports ``V3``, including legacy accounts that were never upgraded and
whose parallel submissions revert on every call.

Gating on that field is a trap with a specific failure signature. The gate reads
"already capable", the session is created on the parallel track, and then every
order reverts, forever, with the FuelVM dispatcher's selector-mismatch revert
(``Revert(123)``, sway-core's ``MISMATCHED_SELECTOR_REVERT_CODE``) because the
deployed contract has no such method. Worse, a version-gated
``upgrade_account`` refuses to act on exactly those accounts, so the one
operation that would fix the problem is the one the gate blocks.

The working detector is to submit something and look at what comes back:

.. code-block:: python

   session = await client.create_session(
       owner=owner, markets=["FUEL/USDC"], nonce_strategy="parallel"
   )
   if not await client.probe_parallel_support(session, "FUEL/USDC"):
       await client.upgrade_account(owner)   # unconditional, waits for confirmation
       session = await client.create_session(
           owner=owner, markets=["FUEL/USDC"], nonce_strategy="parallel"
       )

:meth:`~o2_sdk.client.O2Client.ensure_parallel_session` is that sequence,
including the re-probe afterwards. Prefer it.

The probe is a ``settle_balance``: a documented no-op when there is nothing to
sweep, touching no market, placing no order and locking no funds, and every real
order op already carries one. Any failure *other* than the selector mismatch is
logged and treated as capable, because it would hit a real order identically and
the probe should neither mask it nor stand in the way.

To classify the revert yourself, use
:func:`~o2_sdk.onchain_revert.is_selector_mismatch_revert`. It searches the
message, the augmented and raw reasons, and the receipts, so it works on an
error however it reached you.


Upgrading an account
--------------------

:meth:`~o2_sdk.client.O2Client.upgrade_account` points the account's proxy at
the current implementation using the non-typed owner-signature flow, which is
required for proxies created before typed signatures and accepted by newer ones.
It is deliberately unconditional: a gate here would either be wrong or refuse to
act on the accounts that need it. Re-upgrading a current account is a no-op on
chain and costs one transaction.

The upgrade is an on-chain owner action and no endpoint reports the new proxy
target, so confirmation means watching the owner's sequential nonce advance.
``upgrade_account`` does that before returning; pass ``wait=False`` to skip it.

Upgrades run on the **sequential** track. A parallel nonce cannot be used
against an account that does not yet understand parallel nonces.


Lanes, and one session per account
----------------------------------

An account has 5 independent nonce lanes, and a session draws from exactly one
of them, chosen with ``nonce_session_id``. Lanes exist so that submitters who
cannot coordinate a shared cursor do not contend for the same window slots.

.. warning::

   Lanes do **not** let you register more than one session. The contract holds
   **one registered session per account**: anything that registers another
   session for the same account, including a redeployment whose outgoing
   process is still working, invalidates the earlier one, and every action
   signed with the stale session then reverts until a new session is created.
   Recognize this with :func:`~o2_sdk.nonce.is_session_error`. It is a session
   problem, not a nonce problem, and resyncing the window will not help.

So a second lane is for a second *submitter of the same session*, not a second
session:

.. code-block:: python

   # Registered once, for the account.
   session = await client.ensure_parallel_session(
       owner=owner, markets=["FUEL/USDC"], nonce_session_id=0
   )

Give each account its own owner key and its own session. If a process must run
alongside a bot on the same account, hand it the same ``SessionInfo`` (via
:meth:`~o2_sdk.client.O2Client.set_session`) rather than creating its own, and
give it a manager on a different lane if it will not share the bot's cursor.


Window management
-----------------

:class:`~o2_sdk.nonce.ParallelNonceManager` issues nonces from a local cursor.
``next_nonce()`` is synchronous, thread-safe and does no I/O, so it is safe to
call from worker threads.

The cursor is seated past the **highest consumed bit** in the window rather than
at the first free hole. A hole can belong to an earlier run of the same lane
whose later positions already landed on chain, so starting inside one would mint
already-used nonces. Wasting holes is cheap; colliding is not.

Burnt slots (issued but never submitted) are fine. If submissions outrun the
chain window, the API rejects the nonce as out of window and
:meth:`~o2_sdk.client.O2Client.batch_actions` resyncs the cursor from chain once
and retries. :func:`~o2_sdk.nonce.is_parallel_nonce_out_of_window` recognizes
that class of error if you need to handle it yourself.

Each nonce carries an expiry, ``DEFAULT_NONCE_TTL_SECS`` (120s) past issue,
matching the contract's expiry check.
