import { ExchangeError, OperationFailed } from "ccxt";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  InsufficientFunds,
  mapO2Error,
  NetworkError,
  O2AmbiguousSubmission,
  O2CCXT,
  RateLimitExceeded,
} from "../../src/ccxt/index.js";
import {
  InvalidSession,
  O2Error,
  RateLimitExceeded as O2RateLimitExceeded,
  OnChainRevertError,
} from "../../src/errors.js";
import { Network, O2Client } from "../../src/index.js";
import {
  assetId,
  contractId,
  type Market,
  marketId,
  SessionActionsResponse,
  tradeAccountId,
  txId,
} from "../../src/models.js";

const ACCOUNT_ID = tradeAccountId(`0x${"11".repeat(32)}`);
const MARKET: Market = {
  contract_id: contractId(`0x${"22".repeat(32)}`),
  market_id: marketId(`0x${"33".repeat(32)}`),
  pair: "FUEL/USDC",
  maker_fee: 0n,
  taker_fee: 0n,
  min_order: 1n,
  dust: 0n,
  price_window: 0,
  base: {
    symbol: "FUEL",
    asset: assetId(`0x${"44".repeat(32)}`),
    decimals: 9,
    max_precision: 9,
  },
  quote: {
    symbol: "USDC",
    asset: assetId(`0x${"55".repeat(32)}`),
    decimals: 6,
    max_precision: 6,
  },
};

function setup() {
  const client = new O2Client({ network: Network.TESTNET });
  vi.spyOn(client, "getMarkets").mockResolvedValue([MARKET]);
  return { client, exchange: new O2CCXT({ client, tradeAccountId: ACCOUNT_ID }) };
}

describe("official CCXT error mapping", () => {
  it("maps authentication, balance, rate-limit, and network errors", () => {
    const authentication = mapO2Error(new InvalidSession("expired"));
    const funds = mapO2Error(new OnChainRevertError("reverted", "WithdrawError::NotEnoughBalance"));
    const rate = mapO2Error(new O2RateLimitExceeded("slow down"));
    const network = mapO2Error(new TypeError("fetch failed"));

    expect(authentication).toBeInstanceOf(AuthenticationError);
    expect(authentication).toBeInstanceOf(ExchangeError);
    expect(authentication.originalError).toBeInstanceOf(InvalidSession);
    expect(funds).toBeInstanceOf(InsufficientFunds);
    expect(rate).toBeInstanceOf(RateLimitExceeded);
    expect(network).toBeInstanceOf(NetworkError);
  });

  it("maps native minimum-order validation to InvalidOrder", () => {
    const error = mapO2Error(new O2Error("Order value below min_order"));

    expect(error.name).toBe("InvalidOrder");
    expect(error.originalError).toBeInstanceOf(O2Error);
  });

  it("treats a lost private submission response as ambiguous without retrying", async () => {
    const { client, exchange } = setup();
    const create = vi
      .spyOn(client, "createOrder")
      .mockRejectedValue(new TypeError("socket closed"));

    await expect(exchange.createOrder("FUEL/USDC", "limit", "buy", 2, 1.5)).rejects.toMatchObject({
      name: "O2AmbiguousSubmission",
      transactionId: null,
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("treats a transaction without a returned order as ambiguous", async () => {
    const { client, exchange } = setup();
    const transactionId = txId(`0x${"77".repeat(32)}`);
    vi.spyOn(client, "createOrder").mockResolvedValue(
      new SessionActionsResponse(transactionId, null, null, null, null, null),
    );

    const error = await exchange
      .createOrder("FUEL/USDC", "limit", "buy", 2, 1.5)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(O2AmbiguousSubmission);
    expect(error).toBeInstanceOf(OperationFailed);
    expect(error).toMatchObject({ transactionId });
  });

  it("maps structured action rejection instead of reporting ambiguity", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "createOrder").mockResolvedValue(
      new SessionActionsResponse(null, null, null, null, 4001, "session expired"),
    );

    await expect(exchange.createOrder("FUEL/USDC", "limit", "buy", 2, 1.5)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("maps definitive insufficient-balance reverts", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "createOrder").mockResolvedValue(
      new SessionActionsResponse(
        txId(`0x${"88".repeat(32)}`),
        null,
        "OrderCreationError::NotEnoughBalance",
        [],
        null,
        "transaction reverted",
      ),
    );

    await expect(exchange.createOrder("FUEL/USDC", "limit", "buy", 2, 1.5)).rejects.toBeInstanceOf(
      InsufficientFunds,
    );
  });
});
