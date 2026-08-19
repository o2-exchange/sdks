"""Withdrawal nonce selection and parallel typed-signature tests."""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any

import pytest

from o2_sdk import (
    AddressIdentity,
    MarketsResponse,
    O2Client,
    O2Error,
    ParallelNonce,
    ParallelNonceManager,
    SessionInfo,
    WithdrawResponse,
)
from o2_sdk.nonce import WindowResponse

TRADE_ACCOUNT_ID = "0x" + "33" * 32
ASSET_ID = "0x" + "44" * 32
OWNER_ID = "0x" + "55" * 32
DESTINATION = "0x" + "66" * 32


def _markets() -> MarketsResponse:
    return MarketsResponse.from_dict(
        {
            "books_registry_id": "0x" + "11" * 32,
            "accounts_registry_id": "0x" + "22" * 32,
            "trade_account_oracle_id": "0x" + "77" * 32,
            "chain_id": "9889",
            "base_asset_id": ASSET_ID,
            "markets": [
                {
                    "contract_id": "0x" + "88" * 32,
                    "market_id": "0x" + "99" * 32,
                    "base": {
                        "symbol": "USDC",
                        "asset": ASSET_ID,
                        "decimals": 6,
                        "max_precision": 6,
                    },
                    "quote": {
                        "symbol": "FUEL",
                        "asset": "0x" + "aa" * 32,
                        "decimals": 9,
                        "max_precision": 9,
                    },
                }
            ],
        }
    )


class _Owner:
    b256_address = OWNER_ID
    typed_digest: bytes | None = None

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.b256_address[2:])

    def personal_sign(self, message: bytes) -> bytes:
        return b"\x11" * 64

    def sign_digest(self, digest: bytes) -> bytes:
        self.typed_digest = digest
        return b"\x22" * 64


def _account(nonce: int = 7) -> Any:
    return type(
        "Account",
        (),
        {"exists": True, "trade_account_id": TRADE_ACCOUNT_ID, "nonce": nonce},
    )()


async def _parallel_session(client: O2Client) -> SessionInfo:
    async def fetch_window() -> WindowResponse:
        return WindowResponse(nonce_session_id=0, base=0, slots=[])

    manager = ParallelNonceManager(
        window_fetcher=fetch_window,
        nonce_session_id=0,
        clock=lambda: 1_900_000_000,
    )
    await manager.init()
    session = SessionInfo(
        session_id=AddressIdentity("0x" + "77" * 32),
        trade_account_id=TRADE_ACCOUNT_ID,
        contract_ids=[],
        session_expiry="9999999999",
        session_private_key=b"\x01" * 32,
        owner_address=OWNER_ID,
        nonce_manager=manager,
    )
    client.set_session(session)
    return session


def _resolved(value: Any) -> Awaitable[Any]:
    async def resolve() -> Any:
        return value

    return resolve()


@pytest.mark.asyncio
async def test_sequential_nonce_override_is_signed_and_cached(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    captured: dict = {}

    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        captured.update(request)
        return WithdrawResponse(tx_id="0x" + "ab" * 32)

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    await client.withdraw(owner, "USDC", 1.0, nonce=42)

    assert captured["nonce"] == "42"
    assert "parallel_nonce" not in captured
    assert set(captured["signature"]) == {"Secp256k1"}
    assert client._nonce_cache[TRADE_ACCOUNT_ID] == 43


@pytest.mark.asyncio
async def test_without_override_reuses_cached_sequential_nonce(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    client._markets_cache = _markets()
    client._nonce_cache[TRADE_ACCOUNT_ID] = 19
    owner = _Owner()
    captured: dict = {}

    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account(nonce=7)))

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        captured.update(request)
        return WithdrawResponse(tx_id="0x" + "ab" * 32)

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    await client.withdraw(owner, "USDC", 1.0)

    assert captured["nonce"] == "19"
    assert client._nonce_cache[TRADE_ACCOUNT_ID] == 20


@pytest.mark.asyncio
async def test_parallel_manager_for_another_owner_is_ignored(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    client._markets_cache = _markets()
    session = await _parallel_session(client)

    class OtherOwner(_Owner):
        b256_address = "0x" + "aa" * 32

    owner = OtherOwner()
    captured: dict = {}
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        captured.update(request)
        return WithdrawResponse(tx_id="0x" + "ab" * 32)

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    manager = session.nonce_manager
    assert manager is not None
    before = manager.cursor

    await client.withdraw(owner, "USDC", 1.0)

    assert "nonce" in captured
    assert "parallel_nonce" not in captured
    assert manager.cursor == before


@pytest.mark.asyncio
async def test_without_override_reuses_parallel_session_manager(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    session = await _parallel_session(client)
    captured: dict = {}

    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        captured.update(request)
        return WithdrawResponse(tx_id="0x" + "ab" * 32)

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    manager = session.nonce_manager
    assert manager is not None
    before = manager.cursor
    await client.withdraw(owner, "USDC", 1.0, to=DESTINATION)

    decoded = ParallelNonce.decode(int(captured["parallel_nonce"]))
    assert (decoded.word_position, decoded.bitmap_position) == before
    assert set(captured["signature"]) == {"TypedSecp256k1"}
    assert "nonce" not in captured
    assert owner.typed_digest is not None and len(owner.typed_digest) == 32
    assert manager.cursor == (0, 1)


@pytest.mark.asyncio
async def test_direct_parallel_withdraw_requires_matching_manager(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))

    with pytest.raises(O2Error, match="No active parallel nonce manager for owner"):
        await client.withdraw_parallel(owner, "USDC", 1.0)


@pytest.mark.asyncio
async def test_explicit_parallel_nonce_is_exact_and_not_retried(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    session = await _parallel_session(client)
    manager = session.nonce_manager
    assert manager is not None
    cursor_before = manager.cursor
    generation_before = manager.resync_generation
    override = ParallelNonce(1, 1_900_000_120, 3, 4)
    submissions: list[dict] = []

    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        submissions.append(request)
        raise O2Error(message="Parallel nonce is not usable: word position out of sliding window")

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    with pytest.raises(O2Error, match="out of sliding window"):
        await client.withdraw(owner, "USDC", 1.0, nonce=override)

    assert len(submissions) == 1
    assert submissions[0]["parallel_nonce"] == str(override.encode())
    assert manager.cursor == cursor_before
    assert manager.resync_generation == generation_before


@pytest.mark.asyncio
async def test_managed_parallel_withdraw_resyncs_out_of_window_and_retries_once(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    window_fetches = 0

    async def fetch_window() -> WindowResponse:
        nonlocal window_fetches
        window_fetches += 1
        return WindowResponse(
            nonce_session_id=0,
            base=0 if window_fetches == 1 else 2,
            slots=[],
        )

    manager = ParallelNonceManager(window_fetcher=fetch_window, clock=lambda: 1_900_000_000)
    await manager.init()
    client.set_session(
        SessionInfo(
            session_id=AddressIdentity("0x" + "77" * 32),
            trade_account_id=TRADE_ACCOUNT_ID,
            contract_ids=[],
            session_expiry="9999999999",
            owner_address=OWNER_ID,
            nonce_manager=manager,
        )
    )
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))
    submissions: list[int] = []

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        submissions.append(int(request["parallel_nonce"]))
        if len(submissions) == 1:
            raise O2Error(
                message="Parallel nonce is not usable: word position out of sliding window"
            )
        return WithdrawResponse(tx_id="0x" + "ab" * 32)

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    result = await client.withdraw(owner, "USDC", 1.0)

    assert result.success
    assert len(submissions) == 2
    assert ParallelNonce.decode(submissions[0]).word_position == 0
    assert ParallelNonce.decode(submissions[1]).word_position == 2
    assert manager.cursor == (2, 1)
    assert window_fetches == 2


@pytest.mark.asyncio
async def test_managed_already_used_nonce_resyncs_without_retry(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    window_fetches = 0

    async def fetch_window() -> WindowResponse:
        nonlocal window_fetches
        window_fetches += 1
        return WindowResponse(
            nonce_session_id=0,
            base=0 if window_fetches == 1 else 3,
            slots=[],
        )

    manager = ParallelNonceManager(window_fetcher=fetch_window, clock=lambda: 1_900_000_000)
    await manager.init()
    client.set_session(
        SessionInfo(
            session_id=AddressIdentity("0x" + "77" * 32),
            trade_account_id=TRADE_ACCOUNT_ID,
            contract_ids=[],
            session_expiry="9999999999",
            owner_address=OWNER_ID,
            nonce_manager=manager,
        )
    )
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))
    submissions = 0

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        nonlocal submissions
        submissions += 1
        raise O2Error(message="Parallel nonce is not usable: nonce already used")

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    with pytest.raises(O2Error, match="nonce already used"):
        await client.withdraw(owner, "USDC", 1.0)

    assert submissions == 1
    assert manager.cursor == (3, 0)
    assert window_fetches == 2


@pytest.mark.asyncio
async def test_managed_parallel_withdraw_does_not_resync_other_errors(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()
    owner = _Owner()
    window_fetches = 0

    async def fetch_window() -> WindowResponse:
        nonlocal window_fetches
        window_fetches += 1
        return WindowResponse(nonce_session_id=0, base=0, slots=[])

    manager = ParallelNonceManager(window_fetcher=fetch_window, clock=lambda: 1_900_000_000)
    await manager.init()
    client.set_session(
        SessionInfo(
            session_id=AddressIdentity("0x" + "77" * 32),
            trade_account_id=TRADE_ACCOUNT_ID,
            contract_ids=[],
            session_expiry="9999999999",
            owner_address=OWNER_ID,
            nonce_manager=manager,
        )
    )
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))
    submissions = 0

    async def withdraw(_owner_id: str, request: dict) -> WithdrawResponse:
        nonlocal submissions
        submissions += 1
        raise O2Error(message="withdrawal rejected")

    monkeypatch.setattr(client.api, "withdraw", withdraw)
    with pytest.raises(O2Error, match="withdrawal rejected"):
        await client.withdraw(owner, "USDC", 1.0)

    assert submissions == 1
    assert manager.cursor == (0, 1)
    assert window_fetches == 1


@pytest.mark.asyncio
async def test_sequential_custom_signer_need_not_support_typed_signing(
    monkeypatch: pytest.MonkeyPatch,
):
    client = O2Client()
    client._markets_cache = _markets()

    class SequentialOnlyOwner(_Owner):
        def sign_digest(self, digest: bytes) -> bytes:
            raise NotImplementedError("typed operations disabled")

    owner = SequentialOnlyOwner()
    monkeypatch.setattr(client.api, "get_account", lambda **_: _resolved(_account()))
    monkeypatch.setattr(
        client.api,
        "withdraw",
        lambda *_: _resolved(WithdrawResponse(tx_id="0x" + "ab" * 32)),
    )

    await client.withdraw(owner, "USDC", 1.0, nonce=7)
    parallel = ParallelNonce(0, 1_900_000_120, 0, 0)
    with pytest.raises(NotImplementedError, match="typed operations disabled"):
        await client.withdraw(owner, "USDC", 1.0, nonce=parallel)
