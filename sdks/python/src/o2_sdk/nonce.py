"""Parallel-nonce support for concurrent action submission.

Two nonce *tracks* coexist, chosen once per session via
``create_session(nonce_strategy=...)`` and transparent to callers thereafter:

* **Sequential** (legacy): one monotonic u64 per account; serializes submissions
  and needs rollback/refetch on revert. Still first-class — it is the only track
  that can perform trade-account upgrades, and is the right choice for
  low-frequency clients (e.g. a rebalancer sharing a key with trading bots).
* **Parallel** (this module): a parallel-capable trade account exposes a
  sliding-window bitmap of 8 words x 128 bits = 1024 concurrent nonce slots, with
  5 independent lanes (``nonce_session_id`` 0..4) per account. Any free bit in
  the window is a valid nonce, so many actions can be in flight at once without
  serialization or rollback.

Whether an account is parallel-capable cannot be read from the API: see
``docs/guides/parallel_nonces.rst`` and ``O2Client.probe_parallel_support``.

The packing/window math here MUST match ``parallel_nonce.sw`` in the
trade-account contract.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .errors import O2Error

# --- Constants (must match the trade-account contract) ----------------------

#: Number of 128-bit words in the sliding window.
NONCE_SESSION_SLIDING_WINDOW_SIZE = 8
#: Number of bits in each bitmap word.
NONCE_BITMAP_SIZE = 128
#: Highest ``nonce_session_id`` (lane) the contract accepts.
MAX_NONCE_SESSION_ID = 4
#: Default nonce TTL — long enough for any REST round-trip, short enough that a
#: leaked signed nonce can't be replayed indefinitely.
DEFAULT_NONCE_TTL_SECS = 120

_WORD_POSITION_SHIFT = 8
_TIMESTAMP_SHIFT = 136
_SESSION_ID_SHIFT = 168
_RESERVED_SHIFT = 176

_U8_MASK = 0xFF
_U32_MASK = 0xFFFF_FFFF
_U128_MASK = (1 << 128) - 1


# --- Errors -----------------------------------------------------------------


class ParallelNonceError(O2Error):
    """Base for parallel-nonce client errors."""


class ParallelNonceWindowFull(ParallelNonceError):
    """The top window word is fully consumed; wait for the chain window to slide."""


# --- Packed nonce -----------------------------------------------------------


@dataclass(frozen=True)
class ParallelNonce:
    """A parallel nonce, packed into a U256 the contract decodes on-chain.

    Layout (bit ranges): ``bitmap_position[0:8] | word_position[8:136] |
    timestamp[136:168] | nonce_session_id[168:176]``, reserved ``[176:256)``.
    """

    nonce_session_id: int
    timestamp: int
    word_position: int
    bitmap_position: int

    def encode(self) -> int:
        """Pack into the U256 integer carried in the signed request.

        Validates the same invariants :meth:`decode` enforces, so the pair stay
        inverses. Without this an out-of-range field silently bleeds into its
        neighbour (a ``word_position`` past 128 bits corrupts the timestamp),
        producing a well-formed nonce that means something other than what the
        caller asked for. ``timestamp`` is the one exception: it is masked to
        u32 rather than rejected, matching the width the contract stores.
        """
        if not 0 <= self.bitmap_position < NONCE_BITMAP_SIZE:
            raise ParallelNonceError(
                message=f"bitmap_position must be in [0, {NONCE_BITMAP_SIZE}), "
                f"got {self.bitmap_position}"
            )
        if not 0 <= self.nonce_session_id <= MAX_NONCE_SESSION_ID:
            raise ParallelNonceError(
                message=f"nonce_session_id must be in [0, {MAX_NONCE_SESSION_ID}], "
                f"got {self.nonce_session_id}"
            )
        if not 0 <= self.word_position <= _U128_MASK:
            raise ParallelNonceError(
                message=f"word_position must fit in 128 bits, got {self.word_position}"
            )
        if self.timestamp < 0:
            raise ParallelNonceError(
                message=f"timestamp must not be negative, got {self.timestamp}"
            )
        return (
            self.bitmap_position
            | (self.word_position << _WORD_POSITION_SHIFT)
            | ((self.timestamp & _U32_MASK) << _TIMESTAMP_SHIFT)
            | (self.nonce_session_id << _SESSION_ID_SHIFT)
        )

    @staticmethod
    def decode(nonce: int) -> ParallelNonce:
        """Inverse of :meth:`encode`; rejects values ``encode`` couldn't produce."""
        if nonce >> _RESERVED_SHIFT != 0:
            raise ParallelNonceError(message="reserved bits must be zero")
        bitmap_position = nonce & _U8_MASK
        if bitmap_position >= NONCE_BITMAP_SIZE:
            raise ParallelNonceError(
                message=f"bitmap_position {bitmap_position} >= {NONCE_BITMAP_SIZE}"
            )
        nonce_session_id = (nonce >> _SESSION_ID_SHIFT) & _U8_MASK
        if nonce_session_id > MAX_NONCE_SESSION_ID:
            raise ParallelNonceError(
                message=f"nonce_session_id {nonce_session_id} > {MAX_NONCE_SESSION_ID}"
            )
        timestamp = (nonce >> _TIMESTAMP_SHIFT) & _U32_MASK
        word_position = (nonce >> _WORD_POSITION_SHIFT) & _U128_MASK
        return ParallelNonce(
            nonce_session_id=nonce_session_id,
            timestamp=timestamp,
            word_position=word_position,
            bitmap_position=bitmap_position,
        )


# --- Indexed window (GET /v1/accounts/window) -------------------------------


@dataclass(frozen=True)
class WindowSlot:
    word_position: int
    bitmap: int


@dataclass(frozen=True)
class WindowResponse:
    """The indexed view of the contract's sliding window for one lane."""

    nonce_session_id: int
    base: int
    slots: list[WindowSlot]

    @staticmethod
    def from_dict(d: dict) -> WindowResponse:
        return WindowResponse(
            nonce_session_id=int(d["nonce_session_id"]),
            base=int(d["base"]),
            slots=[
                WindowSlot(word_position=int(s["word_position"]), bitmap=int(s["bitmap"]))
                for s in d.get("slots", [])
            ],
        )

    def effective_bitmap(self, word: int) -> int:
        """Consumed-bit bitmap for ``word``.

        A slot recycled by a window slide still holds another word's bitmap,
        which counts as empty (the slot's ``word_position`` is the source of
        truth). The indexer may also return fewer than
        ``NONCE_SESSION_SLIDING_WINDOW_SIZE`` slots for a fresh account; treat
        out-of-range indices as empty rather than indexing past the list.
        """
        if not self.slots:
            return 0
        idx = word % NONCE_SESSION_SLIDING_WINDOW_SIZE
        if idx >= len(self.slots):
            return 0
        slot = self.slots[idx]
        return slot.bitmap if slot.word_position == word else 0

    def first_free_position(self) -> tuple[int, int]:
        """The ``(word, bit)`` strictly after the highest consumed position.

        Deliberately not the first free hole: a hole can belong to an earlier
        run of this lane whose later positions already landed on-chain, so a
        cursor started inside it would mint already-used nonces. Starting past
        the highest used bit wastes holes but can never collide.
        """
        top = self.base + NONCE_SESSION_SLIDING_WINDOW_SIZE - 1
        word = top
        while True:
            bitmap = self.effective_bitmap(word)
            if bitmap != 0:
                highest = bitmap.bit_length() - 1  # == 127 - leading_zeros
                if highest + 1 < NONCE_BITMAP_SIZE:
                    return (word, highest + 1)
                if word < top:
                    return (word + 1, 0)
                raise ParallelNonceWindowFull(
                    message="top window word fully consumed; wait for the on-chain "
                    "window to slide before launching"
                )
            if word == self.base:
                return (self.base, 0)
            word -= 1


# --- Error classification (response ``reason`` strings) ---------------------
# Distinguish NONCE problems (resync + retry) from SESSION problems (rotate);
# resyncing on a session error would burn parallel nonces for nothing.
#
# The API reports EVERY parallel-nonce rejection as
# ``"Parallel nonce is not usable: {reason}"`` (fuel-o2
# services/registry/service.rs), where reason is one of the six
# ParallelNonceError variants. That prefix therefore says nothing about what
# went wrong and must never be matched on its own — match the reason.

#: Rejections that prove the submission was refused at nonce validation, so the
#: actions did not execute and re-submitting under a fresh nonce is safe.
_NONCE_RETRYABLE_MARKERS = (
    "word position out of sliding window",
    "nonce expired",
)
#: The slot was already consumed on chain. This does NOT prove our actions did
#: not execute: a submission that landed but whose response was lost (the API
#: client retries POSTs on network errors) comes back exactly this way, so
#: re-submitting would duplicate non-idempotent actions such as create_order.
_NONCE_ALREADY_USED_MARKER = "nonce already used"
_NONCE_TOO_LOW_MARKER = "Nonce in the request"
_SESSION_ERROR_MARKERS = (
    "Invalid session address",
    "Expired session",
)


def _error_text(error: str | BaseException | None) -> str:
    """Searchable text for an error, whether given as a reason string or as the
    exception itself. A submission failure surfaces its marker in ``message`` or
    in either form of ``reason``, so all of them are searched."""
    if error is None:
        return ""
    if isinstance(error, str):
        return error
    return (
        "\n".join(
            str(getattr(error, attr, "") or "") for attr in ("message", "reason", "raw_reason")
        )
        + f"\n{error}"
    )


def is_parallel_nonce_out_of_window(error: str | BaseException | None) -> bool:
    """The nonce was refused at validation and the actions did not execute, so
    resyncing the cursor (:meth:`ParallelNonceManager.resync_from_chain`) and
    re-submitting is safe.

    Deliberately does not match "nonce already used" — see
    :func:`is_parallel_nonce_already_used`.
    """
    text = _error_text(error)
    return any(m in text for m in _NONCE_RETRYABLE_MARKERS)


def is_parallel_nonce_already_used(error: str | BaseException | None) -> bool:
    """The nonce's slot was already consumed on chain.

    **Never auto-retry this.** It is ambiguous in the one way that matters: it
    happens both when another submitter took the slot (our actions never ran)
    and when our own submission landed but its response was lost in transit,
    which the API client's POST retry can produce on its own. Re-submitting the
    batch under a fresh nonce would place a second order in the latter case,
    so the error has to reach the caller, who alone knows whether the actions
    are safe to repeat.
    """
    return _NONCE_ALREADY_USED_MARKER in _error_text(error)


def is_nonce_too_low(error: str | BaseException | None) -> bool:
    """Sequential-track "nonce < db" conflict: re-fetch the nonce and retry."""
    return _NONCE_TOO_LOW_MARKER in _error_text(error)


def is_session_error(error: str | BaseException | None) -> bool:
    """The trade account rejected the session itself, so no nonce will help.

    Sessions are not immortal: the contract holds one registered session per
    account, and anything that registers another one for the same account (a
    redeployment whose outgoing pod is still working, a second client sharing the
    owner key, a process racing its own restart) invalidates the earlier one.
    Every action signed with the stale session then reverts this way until a new
    session is created; nothing about it is retryable on its own. Resyncing the
    nonce window here would burn slots for nothing.
    """
    text = _error_text(error)
    return any(m in text for m in _SESSION_ERROR_MARKERS)


# --- Manager ----------------------------------------------------------------

WindowFetcher = Callable[[], Awaitable[WindowResponse]]


class ParallelNonceManager:
    """Local issuer of parallel nonces for one ``(trade_account, lane)``.

    ``next_nonce()`` is synchronous and never does I/O — it just advances a
    monotonic cursor and packs the nonce. Burnt nonces (issued but never landed)
    are fine; the cursor never goes backwards on its own. When the chain rejects
    a nonce as out-of-window (we burned faster than the chain slid), call
    :meth:`resync_from_chain`.

    ``window_fetcher`` is injected (``GET /v1/accounts/window`` in production) so
    the cursor/window logic is unit-testable without network.
    """

    def __init__(
        self,
        *,
        window_fetcher: WindowFetcher,
        nonce_session_id: int = 0,
        ttl_secs: int = DEFAULT_NONCE_TTL_SECS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not (0 <= nonce_session_id <= MAX_NONCE_SESSION_ID):
            raise ValueError(f"nonce_session_id must be in [0, {MAX_NONCE_SESSION_ID}]")
        self._fetch_window = window_fetcher
        self._session_id = nonce_session_id
        self._ttl = ttl_secs
        self._clock = clock
        self._lock = threading.Lock()  # guards the cursor (sync, no await held)
        self._resync_lock = asyncio.Lock()  # single-flight async resync
        self._word = 0
        self._bit = 0
        self._resync_generation = 0

    @property
    def nonce_session_id(self) -> int:
        return self._session_id

    @property
    def cursor(self) -> tuple[int, int]:
        with self._lock:
            return (self._word, self._bit)

    def next_nonce(self) -> int:
        """Issue the next parallel nonce (packed U256). Thread-safe, no I/O."""
        with self._lock:
            nonce = ParallelNonce(
                nonce_session_id=self._session_id,
                timestamp=int(self._clock()) + self._ttl,
                word_position=self._word,
                bitmap_position=self._bit,
            ).encode()
            if self._bit + 1 < NONCE_BITMAP_SIZE:
                self._bit += 1
            else:
                self._bit = 0
                self._word += 1
            return nonce

    async def init(self) -> None:
        """Fetch the window and seat the cursor at the first free position."""
        self._seat(await self._fetch_window())

    @property
    def resync_generation(self) -> int:
        """Counter incremented by every completed resync.

        Read it before a submission and pass it to :meth:`resync_from_chain` on
        failure, so a resync another task already performed is not repeated.
        """
        with self._lock:
            return self._resync_generation

    async def resync_from_chain(self, seen_generation: int | None = None) -> None:
        """Re-fetch the window and reset the cursor past the highest consumed bit.

        Genuinely single-flight, which matters for correctness and not just for
        sparing the endpoint. Re-seating moves the cursor BACKWARDS onto slots
        the chain has not seen consumed yet, so a second resync running after
        the first can hand out a position the first resync's retry already took,
        and the two collide. Concurrent submissions fail together (they share
        one window), so this is the common case, not a rare one.

        Pass ``seen_generation`` (from :attr:`resync_generation`, read before the
        failed submission) to make this a no-op when someone else has already
        resynced since: whatever they seated is at least as fresh as what this
        call would fetch.
        """
        async with self._resync_lock:
            if seen_generation is not None and self.resync_generation != seen_generation:
                return  # another task resynced while this one waited for the lock
            self._seat(await self._fetch_window())

    def _seat(self, window: WindowResponse) -> None:
        if window.nonce_session_id != self._session_id:
            raise ParallelNonceError(
                message=f"window response carried session id {window.nonce_session_id}, "
                f"expected {self._session_id}"
            )
        word, bit = window.first_free_position()
        with self._lock:
            self._word, self._bit = word, bit
            self._resync_generation += 1
