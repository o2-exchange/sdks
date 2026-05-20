"""Hypothesis strategies for ``Market`` math property tests.

Generators here mirror the structure described in
``SDK_MATH_PROPTEST_PLAN.md`` (Phase 1). They produce ``Market`` instances
together with human/chain inputs that respect the contract invariants:

- ``BASE_DECIMALS``, ``QUOTE_DECIMALS``, ``PRICE_PRECISION``,
  ``QUANTITY_PRECISION`` are powers of 10.
- ``base.decimals >= quote.decimals``.
- ``base.max_precision <= base.decimals`` (likewise for quote).
- Submitted ``price`` and ``quantity`` fit in u64.
"""

from __future__ import annotations

from decimal import Decimal
from math import gcd
from typing import Final

from hypothesis import strategies as st

from o2_sdk.models import Id, Market, MarketAsset

# u64 ceiling — the contract stores prices/quantities as ``u64`` (see
# ``contracts/order-book/src/main.sw``). Property tests stay strictly below
# this bound so the generated chain values are submittable.
U64_MAX: Final[int] = 2**64 - 1

# Cap human magnitudes at a level whose chain representation fits in u64 even
# for an 18-decimal asset (10^15 * 10^18 = 10^33 ≪ 2^64, but we keep an order
# of magnitude of headroom for sums in pipeline tests).
HUMAN_MAGNITUDE_CAP: Final[Decimal] = Decimal("10") ** 6

# Biased pool of realistic O2 market configurations
# (base_decimals, base_max_precision, quote_decimals, quote_max_precision).
REALISTIC_CONFIGS: Final[list[tuple[int, int, int, int]]] = [
    (9, 9, 6, 6),  # full-precision USDC-style
    (9, 6, 6, 4),  # coarse precision
    (18, 18, 6, 6),  # ETH-like base
    (9, 3, 9, 9),  # the legacy unit-test config
    (6, 6, 6, 6),  # symmetric low-decimal
    (0, 0, 0, 0),  # degenerate-but-legal: no fractional part
]

_HEX_BASE = "0x" + "ab" * 32
_HEX_QUOTE = "0x" + "cd" * 32


def _market_for(
    base_decimals: int,
    base_max_precision: int,
    quote_decimals: int,
    quote_max_precision: int,
    min_order: int = 0,
) -> Market:
    return Market(
        contract_id=Id("0x" + "ee" * 32),
        market_id=Id("0x" + "ff" * 32),
        maker_fee="0",
        taker_fee="0",
        min_order=str(min_order),
        dust="0",
        price_window=0,
        base=MarketAsset(
            symbol="B",
            asset=_HEX_BASE,
            decimals=base_decimals,
            max_precision=base_max_precision,
        ),
        quote=MarketAsset(
            symbol="Q",
            asset=_HEX_QUOTE,
            decimals=quote_decimals,
            max_precision=quote_max_precision,
        ),
    )


# ---------------------------------------------------------------------------
# Market strategies
# ---------------------------------------------------------------------------


@st.composite
def markets(draw: st.DrawFn, *, min_order_max: int = 10**9) -> Market:
    """Generate a Market respecting the contract's decimal invariants.

    Biases toward the realistic O2 configurations listed above (50% of
    examples) so the test suite exercises real-world shapes alongside
    random ones.
    """
    if draw(st.booleans()):
        bd, bmp, qd, qmp = draw(st.sampled_from(REALISTIC_CONFIGS))
    else:
        bd = draw(st.integers(min_value=0, max_value=18))
        qd = draw(st.integers(min_value=0, max_value=bd))
        bmp = draw(st.integers(min_value=0, max_value=bd))
        qmp = draw(st.integers(min_value=0, max_value=qd))
    min_order = draw(st.integers(min_value=0, max_value=min_order_max))
    return _market_for(bd, bmp, qd, qmp, min_order=min_order)


# ---------------------------------------------------------------------------
# Human-readable Decimal inputs
# ---------------------------------------------------------------------------


@st.composite
def aligned_human_decimals(draw: st.DrawFn, asset: MarketAsset) -> Decimal:
    """A non-negative ``Decimal`` that is an exact multiple of the asset's
    precision step (``10**-max_precision``). Roundtrip should be lossless."""
    truncate_factor = 10 ** (asset.decimals - asset.max_precision)
    # Cap scaled value well below u64 to keep downstream pipeline tests safe.
    scaled_max = min(U64_MAX // 2, 10 ** (asset.decimals + 9))
    scaled = draw(st.integers(min_value=0, max_value=scaled_max))
    aligned = (scaled // truncate_factor) * truncate_factor
    return Decimal(aligned) / (Decimal(10) ** asset.decimals)


@st.composite
def unaligned_human_decimals(draw: st.DrawFn, asset: MarketAsset) -> Decimal:
    """A non-negative ``Decimal`` with up to ``decimals + 4`` fractional
    digits. Roundtrip is lossy by design — exercises truncation. Capped so
    the scaled chain representation always fits in u64 (otherwise the
    scaled output would not be submittable on-chain)."""
    # ``scale_*`` multiplies by ``10**decimals`` and floors; clamp the integer
    # part so the result stays under U64_MAX // 2 even at 18 decimals.
    scale_factor = 10**asset.decimals
    integer_max = min(int(HUMAN_MAGNITUDE_CAP), (U64_MAX // 2) // max(scale_factor, 1))
    integer_part = draw(st.integers(min_value=0, max_value=max(integer_max, 0)))
    frac_digits = asset.decimals + 4
    frac_part = draw(st.integers(min_value=0, max_value=10**frac_digits - 1))
    return Decimal(integer_part) + Decimal(frac_part) / Decimal(10**frac_digits)


# ---------------------------------------------------------------------------
# Chain integer inputs
# ---------------------------------------------------------------------------


@st.composite
def aligned_chain_ints(draw: st.DrawFn, asset: MarketAsset) -> int:
    """A non-negative u64-fitting integer that is a multiple of the asset's
    precision truncate factor (``10**(decimals - max_precision)``)."""
    truncate_factor = 10 ** (asset.decimals - asset.max_precision)
    multiples_max = U64_MAX // max(truncate_factor, 1)
    multiple = draw(st.integers(min_value=0, max_value=multiples_max))
    return multiple * truncate_factor


@st.composite
def arbitrary_chain_ints(draw: st.DrawFn, asset: MarketAsset) -> int:
    """Any non-negative u64-fitting integer. Used to probe the precision
    validators' decision boundary."""
    del asset  # not used; kept for signature symmetry with aligned_chain_ints
    return draw(st.integers(min_value=0, max_value=U64_MAX))


# ---------------------------------------------------------------------------
# (price, quantity) tuples for validate / adjust / pipeline tests
# ---------------------------------------------------------------------------


@st.composite
def valid_orders(draw: st.DrawFn, market: Market) -> tuple[int, int]:
    """A ``(price, quantity)`` pair guaranteed to satisfy PricePrecision and
    FractionalPrice. Used as a positive oracle for ``validate_order`` and as
    a feeder for the pipeline test."""
    base_factor = 10**market.base.decimals
    price_step = 10 ** (market.quote.decimals - market.quote.max_precision)
    # Pick a price aligned to PricePrecision, bounded so price*quantity stays
    # comfortably under u64.
    price_multiples_max = max(1, (U64_MAX // 2) // max(price_step, 1))
    price = draw(st.integers(min_value=1, max_value=min(price_multiples_max, 10**12))) * price_step
    # Quantity must be a multiple of the FractionalPrice period for *this* price.
    period = base_factor // gcd(price, base_factor)
    quantity_multiples_max = max(1, (U64_MAX // 2) // max(price * period, 1))
    quantity = (
        draw(st.integers(min_value=0, max_value=min(quantity_multiples_max, 10**12))) * period
    )
    return price, quantity


@st.composite
def arbitrary_orders(draw: st.DrawFn, market: Market) -> tuple[int, int]:
    """Any ``(price, quantity)`` pair in u64 range — most will fail at least
    one validator."""
    del market
    price = draw(st.integers(min_value=0, max_value=U64_MAX))
    quantity = draw(st.integers(min_value=0, max_value=U64_MAX))
    return price, quantity


@st.composite
def near_period_quantities(draw: st.DrawFn, market: Market, price: int) -> int:
    """Generate ``quantity = k*period ± δ`` for small ``δ`` so we exercise the
    boundary cases of ``adjust_quantity``."""
    base_factor = 10**market.base.decimals
    period = base_factor // gcd(max(price, 1), base_factor)
    # Cap k so k*period stays under u64.
    k_max = max(1, U64_MAX // max(period, 1))
    k = draw(st.integers(min_value=0, max_value=min(k_max, 10**12)))
    delta = draw(st.integers(min_value=-min(period, 10**6), max_value=min(period, 10**6)))
    return max(0, k * period + delta)
