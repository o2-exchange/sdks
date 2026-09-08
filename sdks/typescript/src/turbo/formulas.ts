/**
 * The margin account's VALUE math.
 *
 * Mirrors the pool's own `formulas.rs`, including the ROUNDING SIDE of each
 * leg — which is not cosmetic. The chain rounds a debt UP, so a client that
 * floors one reports an account as marginally healthier than the pool
 * considers it and offers orders the pool then refuses.
 *
 * Everything is raw: quantities in their asset's base units, prices
 * 1e18-scaled as the wire serves them, results in collateral base units.
 *
 * @module
 */

/** Prices on the wire are 1e18-scaled. */
export function scaleFor(assetDecimals: number, collateralDecimals: number): bigint {
  return 10n ** BigInt(18 + assetDecimals - Math.min(collateralDecimals, 18));
}

/** `formulas::value` — FLOORED, for what the account owns. */
export function value(
  amount: bigint,
  price: bigint,
  assetDecimals: number,
  collateralDecimals: number,
): bigint {
  return (amount * price) / scaleFor(assetDecimals, collateralDecimals);
}

/** `formulas::value_ceil` — CEILED, for what the account owes. */
export function valueCeil(
  amount: bigint,
  price: bigint,
  assetDecimals: number,
  collateralDecimals: number,
): bigint {
  const scale = scaleFor(assetDecimals, collateralDecimals);
  const product = amount * price;
  return product === 0n ? 0n : (product + scale - 1n) / scale;
}

/** Absolute value. */
export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Larger of two. */
export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Smaller of two. */
export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Coerce a wire figure (string | number | bigint) to bigint. */
export function big(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  return BigInt(typeof v === "number" ? Math.trunc(v) : v);
}

/**
 * Parse a decimal string into base units EXACTLY, without going through a
 * float.
 *
 * `Number("0.1") * 10 ** 18` is not `10n ** 17n`, and on a credit line the
 * difference is money. Used for collateral notionals, whose scale is the
 * collateral asset's rather than any market's.
 */
export function scaleDecimalString(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`Not a decimal number: ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  if (fraction.length > decimals) {
    // Truncate rather than round: asking for more precision than the asset
    // has is a caller error we can absorb, but rounding UP a notional
    // would size an order the line cannot fund.
    const scaled = BigInt(`${whole || "0"}${fraction.slice(0, decimals)}`);
    return negative ? -scaled : scaled;
  }
  const padded = fraction.padEnd(decimals, "0");
  const scaled = BigInt(`${whole || "0"}${padded}`);
  return negative ? -scaled : scaled;
}
