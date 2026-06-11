/**
 * Shared utility helpers for advanced O2 SDK users.
 *
 * These helpers mirror the normalization and resolution logic used by
 * {@link O2Client}, so app code can build custom flows without copying
 * client-local implementation details.
 *
 * @module
 */

import { scalePriceString } from "./encoding.js";
import { O2Error } from "./errors.js";
import type {
  AssetId,
  Market,
  MarketRef,
  MarketsResponse,
  Numeric,
  OrderType,
  Side,
  WireOrderType,
} from "./models.js";
import { assetId as toAssetId } from "./models.js";

type MarketsInput = MarketsResponse | readonly Market[];

/** Resolved asset metadata for a known or unknown asset ID. */
export interface ResolvedAsset {
  /** The normalized asset ID. */
  assetId: AssetId;
  /** Asset decimals when the asset is present in market metadata. */
  decimals: number | undefined;
}

/** Runtime guard for Numeric values coming from untyped JavaScript callers. */
export function ensureNumeric(value: Numeric, fieldName: string): Numeric {
  if (typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  throw new O2Error(`Invalid ${fieldName} type: expected string or bigint, got ${typeof value}`);
}

/** Convert user-facing side values to the API wire format. */
export function capitalizeSide(side: Side): "Buy" | "Sell" {
  return side === "buy" ? "Buy" : "Sell";
}

/** Scale a single Numeric price to a chain integer string. */
export function scaleNumericPrice(
  value: Numeric,
  decimals: number,
  maxPrecision: number,
  fieldName = "price",
): string {
  const normalized = ensureNumeric(value, fieldName);
  if (typeof normalized === "bigint") return normalized.toString();
  return scalePriceString(normalized, decimals, maxPrecision).toString();
}

/** Convert an OrderType with Numeric prices to a wire-format OrderType. */
export function scaleOrderType(orderType: OrderType, market: Market): WireOrderType {
  if (typeof orderType === "string") return orderType;
  if ("Limit" in orderType) {
    const [price, timestamp] = orderType.Limit;
    return {
      Limit: [
        scaleNumericPrice(
          price,
          market.quote.decimals,
          market.quote.max_precision,
          "orderType.Limit.price",
        ),
        timestamp,
      ],
    };
  }
  return {
    BoundedMarket: {
      max_price: scaleNumericPrice(
        orderType.BoundedMarket.max_price,
        market.quote.decimals,
        market.quote.max_precision,
        "orderType.BoundedMarket.max_price",
      ),
      min_price: scaleNumericPrice(
        orderType.BoundedMarket.min_price,
        market.quote.decimals,
        market.quote.max_precision,
        "orderType.BoundedMarket.min_price",
      ),
    },
  };
}

function getMarkets(input: MarketsInput): readonly Market[] {
  return "markets" in input ? input.markets : input;
}

/** Resolve a market by symbol pair or hex market ID. */
export function resolveMarket(
  marketsData: MarketsResponse | readonly Market[],
  symbolPair: string,
): Market {
  const markets = getMarkets(marketsData);

  // Accept hex market_id.
  if (symbolPair.startsWith("0x") || symbolPair.startsWith("0X")) {
    const normalized = symbolPair.toLowerCase();
    const found = markets.find((m) => m.market_id.toLowerCase() === normalized);
    if (found) return found;
    throw new O2Error(`Market not found: ${symbolPair}`);
  }

  // Accept "BASE/QUOTE" format.
  const [baseSymbol, quoteSymbol] = symbolPair.split("/");
  if (!baseSymbol || !quoteSymbol) {
    throw new O2Error(`Market not found: ${symbolPair}`);
  }

  const base = baseSymbol.toLowerCase();
  const quote = quoteSymbol.toLowerCase();
  const found = markets.find(
    (m) => m.base.symbol.toLowerCase() === base && m.quote.symbol.toLowerCase() === quote,
  );

  if (!found) {
    const altFound = markets.find(
      (m) =>
        (m.base.symbol.toLowerCase() === base || m.base.symbol.toLowerCase() === `f${base}`) &&
        (m.quote.symbol.toLowerCase() === quote || m.quote.symbol.toLowerCase() === `f${quote}`),
    );
    if (altFound) return altFound;
    throw new O2Error(
      `Market not found: ${symbolPair}. Available: ${markets.map((m) => `${m.base.symbol}/${m.quote.symbol}`).join(", ")}`,
    );
  }

  return found;
}

/** Resolve a {@link MarketRef} to a full Market object. */
export function resolveMarketRef(
  marketsData: MarketsResponse | readonly Market[],
  market: MarketRef,
): Market {
  return typeof market === "string" ? resolveMarket(marketsData, market) : market;
}

/** Resolve an asset by symbol name or hex asset ID. */
export function resolveAsset(
  marketsData: MarketsResponse | readonly Market[],
  symbolOrId: string,
): ResolvedAsset {
  const markets = getMarkets(marketsData);

  if (symbolOrId.startsWith("0x") || symbolOrId.startsWith("0X")) {
    const normalized = toAssetId(symbolOrId);
    for (const market of markets) {
      if (toAssetId(market.base.asset) === normalized) {
        return { assetId: market.base.asset, decimals: market.base.decimals };
      }
      if (toAssetId(market.quote.asset) === normalized) {
        return { assetId: market.quote.asset, decimals: market.quote.decimals };
      }
    }
    return { assetId: normalized, decimals: undefined };
  }

  const symbol = symbolOrId.toLowerCase();
  for (const market of markets) {
    if (market.base.symbol.toLowerCase() === symbol) {
      return { assetId: market.base.asset, decimals: market.base.decimals };
    }
    if (market.quote.symbol.toLowerCase() === symbol) {
      return { assetId: market.quote.asset, decimals: market.quote.decimals };
    }
  }

  throw new O2Error(
    `Asset not found: ${symbolOrId}. Available: ${[...new Set(markets.flatMap((m) => [m.base.symbol, m.quote.symbol]))].join(", ")}`,
  );
}
