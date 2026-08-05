"""Unit tests for parallel-nonce capability detection, account upgrade, and the
``ensure_parallel_session`` startup path.

The behaviour under test exists because of a production failure mode: the SDK
originally decided whether an account could use parallel nonces by reading its
reported version, and that field says nothing about the deployed implementation.
Legacy mainnet accounts report V3 while every parallel submission reverts with
the dispatcher's selector mismatch. These tests pin the replacement: probe, and
let the probe drive the upgrade.
"""

from __future__ import annotations

import pytest

from o2_sdk import O2Client, O2Error
from o2_sdk.errors import OnChainRevert
from o2_sdk.models import AccountInfo, SessionInfo
from o2_sdk.nonce import ParallelNonce
from o2_sdk.onchain_revert import MISMATCHED_SELECTOR_REASON

OWNER = "0x" + "88" * 32
TRADE_ACCOUNT = "0x" + "66" * 32


class FakeOwner:
    """Minimal Signer: the upgrade path only needs an address and a signature."""

    b256_address = OWNER
    address_bytes = b"\x88" * 32

    def personal_sign(self, message: bytes) -> bytes:
        return b"\x99" * 64


def _account(nonce: int, sync_state: object = "None") -> AccountInfo:
    return AccountInfo.from_dict(
        {
            "trade_account_id": TRADE_ACCOUNT,
            "trade_account": {
                "nonce": str(nonce),
                "owner": {"Address": OWNER},
                "sync_state": sync_state,
            },
            "session": None,
        }
    )


def _session() -> SessionInfo:
    from o2_sdk.models import AddressIdentity

    return SessionInfo(
        session_id=AddressIdentity("0x" + "55" * 32),
        trade_account_id=TRADE_ACCOUNT,
        contract_ids=["0x" + "77" * 32],
        session_expiry="9999999999",
        session_private_key=b"\x01" * 32,
        owner_address=OWNER,
    )


def _selector_mismatch() -> OnChainRevert:
    return OnChainRevert(
        message="Failed to process transaction",
        reason=MISMATCHED_SELECTOR_REASON,
        receipts=None,
        raw_reason="transaction reverted: Revert(123)",
    )


def _no_upgrade_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse the owner-nonce poll so tests don't sleep for minutes."""
    monkeypatch.setattr("o2_sdk.client.UPGRADE_POLL_INTERVAL_SECS", 0.0)
    monkeypatch.setattr("o2_sdk.client.UPGRADE_POLL_ATTEMPTS", 3)


# ---------------------------------------------------------------------------
# probe_parallel_support
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_probe_reports_incapable_on_selector_mismatch(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()

    async def fake_settle(_market, session=None):
        raise _selector_mismatch()

    monkeypatch.setattr(client, "settle_balance", fake_settle)
    assert await client.probe_parallel_support(_session(), "FUEL/USDC") is False


@pytest.mark.asyncio
async def test_probe_reports_capable_on_success(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    session = _session()
    calls: list = []

    async def fake_settle(market, session=None):
        calls.append((market, session))

    monkeypatch.setattr(client, "settle_balance", fake_settle)
    assert await client.probe_parallel_support(session, "FUEL/USDC") is True
    # settle_balance is the benign probe: one call, on the session under test.
    assert calls == [("FUEL/USDC", session)]


@pytest.mark.asyncio
async def test_probe_does_not_block_on_unrelated_failures(monkeypatch: pytest.MonkeyPatch):
    """An unrelated failure (no balance, network blip) would hit a real order
    the same way. Reporting it as "not parallel-capable" would trigger a
    pointless account upgrade, so the probe passes it through as capable."""
    client = O2Client()

    async def fake_settle(_market, session=None):
        raise O2Error(message="Insufficient balance", code=1000)

    monkeypatch.setattr(client, "settle_balance", fake_settle)
    assert await client.probe_parallel_support(_session(), "FUEL/USDC") is True


# ---------------------------------------------------------------------------
# upgrade_account
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upgrade_account_is_not_gated_on_reported_version(
    monkeypatch: pytest.MonkeyPatch,
):
    """The regression this whole change exists for: an account reporting V3 that
    still needs upgrading must be upgraded, not skipped."""
    _no_upgrade_wait(monkeypatch)
    client = O2Client()
    nonces = iter([5, 6])
    sent: dict = {}

    async def fake_get_account(**_kwargs):
        return _account(next(nonces), {"V3": {"completed": 1, "started": 1}})

    async def fake_upgrade(owner_id: str, request: dict) -> dict:
        sent["owner_id"] = owner_id
        sent["request"] = request
        return {"tx_id": "0x" + "ab" * 32}

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    tx_id = await client.upgrade_account(FakeOwner())
    assert tx_id == "0x" + "ab" * 32
    assert sent["owner_id"] == OWNER
    assert sent["request"]["nonce"] == "5"
    assert sent["request"]["trade_account_id"] == TRADE_ACCOUNT


@pytest.mark.asyncio
async def test_upgrade_account_waits_for_owner_nonce_advance(
    monkeypatch: pytest.MonkeyPatch,
):
    """The owner nonce advancing is the only confirmation available; nothing
    reports the proxy target."""
    _no_upgrade_wait(monkeypatch)
    client = O2Client()
    # Submit reads nonce 5, then two polls still read 5 before it advances.
    nonces = iter([5, 5, 5, 6])

    async def fake_get_account(**_kwargs):
        return _account(next(nonces))

    async def fake_upgrade(_owner_id: str, _request: dict) -> dict:
        return {"tx_id": "0x" + "ab" * 32}

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    await client.upgrade_account(FakeOwner())
    assert next(nonces, None) is None  # every poll was consumed


@pytest.mark.asyncio
async def test_upgrade_account_raises_when_nonce_never_advances(
    monkeypatch: pytest.MonkeyPatch,
):
    _no_upgrade_wait(monkeypatch)
    client = O2Client()

    async def fake_get_account(**_kwargs):
        return _account(5)

    async def fake_upgrade(_owner_id: str, _request: dict) -> dict:
        return {"tx_id": "0x" + "ab" * 32}

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    with pytest.raises(O2Error, match="did not land"):
        await client.upgrade_account(FakeOwner())


@pytest.mark.asyncio
async def test_upgrade_account_can_skip_the_wait(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()

    async def fake_get_account(**_kwargs):
        return _account(5)

    async def fake_upgrade(_owner_id: str, _request: dict) -> dict:
        return {"tx_id": "0x" + "ab" * 32}

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    assert await client.upgrade_account(FakeOwner(), wait=False) == "0x" + "ab" * 32


# ---------------------------------------------------------------------------
# ensure_parallel_session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ensure_parallel_session_returns_first_session_when_capable(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    created: list = []
    upgrades: list = []

    async def fake_create_session(**kwargs):
        created.append(kwargs)
        return _session()

    async def fake_probe(_session, _market):
        return True

    async def fake_upgrade(_owner, **_kwargs):
        upgrades.append(True)

    monkeypatch.setattr(client, "create_session", fake_create_session)
    monkeypatch.setattr(client, "probe_parallel_support", fake_probe)
    monkeypatch.setattr(client, "upgrade_account", fake_upgrade)

    await client.ensure_parallel_session(FakeOwner(), ["FUEL/USDC"], nonce_session_id=2)
    assert len(created) == 1
    assert created[0]["nonce_strategy"] == "parallel"
    assert created[0]["nonce_session_id"] == 2
    assert not upgrades


@pytest.mark.asyncio
async def test_ensure_parallel_session_upgrades_then_recreates(
    monkeypatch: pytest.MonkeyPatch,
):
    """The full first-boot sequence for a legacy account: probe fails, upgrade,
    NEW session, probe passes. Re-creating the session matters because the first
    one was registered against the pre-upgrade implementation."""
    client = O2Client()
    created: list = []
    upgrades: list = []
    probes = iter([False, True])

    async def fake_create_session(**kwargs):
        created.append(kwargs)
        return _session()

    async def fake_probe(_session, _market):
        return next(probes)

    async def fake_upgrade(_owner, **_kwargs):
        upgrades.append(len(created))  # how many sessions existed at upgrade time

    monkeypatch.setattr(client, "create_session", fake_create_session)
    monkeypatch.setattr(client, "probe_parallel_support", fake_probe)
    monkeypatch.setattr(client, "upgrade_account", fake_upgrade)

    await client.ensure_parallel_session(FakeOwner(), ["FUEL/USDC"])
    assert len(created) == 2
    assert upgrades == [1]  # upgraded after the first session, before the second


@pytest.mark.asyncio
async def test_ensure_parallel_session_raises_if_still_incapable(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()

    async def fake_create_session(**_kwargs):
        return _session()

    async def fake_probe(_session, _market):
        return False

    async def fake_upgrade(_owner, **_kwargs):
        return "0x" + "ab" * 32  # an upgrade actually landed

    monkeypatch.setattr(client, "create_session", fake_create_session)
    monkeypatch.setattr(client, "probe_parallel_support", fake_probe)
    monkeypatch.setattr(client, "upgrade_account", fake_upgrade)

    with pytest.raises(O2Error, match="still revert"):
        await client.ensure_parallel_session(FakeOwner(), ["FUEL/USDC"])


@pytest.mark.asyncio
async def test_ensure_parallel_session_respects_auto_upgrade_false(
    monkeypatch: pytest.MonkeyPatch,
):
    """Callers whose owner key cannot upgrade the proxy need to hear about it
    rather than have a transaction submitted on their behalf."""
    client = O2Client()
    upgrades: list = []

    async def fake_create_session(**_kwargs):
        return _session()

    async def fake_probe(_session, _market):
        return False

    async def fake_upgrade(_owner, **_kwargs):
        upgrades.append(True)

    monkeypatch.setattr(client, "create_session", fake_create_session)
    monkeypatch.setattr(client, "probe_parallel_support", fake_probe)
    monkeypatch.setattr(client, "upgrade_account", fake_upgrade)

    with pytest.raises(O2Error, match="auto_upgrade is disabled"):
        await client.ensure_parallel_session(FakeOwner(), ["FUEL/USDC"], auto_upgrade=False)
    assert not upgrades


async def _fake_markets():
    from o2_sdk.models import MarketsResponse

    return MarketsResponse.from_dict(
        {
            "books_registry_id": "0x" + "11" * 32,
            "accounts_registry_id": "0x" + "22" * 32,
            "trade_account_oracle_id": "0x" + "33" * 32,
            "chain_id": "0x0000000000002699",
            "base_asset_id": "0x" + "44" * 32,
            "markets": [],
        }
    )


@pytest.mark.asyncio
async def test_ensure_parallel_session_requires_a_market():
    """The probe has to submit against something; failing here beats an
    IndexError deep in the startup path."""
    client = O2Client()
    with pytest.raises(O2Error, match="at least one market"):
        await client.ensure_parallel_session(FakeOwner(), [])


@pytest.mark.asyncio
async def test_code_based_revert_still_classifiable(monkeypatch: pytest.MonkeyPatch):
    """A selector mismatch can come back as a code-1000 error rather than a bare
    OnChainRevert. The probe has to recognize it either way, which means the API
    layer must not drop `reason`/`receipts` on the code path."""
    from o2_sdk.api import O2Api
    from o2_sdk.config import Network, get_config

    api = O2Api(get_config(Network.TESTNET))

    class FakeResponse:
        status = 400

        async def json(self, content_type=None):
            return {
                "code": 1000,
                "message": "Failed to process transaction",
                "reason": "and error: transaction reverted: Revert(123)",
                "receipts": [{"Revert": {"id": "0x18f9", "ra": 123}}],
            }

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    class FakeSession:
        timeout = None

        def request(self, *_args, **_kwargs):
            return FakeResponse()

    async def fake_ensure_session():
        return FakeSession()

    monkeypatch.setattr(api, "_ensure_session", fake_ensure_session)

    with pytest.raises(O2Error) as exc_info:
        await api.get_account(owner=OWNER)

    from o2_sdk.onchain_revert import is_selector_mismatch_revert

    err = exc_info.value
    assert err.code == 1000  # went through the code-based branch, not raise_for_error
    assert is_selector_mismatch_revert(err)


@pytest.mark.asyncio
async def test_non_json_response_raises_o2_error(monkeypatch: pytest.MonkeyPatch):
    """Infrastructure in front of the API answers 502/503 in plain text. Letting
    the JSON decoder's error escape hands the caller no status and no body."""
    from o2_sdk.api import O2Api
    from o2_sdk.config import Network, get_config

    api = O2Api(get_config(Network.TESTNET))

    class FakeResponse:
        status = 503

        async def json(self, content_type=None):
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

        async def text(self):
            return "no healthy upstream"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    class FakeSession:
        timeout = None

        def request(self, *_args, **_kwargs):
            return FakeResponse()

    async def fake_ensure_session():
        return FakeSession()

    monkeypatch.setattr(api, "_ensure_session", fake_ensure_session)

    with pytest.raises(O2Error) as exc_info:
        await api.get_account(owner=OWNER)
    message = str(exc_info.value)
    assert "Non-JSON response" in message
    assert "503" in message
    assert "no healthy upstream" in message


# ---------------------------------------------------------------------------
# Retry safety and lifecycle (codex review round 1)
# ---------------------------------------------------------------------------


def _parallel_session() -> SessionInfo:
    """A session on the parallel track, with a manager seated at (0, 0)."""
    from o2_sdk.nonce import ParallelNonceManager, WindowResponse, WindowSlot

    async def fetcher():
        return WindowResponse(
            nonce_session_id=0,
            base=0,
            slots=[WindowSlot(word_position=w, bitmap=0) for w in range(8)],
        )

    session = _session()
    session.nonce_manager = ParallelNonceManager(window_fetcher=fetcher)
    return session


MARKET_ID = "0x09c17f779eb0a7658424e48935b2bef24013766f8b3da757becb2264406f9e96"


def _market_client() -> O2Client:
    """A client whose market cache holds one real market, so batch_actions can
    resolve the market info it needs to encode calls."""
    from o2_sdk.models import MarketsResponse

    client = O2Client()
    client._markets_cache = MarketsResponse.from_dict(
        {
            "books_registry_id": "0x" + "11" * 32,
            "accounts_registry_id": "0x" + "22" * 32,
            "trade_account_oracle_id": "0x" + "33" * 32,
            "chain_id": "0x0000000000002699",
            "base_asset_id": "0x" + "44" * 32,
            "markets": [
                {
                    "contract_id": "0x" + "9a" * 32,
                    "market_id": MARKET_ID,
                    "maker_fee": "0",
                    "taker_fee": "100",
                    "min_order": "1000",
                    "dust": "1000",
                    "price_window": 0,
                    "base": {
                        "symbol": "FUEL",
                        "asset": "0x" + "a1" * 32,
                        "decimals": 9,
                        "max_precision": 3,
                    },
                    "quote": {
                        "symbol": "USDC",
                        "asset": "0x" + "f6" * 32,
                        "decimals": 9,
                        "max_precision": 9,
                    },
                }
            ],
        }
    )
    return client


@pytest.mark.asyncio
async def test_already_used_nonce_is_not_resubmitted(monkeypatch: pytest.MonkeyPatch):
    """The dangerous retry. "nonce already used" can mean our submission landed
    and its response was lost, so re-submitting would place a second order."""
    from o2_sdk.models import MarketActions, SettleBalanceAction

    client = _market_client()
    session = _parallel_session()
    submissions: list = []

    async def fake_submit(_owner, request):
        submissions.append(request)
        raise O2Error(message="Parallel nonce is not usable: nonce already used", code=1001)

    monkeypatch.setattr(client.api, "submit_actions", fake_submit)
    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _a, _m: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_parallel_actions_signing_bytes", lambda _n, _c: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _k, _p: b"\x99" * 64)

    actions = [MarketActions(market_id=MARKET_ID, actions=[SettleBalanceAction(to=TRADE_ACCOUNT)])]
    with pytest.raises(O2Error, match="already used"):
        await client.batch_actions(actions, session=session)
    assert len(submissions) == 1, "must not re-submit non-idempotent actions"


@pytest.mark.asyncio
async def test_out_of_window_nonce_is_retried_once(monkeypatch: pytest.MonkeyPatch):
    """The safe retry: validation refused the nonce, so nothing executed.

    Models what actually produces this error: the cursor ran past the chain's
    window, and the resync fetches a window that has moved on, so the retry
    draws a slot the chain reports as free rather than the one just refused.
    """
    from o2_sdk.models import ActionsResponse, MarketActions, SettleBalanceAction
    from o2_sdk.nonce import ParallelNonceManager, WindowResponse, WindowSlot

    windows = iter(
        [
            # At init the lane is untouched, so the cursor seats at (0, 0).
            WindowResponse(
                nonce_session_id=0,
                base=0,
                slots=[WindowSlot(word_position=w, bitmap=0) for w in range(8)],
            ),
            # By the resync the chain has slid to base 4 and consumed bits 0-2
            # of word 4. Slots are addressed by ``word % 8``, not sequentially
            # from base, so word 4 lives at index 4.
            WindowResponse(
                nonce_session_id=0,
                base=4,
                slots=[
                    WindowSlot(
                        word_position=w if w >= 4 else w + 8,
                        bitmap=0b111 if w == 4 else 0,
                    )
                    for w in range(8)
                ],
            ),
        ]
    )

    async def fetcher():
        return next(windows)

    client = _market_client()
    session = _session()
    session.nonce_manager = ParallelNonceManager(window_fetcher=fetcher)
    await session.nonce_manager.init()
    assert session.nonce_manager.cursor == (0, 0)
    submissions: list = []

    async def fake_submit(_owner, request):
        submissions.append(request)
        if len(submissions) == 1:
            raise O2Error(
                message="Parallel nonce is not usable: word position out of sliding window",
                code=1001,
            )
        return ActionsResponse.from_dict({"tx_id": "0x" + "aa" * 32})

    monkeypatch.setattr(client.api, "submit_actions", fake_submit)
    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _a, _m: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_parallel_actions_signing_bytes", lambda _n, _c: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _k, _p: b"\x99" * 64)

    actions = [MarketActions(market_id=MARKET_ID, actions=[SettleBalanceAction(to=TRADE_ACCOUNT)])]
    result = await client.batch_actions(actions, session=session)
    assert result.success
    assert len(submissions) == 2
    assert submissions[0]["parallel_nonce"] != submissions[1]["parallel_nonce"]
    # The retry drew from the window the resync just read: word 4, first bit
    # after the three the chain reports consumed.
    retried = ParallelNonce.decode(int(submissions[1]["parallel_nonce"]))
    assert (retried.word_position, retried.bitmap_position) == (4, 3)


@pytest.mark.asyncio
async def test_create_session_rejects_a_bad_lane_before_any_network_call(
    monkeypatch: pytest.MonkeyPatch,
):
    """Registering a session invalidates whichever one the account had, so a bad
    lane must not get that far."""
    client = _market_client()
    calls: list = []

    async def fake_create(*_args, **_kwargs):
        calls.append(1)
        raise AssertionError("network call must not happen")

    monkeypatch.setattr(client.api, "create_session", fake_create)

    with pytest.raises(O2Error, match=r"nonce_session_id must be in \[0, 4\]"):
        await client.create_session(
            owner=FakeOwner(),
            markets=["FUEL/USDC"],
            nonce_strategy="parallel",
            nonce_session_id=9,
        )
    assert not calls


@pytest.mark.asyncio
async def test_upgrade_account_treats_no_upgrade_available_as_success(
    monkeypatch: pytest.MonkeyPatch,
):
    """The proxy's require(new_impl != current, "No upgrade available") fires on
    an account that is already current. For a caller that wants the account
    current, that is the desired state, not a failure."""
    from o2_sdk.errors import OnChainRevert

    client = O2Client()

    async def fake_get_account(**_kwargs):
        return _account(5)

    async def fake_upgrade(_owner_id, _request):
        raise OnChainRevert(
            message="Failed to process transaction",
            reason="FAILED_REQUIRE (specific error unknown)",
            receipts=None,
            raw_reason='revert with log: Ok("No upgrade available")',
        )

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    assert await client.upgrade_account(FakeOwner()) is None


@pytest.mark.asyncio
async def test_upgrade_account_still_raises_other_reverts(monkeypatch: pytest.MonkeyPatch):
    from o2_sdk.errors import OnChainRevert

    client = O2Client()

    async def fake_get_account(**_kwargs):
        return _account(5)

    async def fake_upgrade(_owner_id, _request):
        raise OnChainRevert(message="boom", reason="SignerError::InvalidSigner")

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "upgrade_account", fake_upgrade)
    monkeypatch.setattr(client, "_get_markets_cached", _fake_markets)

    with pytest.raises(OnChainRevert, match="InvalidSigner"):
        await client.upgrade_account(FakeOwner())


@pytest.mark.asyncio
async def test_ensure_parallel_session_reports_an_unupgradeable_account(
    monkeypatch: pytest.MonkeyPatch,
):
    """Probe fails and there is no upgrade to apply: say so, rather than
    claiming an upgrade landed and did not help."""
    client = O2Client()

    async def fake_create_session(**_kwargs):
        return _session()

    async def fake_probe(_session, _market):
        return False

    async def fake_upgrade(_owner, **_kwargs):
        return None  # already current

    monkeypatch.setattr(client, "create_session", fake_create_session)
    monkeypatch.setattr(client, "probe_parallel_support", fake_probe)
    monkeypatch.setattr(client, "upgrade_account", fake_upgrade)

    with pytest.raises(O2Error, match="no upgrade to apply"):
        await client.ensure_parallel_session(FakeOwner(), ["FUEL/USDC"])


@pytest.mark.asyncio
async def test_already_used_heals_the_cursor_without_retrying(
    monkeypatch: pytest.MonkeyPatch,
):
    """The cursor must be reseated even though the submission is not retried.

    Session recreation used to be what reseated a cursor pointing into consumed
    territory, but only as a side effect of building a fresh nonce manager.
    Doing the window fetch here heals it directly: one resync jumps the whole
    consumed run, where merely advancing would re-offer the next consumed slot
    and burn a round-trip per position.
    """
    from o2_sdk.models import MarketActions, SettleBalanceAction

    client = _market_client()
    session = _parallel_session()
    await session.nonce_manager.init()
    manager = session.nonce_manager
    submissions: list = []

    async def fake_submit(_owner, request):
        submissions.append(request)
        raise O2Error(message="Parallel nonce is not usable: nonce already used", code=1001)

    monkeypatch.setattr(client.api, "submit_actions", fake_submit)
    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _a, _m: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_parallel_actions_signing_bytes", lambda _n, _c: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _k, _p: b"\x99" * 64)

    generation_before = manager.resync_generation
    actions = [MarketActions(market_id=MARKET_ID, actions=[SettleBalanceAction(to=TRADE_ACCOUNT)])]
    with pytest.raises(O2Error, match="already used"):
        await client.batch_actions(actions, session=session)

    assert len(submissions) == 1, "must not re-submit non-idempotent actions"
    assert manager.resync_generation > generation_before, (
        "the cursor must be reseated from chain, or nothing heals it now that "
        "the failure no longer feeds a session recreation"
    )


@pytest.mark.asyncio
async def test_already_used_still_raises_when_the_heal_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    """A failing resync must not replace the error the caller needs to see."""
    from o2_sdk.models import MarketActions, SettleBalanceAction

    client = _market_client()
    session = _parallel_session()
    await session.nonce_manager.init()

    async def broken_resync(_generation=None):
        raise RuntimeError("window endpoint down")

    async def fake_submit(_owner, _request):
        raise O2Error(message="Parallel nonce is not usable: nonce already used", code=1001)

    monkeypatch.setattr(session.nonce_manager, "resync_from_chain", broken_resync)
    monkeypatch.setattr(client.api, "submit_actions", fake_submit)
    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _a, _m: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_parallel_actions_signing_bytes", lambda _n, _c: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _k, _p: b"\x99" * 64)

    actions = [MarketActions(market_id=MARKET_ID, actions=[SettleBalanceAction(to=TRADE_ACCOUNT)])]
    with pytest.raises(O2Error, match="already used"):
        await client.batch_actions(actions, session=session)
