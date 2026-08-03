"""Unit tests for parallel-nonce cursor/window logic (no network)."""

import asyncio

import pytest

from o2_sdk.nonce import (
    MAX_NONCE_SESSION_ID,
    NONCE_BITMAP_SIZE,
    NONCE_SESSION_SLIDING_WINDOW_SIZE,
    ParallelNonce,
    ParallelNonceError,
    ParallelNonceManager,
    ParallelNonceWindowFull,
    WindowResponse,
    WindowSlot,
    is_nonce_too_low,
    is_parallel_nonce_already_used,
    is_parallel_nonce_out_of_window,
    is_session_error,
)

# --- ParallelNonce encode/decode -------------------------------------------


class TestParallelNonceCodec:
    def test_encode_bit_layout(self):
        n = ParallelNonce(
            nonce_session_id=2, timestamp=0x1234_5678, word_position=5, bitmap_position=10
        )
        v = n.encode()
        assert v & 0xFF == 10  # bitmap_position [0:8]
        assert (v >> 8) & ((1 << 128) - 1) == 5  # word_position [8:136]
        assert (v >> 136) & 0xFFFF_FFFF == 0x1234_5678  # timestamp [136:168]
        assert (v >> 168) & 0xFF == 2  # session_id [168:176]
        assert v >> 176 == 0  # reserved

    def test_round_trip(self):
        for n in [
            ParallelNonce(0, 0, 0, 0),
            ParallelNonce(4, 1_900_000_000, (1 << 128) - 1, 127),
            ParallelNonce(1, 123456, 999, 63),
        ]:
            assert ParallelNonce.decode(n.encode()) == n

    def test_encode_rejects_what_decode_rejects(self):
        """Otherwise an out-of-range field bleeds into its neighbour and encodes
        a well-formed nonce that means something else."""
        for bad, match in [
            (ParallelNonce(0, 0, 0, NONCE_BITMAP_SIZE), "bitmap_position"),
            (ParallelNonce(MAX_NONCE_SESSION_ID + 1, 0, 0, 0), "nonce_session_id"),
            (ParallelNonce(0, 0, 1 << 128, 0), "word_position"),
            (ParallelNonce(0, -1, 0, 0), "timestamp"),
        ]:
            with pytest.raises(ParallelNonceError, match=match):
                bad.encode()

    def test_encode_does_not_corrupt_neighbouring_fields(self):
        """The concrete failure the validation prevents: a word_position one bit
        past its field would have landed inside the timestamp."""
        with pytest.raises(ParallelNonceError):
            ParallelNonce(
                nonce_session_id=0, timestamp=1000, word_position=1 << 128, bitmap_position=0
            ).encode()

    def test_timestamp_truncated_to_u32(self):
        # encode masks timestamp to 32 bits; decode reflects the stored value.
        n = ParallelNonce(0, 0x1_0000_0001, 0, 0)
        assert ParallelNonce.decode(n.encode()).timestamp == 1

    def test_decode_rejects_reserved_bits(self):
        with pytest.raises(ParallelNonceError, match="reserved"):
            ParallelNonce.decode(1 << 176)

    def test_decode_rejects_bad_bitmap_position(self):
        with pytest.raises(ParallelNonceError, match="bitmap_position"):
            ParallelNonce.decode(NONCE_BITMAP_SIZE)  # 128 in bitmap field

    def test_decode_rejects_bad_session_id(self):
        bad = (MAX_NONCE_SESSION_ID + 1) << 168
        with pytest.raises(ParallelNonceError, match="nonce_session_id"):
            ParallelNonce.decode(bad)


# --- WindowResponse.effective_bitmap / first_free_position -----------------


def _window(base, slots, session_id=0):
    """Raw constructor: slots is a list of (word_position, bitmap) at list index
    == word % 8 (use for partial/recycled-slot cases)."""
    return WindowResponse(
        nonce_session_id=session_id,
        base=base,
        slots=[WindowSlot(w, b) for (w, b) in slots],
    )


def _full(base, used, session_id=0):
    """Build a full 8-slot window for `base`, placing each used word's bitmap at
    its real `word % 8` index. `used` is {word_position: bitmap}, words in
    [base, base+8)."""
    slots = []
    for i in range(NONCE_SESSION_SLIDING_WINDOW_SIZE):
        w = base + ((i - base) % NONCE_SESSION_SLIDING_WINDOW_SIZE)
        slots.append((w, used.get(w, 0)))
    return _window(base, slots, session_id=session_id)


class TestWindow:
    def test_empty_window_starts_at_base(self):
        w = _window(0, [])
        assert w.first_free_position() == (0, 0)

    def test_first_free_past_highest_used_bit(self):
        # word 0 has bits 0..4 set -> next free is bit 5 in word 0.
        w = _window(0, [(0, 0b11111)])
        assert w.first_free_position() == (0, 5)

    def test_skips_holes_below_highest_used_word(self):
        # word 3 used (bit0), lower words empty -> start right after, not in a hole.
        slots = [(0, 0)] * NONCE_SESSION_SLIDING_WINDOW_SIZE
        slots[3] = (3, 0b1)
        w = _window(0, slots)
        assert w.first_free_position() == (3, 1)

    def test_full_word_rolls_to_next_word(self):
        full = (1 << NONCE_BITMAP_SIZE) - 1
        # word at base+1 entirely full, base full too -> first free is base+2,0
        slots = [(0, 0)] * NONCE_SESSION_SLIDING_WINDOW_SIZE
        slots[0] = (0, full)
        slots[1] = (1, full)
        w = _window(0, slots)
        assert w.first_free_position() == (2, 0)

    def test_top_word_full_raises(self):
        full = (1 << NONCE_BITMAP_SIZE) - 1
        top = NONCE_SESSION_SLIDING_WINDOW_SIZE - 1
        slots = [(0, 0)] * NONCE_SESSION_SLIDING_WINDOW_SIZE
        slots[top % NONCE_SESSION_SLIDING_WINDOW_SIZE] = (top, full)
        w = _window(0, slots)
        with pytest.raises(ParallelNonceWindowFull):
            w.first_free_position()

    def test_partial_slot_array_treated_as_empty(self):
        # Indexer returns fewer than 8 slots; out-of-range words read as empty.
        w = _window(0, [(0, 0b1)])  # only one slot
        # word 0 has bit0 used -> first free is (0, 1)
        assert w.first_free_position() == (0, 1)

    def test_recycled_slot_word_mismatch_is_empty(self):
        # slot at index 0 holds a stale word (8, not 0) -> counts as empty for word 0.
        w = _window(0, [(8, 0b1111)] + [(0, 0)] * 7)
        assert w.effective_bitmap(0) == 0
        assert w.first_free_position() == (0, 0)


# --- ParallelNonceManager --------------------------------------------------


def _fetcher(window):
    async def fetch():
        return window

    return fetch


class TestManager:
    def test_next_nonce_advances_cursor(self):
        mgr = ParallelNonceManager(window_fetcher=_fetcher(_window(0, [])), clock=lambda: 0)
        a = ParallelNonce.decode(mgr.next_nonce())
        b = ParallelNonce.decode(mgr.next_nonce())
        assert (a.word_position, a.bitmap_position) == (0, 0)
        assert (b.word_position, b.bitmap_position) == (0, 1)

    def test_word_rollover_at_bitmap_end(self):
        mgr = ParallelNonceManager(window_fetcher=_fetcher(_window(0, [])), clock=lambda: 0)
        # exhaust word 0
        last = None
        for _ in range(NONCE_BITMAP_SIZE):
            last = ParallelNonce.decode(mgr.next_nonce())
        assert (last.word_position, last.bitmap_position) == (0, NONCE_BITMAP_SIZE - 1)
        nxt = ParallelNonce.decode(mgr.next_nonce())
        assert (nxt.word_position, nxt.bitmap_position) == (1, 0)

    def test_timestamp_is_now_plus_ttl(self):
        mgr = ParallelNonceManager(
            window_fetcher=_fetcher(_window(0, [])), ttl_secs=120, clock=lambda: 1000
        )
        assert ParallelNonce.decode(mgr.next_nonce()).timestamp == 1120

    def test_session_id_packed(self):
        mgr = ParallelNonceManager(
            window_fetcher=_fetcher(_window(0, [], session_id=3)),
            nonce_session_id=3,
            clock=lambda: 0,
        )
        assert ParallelNonce.decode(mgr.next_nonce()).nonce_session_id == 3

    def test_init_seats_cursor_from_window(self):
        mgr = ParallelNonceManager(window_fetcher=_fetcher(_full(2, {2: 0b111})), clock=lambda: 0)
        asyncio.run(mgr.init())
        assert mgr.cursor == (2, 3)  # base 2, bits 0..2 used -> (2, 3)

    def test_resync_resets_cursor(self):
        mgr = ParallelNonceManager(window_fetcher=_fetcher(_window(0, [])), clock=lambda: 0)
        # walk the cursor forward locally
        for _ in range(NONCE_BITMAP_SIZE + 5):
            mgr.next_nonce()
        assert mgr.cursor[0] == 1
        # chain says base advanced to 4, word 4 has bit0 used -> resync to (4, 1)
        mgr._fetch_window = _fetcher(_full(4, {4: 0b1}))  # type: ignore[attr-defined]
        asyncio.run(mgr.resync_from_chain())
        assert mgr.cursor == (4, 1)

    def test_seat_rejects_wrong_session_id(self):
        mgr = ParallelNonceManager(
            window_fetcher=_fetcher(_window(0, [], session_id=2)), nonce_session_id=0
        )
        with pytest.raises(ParallelNonceError, match="session id"):
            asyncio.run(mgr.init())

    def test_invalid_session_id_rejected(self):
        with pytest.raises(ValueError):
            ParallelNonceManager(
                window_fetcher=_fetcher(_window(0, [])),
                nonce_session_id=MAX_NONCE_SESSION_ID + 1,
            )


# --- Error classification --------------------------------------------------


class TestErrorClassification:
    def test_out_of_window(self):
        assert is_parallel_nonce_out_of_window(
            "Parallel nonce is not usable: word position out of sliding window"
        )
        assert not is_parallel_nonce_out_of_window("Expired session")
        assert not is_parallel_nonce_out_of_window(None)

    def test_nonce_too_low_is_not_a_session_error(self):
        msg = "Nonce in the request(5) is less than the nonce in the database(7)."
        assert is_nonce_too_low(msg)
        assert not is_session_error(msg)

    def test_session_error_is_not_a_nonce_error(self):
        # The key correctness rule: a session problem must NOT look like a nonce
        # problem, or retry loops burn parallel nonces resyncing for nothing.
        msg = "Invalid session address for account"
        assert is_session_error(msg)
        assert not is_parallel_nonce_out_of_window(msg)
        assert not is_nonce_too_low(msg)

    def test_classifiers_accept_exceptions(self):
        """Callers hold an exception, not a reason string. The marker can be in
        the message or in either reason, so all of them are searched."""
        from o2_sdk.errors import O2Error

        in_message = O2Error(
            message="Parallel nonce is not usable: word position out of sliding window",
            code=1000,
        )
        assert is_parallel_nonce_out_of_window(in_message)

        in_raw_reason = O2Error(
            message="Failed to process transaction",
            code=1000,
            reason="decoded summary",
            raw_reason="word position out of sliding window",
        )
        assert is_parallel_nonce_out_of_window(in_raw_reason)

        assert is_session_error(O2Error(message="Expired session"))
        assert not is_session_error(O2Error(message="Insufficient balance"))
        assert not is_parallel_nonce_out_of_window(RuntimeError("connection reset"))

    def test_already_used_is_not_treated_as_retryable(self):
        """The API wraps EVERY nonce rejection as "Parallel nonce is not usable:
        {reason}". Matching that prefix classified "nonce already used" as
        retryable, and retrying it re-submits actions that may already have
        landed (a POST whose response was lost), duplicating an order."""
        already_used = "Parallel nonce is not usable: nonce already used"
        assert is_parallel_nonce_already_used(already_used)
        assert not is_parallel_nonce_out_of_window(already_used)

    def test_out_of_window_and_expired_are_retryable(self):
        """Both prove the submission was refused at validation, so the actions
        did not execute and a fresh nonce is safe."""
        assert is_parallel_nonce_out_of_window(
            "Parallel nonce is not usable: word position out of sliding window"
        )
        assert is_parallel_nonce_out_of_window("Parallel nonce is not usable: nonce expired")

    def test_client_side_nonce_faults_are_not_retryable(self):
        """Malformed nonces are our own bug. Retrying cannot fix them and the
        error should surface."""
        for reason in (
            "Parallel nonce is not usable: reserved bits set",
            "Parallel nonce is not usable: bitmap position out of range",
            "Parallel nonce is not usable: nonce session id out of range",
        ):
            assert not is_parallel_nonce_out_of_window(reason), reason
            assert not is_parallel_nonce_already_used(reason), reason


class TestResyncCoalescing:
    """A second resync must not undo a first one.

    Concurrent submissions share a window, so they fail together. Re-seating
    moves the cursor backwards onto slots the chain has not seen consumed, so a
    second resync can hand out the position the first resync's retry already
    took.
    """

    def _window(self, base=0, bitmap=0):
        return WindowResponse(
            nonce_session_id=0,
            base=base,
            slots=[
                WindowSlot(word_position=w, bitmap=bitmap if w == base else 0) for w in range(8)
            ],
        )

    def test_second_resync_is_skipped_when_generation_moved(self):
        fetches = []

        async def fetcher():
            fetches.append(1)
            return self._window(bitmap=0b111)  # highest consumed bit 2 -> seat (0, 3)

        mgr = ParallelNonceManager(window_fetcher=fetcher)

        async def scenario():
            await mgr.init()
            assert mgr.cursor == (0, 3)
            # Two concurrent submissions both read the generation, then both fail.
            gen_a = mgr.resync_generation
            gen_b = mgr.resync_generation
            await mgr.resync_from_chain(gen_a)
            a_nonce = ParallelNonce.decode(mgr.next_nonce())
            # B's resync must not reseat the cursor back onto A's position.
            await mgr.resync_from_chain(gen_b)
            b_nonce = ParallelNonce.decode(mgr.next_nonce())
            return a_nonce, b_nonce

        a, b = asyncio.run(scenario())
        assert (a.word_position, a.bitmap_position) != (b.word_position, b.bitmap_position)
        assert len(fetches) == 2  # init + A's resync; B's was coalesced away

    def test_resync_without_a_generation_still_reseats(self):
        """The argument is optional, so an explicit unconditional resync (a
        caller recovering by hand) keeps working."""

        async def fetcher():
            return self._window(bitmap=0b1)  # seat (0, 1)

        mgr = ParallelNonceManager(window_fetcher=fetcher)

        async def scenario():
            await mgr.init()
            mgr.next_nonce()
            mgr.next_nonce()
            assert mgr.cursor == (0, 3)
            await mgr.resync_from_chain()
            return mgr.cursor

        assert asyncio.run(scenario()) == (0, 1)

    def test_generation_advances_on_each_seat(self):
        async def fetcher():
            return self._window()

        mgr = ParallelNonceManager(window_fetcher=fetcher)

        async def scenario():
            before = mgr.resync_generation
            await mgr.init()
            after_init = mgr.resync_generation
            await mgr.resync_from_chain()
            return before, after_init, mgr.resync_generation

        before, after_init, after_resync = asyncio.run(scenario())
        assert before == 0
        assert after_init == 1
        assert after_resync == 2
