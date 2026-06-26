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
            window_fetcher=_fetcher(_window(0, [], session_id=3)), nonce_session_id=3, clock=lambda: 0
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
