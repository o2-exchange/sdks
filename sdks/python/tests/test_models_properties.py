"""Property-based tests for ``Market`` math primitives.

Implements Phase 1 of ``SDK_MATH_PROPTEST_PLAN.md``: every public math method
on ``Market`` has at least one property test, the scale→adjust→validate
pipeline invariant is asserted, and each edge case from the plan is exercised
either as an ``@example`` or as a dedicated test using explicit inputs.
"""

from __future__ import annotations

from decimal import Decimal
from math import gcd

import pytest
from hypothesis import assume, example, given, settings
from hypothesis import strategies as st

from o2_sdk.models import Market

from .strategies import (
    U64_MAX,
    _market_for,
    aligned_chain_ints,
    aligned_human_decimals,
    arbitrary_chain_ints,
    arbitrary_orders,
    markets,
    near_period_quantities,
    unaligned_human_decimals,
    valid_orders,
)

# ``max_examples`` is controlled by the active Hypothesis profile (registered
# in tests/conftest.py): 200 for ``default``, 1000 for ``HYPOTHESIS_PROFILE=ci``.


# ---------------------------------------------------------------------------
# format_price / format_quantity
# ---------------------------------------------------------------------------


@given(st.data())
def test_format_price_exactness(data: st.DataObject) -> None:
    """`format_price(c) * 10^quote.decimals == Decimal(c)` and the return
    type is always ``Decimal`` (Bug 4 regression: a float path would silently
    lose precision for large chain values)."""
    market = data.draw(markets())
    chain = data.draw(arbitrary_chain_ints(market.quote))
    out = market.format_price(chain)
    assert isinstance(out, Decimal)
    assert out * (Decimal(10) ** market.quote.decimals) == Decimal(chain)


@given(st.data())
def test_format_quantity_exactness(data: st.DataObject) -> None:
    market = data.draw(markets())
    chain = data.draw(arbitrary_chain_ints(market.base))
    out = market.format_quantity(chain)
    assert isinstance(out, Decimal)
    assert out * (Decimal(10) ** market.base.decimals) == Decimal(chain)


# ---------------------------------------------------------------------------
# scale_price / scale_quantity
# ---------------------------------------------------------------------------


@given(st.data())
def test_scale_price_precision_step(data: st.DataObject) -> None:
    """Result is a multiple of ``10**(quote.decimals - quote.max_precision)``."""
    market = data.draw(markets())
    human = data.draw(unaligned_human_decimals(market.quote))
    scaled = market.scale_price(human)
    truncate_factor = 10 ** (market.quote.decimals - market.quote.max_precision)
    assert scaled % truncate_factor == 0


@given(st.data())
def test_scale_quantity_precision_step(data: st.DataObject) -> None:
    market = data.draw(markets())
    human = data.draw(unaligned_human_decimals(market.base))
    scaled = market.scale_quantity(human)
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    assert scaled % truncate_factor == 0


@given(st.data())
def test_scale_price_floor_and_step_bound(data: st.DataObject) -> None:
    """`Decimal(scale(h))/10^d <= h` and the gap is below one precision step."""
    market = data.draw(markets())
    human = data.draw(unaligned_human_decimals(market.quote))
    scaled = market.scale_price(human)
    formatted = Decimal(scaled) / (Decimal(10) ** market.quote.decimals)
    assert formatted <= human
    step = Decimal(10) ** -market.quote.max_precision
    assert human - formatted < step


@given(st.data())
def test_scale_quantity_floor_and_step_bound(data: st.DataObject) -> None:
    market = data.draw(markets())
    human = data.draw(unaligned_human_decimals(market.base))
    scaled = market.scale_quantity(human)
    formatted = Decimal(scaled) / (Decimal(10) ** market.base.decimals)
    assert formatted <= human
    step = Decimal(10) ** -market.base.max_precision
    assert human - formatted < step


@given(st.data())
def test_scale_price_idempotent_on_aligned(data: st.DataObject) -> None:
    """Aligned inputs survive ``format(scale(h)) == h``."""
    market = data.draw(markets())
    human = data.draw(aligned_human_decimals(market.quote))
    scaled = market.scale_price(human)
    assert market.format_price(scaled) == human


@given(st.data())
def test_scale_quantity_idempotent_on_aligned(data: st.DataObject) -> None:
    market = data.draw(markets())
    human = data.draw(aligned_human_decimals(market.base))
    scaled = market.scale_quantity(human)
    assert market.format_quantity(scaled) == human


@given(st.data())
def test_scale_price_monotonic(data: st.DataObject) -> None:
    market = data.draw(markets())
    a = data.draw(unaligned_human_decimals(market.quote))
    b = data.draw(unaligned_human_decimals(market.quote))
    if a > b:
        a, b = b, a
    assert market.scale_price(a) <= market.scale_price(b)


@given(st.data())
def test_scale_quantity_monotonic(data: st.DataObject) -> None:
    market = data.draw(markets())
    a = data.draw(unaligned_human_decimals(market.base))
    b = data.draw(unaligned_human_decimals(market.base))
    if a > b:
        a, b = b, a
    assert market.scale_quantity(a) <= market.scale_quantity(b)


@given(st.data())
def test_scale_price_numeric_input_invariance(data: st.DataObject) -> None:
    """All ``NumericInput`` flavors that represent the same value produce the
    same chain integer. Covers ``Decimal``, ``str``, ``int`` (when integral),
    and ``float`` (when the value is exactly representable, so ``Decimal``
    round-tripping through ``str`` is lossless)."""
    market = data.draw(markets())
    human = data.draw(aligned_human_decimals(market.quote))
    via_decimal = market.scale_price(human)
    via_str = market.scale_price(format(human, "f"))
    assert via_decimal == via_str
    if human == human.to_integral_value():
        assert market.scale_price(int(human)) == via_decimal
    # Float path: ``_parse_human_numeric`` uses ``Decimal(str(value))``, so
    # only fully float-exact values are guaranteed to round-trip.
    as_float = float(human)
    assume(Decimal(str(as_float)) == human)
    assert market.scale_price(as_float) == via_decimal


# ---------------------------------------------------------------------------
# Round-trip invariants
# ---------------------------------------------------------------------------


@given(st.data())
def test_roundtrip_format_then_scale_price(data: st.DataObject) -> None:
    """``scale(format(c)) == c`` whenever ``c`` is a multiple of the truncate
    factor."""
    market = data.draw(markets())
    chain = data.draw(aligned_chain_ints(market.quote))
    assert market.scale_price(market.format_price(chain)) == chain


@given(st.data())
def test_roundtrip_format_then_scale_quantity(data: st.DataObject) -> None:
    market = data.draw(markets())
    chain = data.draw(aligned_chain_ints(market.base))
    assert market.scale_quantity(market.format_quantity(chain)) == chain


@given(st.data())
def test_roundtrip_scale_then_format_then_scale_is_idempotent(
    data: st.DataObject,
) -> None:
    """``scale(format(scale(h))) == scale(h)`` for arbitrary human inputs."""
    market = data.draw(markets())
    human = data.draw(unaligned_human_decimals(market.quote))
    once = market.scale_price(human)
    twice = market.scale_price(market.format_price(once))
    assert once == twice


# ---------------------------------------------------------------------------
# _validate_raw_*_precision
# ---------------------------------------------------------------------------


@given(st.data())
def test_validate_raw_price_precision_truth_table(data: st.DataObject) -> None:
    market = data.draw(markets())
    value = data.draw(arbitrary_chain_ints(market.quote))
    truncate_factor = 10 ** (market.quote.decimals - market.quote.max_precision)
    expect_ok = value % truncate_factor == 0
    if expect_ok:
        market._validate_raw_price_precision(value)
    else:
        with pytest.raises(ValueError, match="raw price precision"):
            market._validate_raw_price_precision(value)


@given(st.data())
def test_validate_raw_quantity_precision_truth_table(data: st.DataObject) -> None:
    market = data.draw(markets())
    value = data.draw(arbitrary_chain_ints(market.base))
    truncate_factor = 10 ** (market.base.decimals - market.base.max_precision)
    expect_ok = value % truncate_factor == 0
    if expect_ok:
        market._validate_raw_quantity_precision(value)
    else:
        with pytest.raises(ValueError, match="raw quantity precision"):
            market._validate_raw_quantity_precision(value)


# ---------------------------------------------------------------------------
# validate_order — oracle parity
# ---------------------------------------------------------------------------


def _expected_validate_label(market: Market, price: int, quantity: int) -> str | None:
    """Reference implementation of ``validate_order``: returns the label of the
    first failing constraint, or ``None`` if all pass."""
    base_factor = 10**market.base.decimals
    price_trunc = 10 ** (market.quote.decimals - market.quote.max_precision)
    if price % price_trunc != 0:
        return "PricePrecision"
    if (price * quantity) % base_factor != 0:
        return "FractionalPrice"
    if (price * quantity) // base_factor < int(market.min_order):
        return "min_order"
    return None


@given(st.data())
def test_validate_order_matches_reference_oracle(data: st.DataObject) -> None:
    market = data.draw(markets())
    price, quantity = data.draw(arbitrary_orders(market))
    expected = _expected_validate_label(market, price, quantity)
    if expected is None:
        market.validate_order(price, quantity)
    else:
        with pytest.raises(ValueError, match=f"^{expected}"):
            market.validate_order(price, quantity)


@given(st.data())
def test_validate_order_accepts_valid_orders(data: st.DataObject) -> None:
    """Strategy-generated valid orders never raise PricePrecision or
    FractionalPrice — they can only fail ``min_order``."""
    market = data.draw(markets())
    price, quantity = data.draw(valid_orders(market))
    try:
        market.validate_order(price, quantity)
    except ValueError as exc:
        assert str(exc).startswith("min_order"), exc


# ---------------------------------------------------------------------------
# adjust_quantity
# ---------------------------------------------------------------------------


def _assert_adjust_postcondition(market: Market, price: int, quantity: int, adjusted: int) -> None:
    base_factor = 10**market.base.decimals
    period = base_factor // gcd(price, base_factor)
    assert 0 <= adjusted <= quantity
    assert (price * adjusted) % base_factor == 0
    # No larger valid quantity exists in (adjusted, quantity].
    assert quantity - adjusted < period
    # Closed-form check.
    assert adjusted == (quantity // period) * period


@given(st.data())
def test_adjust_quantity_postcondition(data: st.DataObject) -> None:
    market = data.draw(markets())
    price = data.draw(st.integers(min_value=1, max_value=U64_MAX))
    quantity = data.draw(st.integers(min_value=0, max_value=U64_MAX))
    adjusted = market.adjust_quantity(price, quantity)
    _assert_adjust_postcondition(market, price, quantity, adjusted)


@given(st.data())
def test_adjust_quantity_postcondition_near_period(data: st.DataObject) -> None:
    """Targeted version of the postcondition test that puts quantity near a
    period boundary, where off-by-one errors are most likely to surface."""
    market = data.draw(markets())
    price = data.draw(st.integers(min_value=1, max_value=10**12))
    quantity = data.draw(near_period_quantities(market, price))
    adjusted = market.adjust_quantity(price, quantity)
    _assert_adjust_postcondition(market, price, quantity, adjusted)


@given(st.data())
def test_adjust_quantity_idempotent(data: st.DataObject) -> None:
    market = data.draw(markets())
    price = data.draw(st.integers(min_value=1, max_value=U64_MAX))
    quantity = data.draw(st.integers(min_value=0, max_value=U64_MAX))
    once = market.adjust_quantity(price, quantity)
    twice = market.adjust_quantity(price, once)
    assert once == twice


@given(st.data())
def test_adjust_quantity_monotonic_in_quantity(data: st.DataObject) -> None:
    market = data.draw(markets())
    price = data.draw(st.integers(min_value=1, max_value=U64_MAX))
    a = data.draw(st.integers(min_value=0, max_value=U64_MAX))
    b = data.draw(st.integers(min_value=0, max_value=U64_MAX))
    if a > b:
        a, b = b, a
    assert market.adjust_quantity(price, a) <= market.adjust_quantity(price, b)


@given(markets(), st.integers(min_value=-(10**6), max_value=0))
def test_adjust_quantity_rejects_non_positive_price(market: Market, price: int) -> None:
    with pytest.raises(ValueError, match="price must be positive"):
        market.adjust_quantity(price, 1)


# ---------------------------------------------------------------------------
# Pipeline: scale → adjust → validate
# ---------------------------------------------------------------------------


@given(st.data())
def test_pipeline_only_min_order_can_fail(data: st.DataObject) -> None:
    """The full ``scale → adjust → validate`` pipeline must never raise
    PricePrecision or FractionalPrice: those constraints are owned by the
    SDK and are guaranteed by the upstream scaling steps. ``min_order`` may
    still fail for tiny inputs and that's expected behaviour."""
    market = data.draw(markets())
    human_price = data.draw(unaligned_human_decimals(market.quote))
    human_quantity = data.draw(unaligned_human_decimals(market.base))

    scaled_price = market.scale_price(human_price)
    scaled_quantity = market.scale_quantity(human_quantity)
    assume(scaled_price > 0)
    adjusted_quantity = market.adjust_quantity(scaled_price, scaled_quantity)
    try:
        market.validate_order(scaled_price, adjusted_quantity)
    except ValueError as exc:
        msg = str(exc)
        assert msg.startswith("min_order"), msg


@given(st.data())
def test_pipeline_no_silent_quantity_inflation(data: st.DataObject) -> None:
    market = data.draw(markets())
    human_price = data.draw(unaligned_human_decimals(market.quote))
    human_quantity = data.draw(unaligned_human_decimals(market.base))

    scaled_price = market.scale_price(human_price)
    scaled_quantity = market.scale_quantity(human_quantity)
    assume(scaled_price > 0)
    adjusted = market.adjust_quantity(scaled_price, scaled_quantity)
    assert adjusted <= scaled_quantity


@given(st.data())
def test_pipeline_no_silent_price_drift(data: st.DataObject) -> None:
    """``adjust_quantity`` must not change the price."""
    market = data.draw(markets())
    human_price = data.draw(unaligned_human_decimals(market.quote))
    human_quantity = data.draw(unaligned_human_decimals(market.base))

    scaled_price = market.scale_price(human_price)
    scaled_quantity = market.scale_quantity(human_quantity)
    assume(scaled_price > 0)
    _ = market.adjust_quantity(scaled_price, scaled_quantity)
    # Re-scaling must be deterministic.
    assert market.scale_price(human_price) == scaled_price


# ---------------------------------------------------------------------------
# Explicit edge cases (from the plan's edge-case list).
#
# Property tests use ``st.data()`` so they can't take ``@example`` decorators
# directly; the per-edge-case coverage lives in these dedicated tests. Each
# test exercises the same invariant a property test does, on a hand-picked
# input.
# ---------------------------------------------------------------------------


@example(1, 2**63)
@example(2**63, 2**63)  # near the top of u64
@example(7, 10**18)  # coprime price, max-decimal market
@example(10**18, 1234)  # price == base_factor → period = 1
@example(10**18 + 1, 1234)  # price > base_factor
@settings(max_examples=10, deadline=None)
@given(
    st.integers(min_value=1, max_value=U64_MAX),
    st.integers(min_value=0, max_value=U64_MAX),
)
def test_adjust_quantity_edge_cases(price: int, quantity: int) -> None:
    """High-decimal market with edge-case ``(price, quantity)`` operands."""
    market = _market_for(18, 18, 18, 18, min_order=0)
    adjusted = market.adjust_quantity(price, quantity)
    _assert_adjust_postcondition(market, price, quantity, adjusted)


def test_adjust_quantity_rejects_zero_price_at_edges() -> None:
    """Explicit cover for the ``price == 0`` rejection branch on a
    high-decimal market — separated from the value-asserting edge-case test
    because the two branches assert different things."""
    market = _market_for(18, 18, 18, 18, min_order=0)
    for quantity in (0, 1, U64_MAX):
        with pytest.raises(ValueError, match="price must be positive"):
            market.adjust_quantity(0, quantity)


def test_decimals_zero_market_pipeline() -> None:
    """A degenerate but legal market with no fractional part."""
    market = _market_for(0, 0, 0, 0)
    # All chain values are already aligned; scale/format are identity.
    assert market.scale_price(Decimal("5")) == 5
    assert market.format_price(5) == Decimal("5")
    assert market.adjust_quantity(3, 10) == 10
    market.validate_order(3, 10)


def test_decimals_equals_max_precision_no_truncation() -> None:
    """When ``max_precision == decimals`` the truncate factor is 1 — every
    chain integer is precision-aligned."""
    market = _market_for(6, 6, 6, 6)
    # Any integer chain value must be accepted as precision-aligned.
    market._validate_raw_price_precision(123_456)
    market._validate_raw_quantity_precision(987_654)
    # scale_price truncates to the integer part times 10^6.
    assert market.scale_price(Decimal("1.234567")) == 1_234_567


def test_eighteen_decimal_market_preserves_precision() -> None:
    """Bug 4 regression: an 18-decimal market with a 19-significant-digit
    chain value must round-trip without precision loss."""
    market = _market_for(18, 18, 18, 18)
    chain = 1_234_567_890_123_456_789  # 19 sig digits, beyond float53 precision
    human = market.format_price(chain)
    assert human == Decimal("1.234567890123456789")
    assert market.scale_price(human) == chain


def test_quantity_zero_passes_fractional_price() -> None:
    market = _market_for(9, 3, 6, 4)
    # 0 satisfies (price * 0) % base_factor == 0 for any price.
    assert market.adjust_quantity(123_456_789, 0) == 0


def test_quantity_one_below_period_returns_zero() -> None:
    """`quantity == 1` is the smallest valid u64 input; if it's below the
    period the adjusted result is 0 (no positive valid quantity fits)."""
    market = _market_for(9, 3, 6, 4)
    assert market.adjust_quantity(7, 1) == 0  # period = 10^9, qty=1 → 0


def test_quantity_u64_max_postcondition() -> None:
    market = _market_for(9, 3, 6, 4)
    price = 1_000_000  # period = 10^9 / gcd(10^6, 10^9) = 10^9 / 10^6 = 10^3
    adjusted = market.adjust_quantity(price, U64_MAX)
    _assert_adjust_postcondition(market, price, U64_MAX, adjusted)


def test_price_one_coprime_to_base_factor() -> None:
    """price=1 → gcd=1 → period == base_factor; any quantity below it → 0."""
    market = _market_for(9, 9, 6, 6)
    assert market.adjust_quantity(1, 10**8) == 0
    assert market.adjust_quantity(1, 10**9) == 10**9


def test_price_equal_to_base_factor() -> None:
    """price == base_factor → gcd=base_factor → period=1; any quantity is valid."""
    market = _market_for(9, 9, 6, 6)
    base_factor = 10**9
    assert market.adjust_quantity(base_factor, 42) == 42


def test_price_greater_than_base_factor() -> None:
    market = _market_for(9, 9, 6, 6)
    base_factor = 10**9
    # price = base_factor + base_factor = 2*base_factor → gcd = base_factor → period = 1
    assert market.adjust_quantity(2 * base_factor, 42) == 42


def test_human_price_binary_representable_vs_not() -> None:
    """``0.5`` is binary-exact, ``0.1`` is not; both must scale identically
    when fed as strings (the SDK's ``_parse_human_numeric`` normalizes)."""
    market = _market_for(9, 9, 9, 9)
    assert market.scale_price(Decimal("0.5")) == 500_000_000
    assert market.scale_price("0.5") == 500_000_000
    assert market.scale_price(Decimal("0.1")) == 100_000_000
    assert market.scale_price("0.1") == 100_000_000


def test_human_price_with_more_digits_than_decimals_truncates() -> None:
    market = _market_for(9, 6, 9, 6)
    # 0.123456789 with max_precision=6 truncates to 0.123456 (i.e. 123_456_000).
    assert market.scale_price(Decimal("0.123456789")) == 123_456_000


def test_human_price_zero() -> None:
    market = _market_for(9, 6, 9, 6)
    assert market.scale_price(0) == 0
    assert market.scale_price(Decimal(0)) == 0
    assert market.format_price(0) == Decimal(0)
