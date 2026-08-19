import type {
  Balances,
  Market as CCXTOfficialMarket,
  Order as CCXTOfficialOrder,
  Trade as CCXTOfficialTrade,
  OHLCV,
  OrderBook,
  OrderSide,
  Ticker,
  Transaction,
} from "ccxt";
import { Exchange, Precise } from "ccxt";
import type { MarketActionGroup, Numeric } from "../actions.js";
import { O2Client } from "../client.js";
import type { Network } from "../config.js";
import type { Signer } from "../crypto.js";
import { OnChainRevertError, parseApiError } from "../errors.js";
import type { MarketRef, OrderType, SessionState, TradeAccountId } from "../models.js";
import { orderId, type SessionActionsResponse, tradeAccountId } from "../models.js";
import {
  ArgumentsRequired,
  AuthenticationError,
  BadRequest,
  BadSymbol,
  InvalidOrder,
  mapO2Error,
  NotSupported,
  O2AmbiguousSubmission,
  OperationFailed,
} from "./errors.js";
import {
  CCXT_TIMEFRAMES,
  numberOrNull,
  parseBalance,
  parseMarket,
  parseOHLCV,
  parseOrder,
  parseOrderBook,
  parseTicker,
  parseTrade,
} from "./parsers.js";
import type { CCXTMarket, CCXTParams, O2CCXTOptions } from "./types.js";

function optionalBoolean(params: CCXTParams, key: string, fallback: boolean): boolean {
  const value = params[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InvalidOrder(`${key} must be a boolean`);
  return value;
}

function requiredPositiveNumeric(params: CCXTParams, key: string): Numeric {
  const value = params[key];
  if (typeof value === "bigint") {
    if (value > 0n) return value;
  } else if (typeof value === "number") {
    if (Number.isFinite(value) && value > 0) return String(value);
  } else if (typeof value === "string") {
    if (value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0) return value;
  }
  throw new ArgumentsRequired(
    `createOrder market orders require a positive params.${key} O2 price bound`,
  );
}

const CCXT_TRUNCATE = 0;
const CCXT_DECIMAL_PLACES = 2;

function protectedPriceToPrecision(
  exchange: Exchange,
  value: Numeric,
  side: OrderSide,
  precision: number,
): string {
  const input = String(value);
  const truncated = exchange.decimalToPrecision(
    input,
    CCXT_TRUNCATE,
    precision,
    CCXT_DECIMAL_PLACES,
  );
  if (side === "buy") {
    if (Precise.stringLe(truncated, "0")) {
      throw new InvalidOrder("createOrder market maxPrice is below the minimum price precision");
    }
    return truncated;
  }
  if (Precise.stringGe(truncated, input)) return truncated;
  const step = precision === 0 ? "1" : `0.${"0".repeat(precision - 1)}1`;
  const incremented = Precise.stringAdd(truncated, step);
  if (incremented === undefined) throw new InvalidOrder("createOrder requires a valid price");
  return incremented;
}

/**
 * Official CCXT Exchange implementation backed by {@link O2Client}.
 *
 * @alpha This O2-maintained API is not part of the official CCXT package.
 */
export class O2CCXT extends Exchange {
  /** Native SDK client used for O2 transport, signing, sessions, and nonces. */
  readonly o2Client: O2Client;
  private configuredTradeAccountId?: TradeAccountId;
  private ownerSigner?: Signer;

  constructor(options: O2CCXTOptions = {}) {
    const {
      client,
      network,
      config,
      privateKey,
      signer,
      session,
      tradeAccountId: configuredTradeAccountId,
      ...ccxtOptions
    } = options;
    super(ccxtOptions);
    if (privateKey && signer) {
      throw new AuthenticationError("Provide privateKey or signer, not both");
    }
    this.o2Client =
      client ??
      new O2Client({
        network: network as Network | undefined,
        config,
        // A private response can be lost after acceptance. The compatibility
        // adapter therefore creates a single-attempt client by default.
        apiOptions: { maxRetries: 0 },
      });
    this.ownerSigner = signer ?? (privateKey ? O2Client.loadWallet(privateKey) : undefined);
    if (session) this.restoreSession(session);
    if (configuredTradeAccountId) {
      this.configuredTradeAccountId = tradeAccountId(configuredTradeAccountId);
    }
  }

  override describe() {
    return this.deepExtend(super.describe(), {
      id: "o2",
      name: "O2 Exchange",
      version: "v1",
      countries: [],
      rateLimit: 0,
      enableRateLimit: false,
      precisionMode: CCXT_DECIMAL_PLACES,
      dex: true,
      has: {
        fetchMarkets: true,
        fetchOrderBook: true,
        fetchL2OrderBook: true,
        fetchTrades: true,
        fetchTicker: true,
        fetchOHLCV: true,
        fetchBalance: true,
        createOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: true,
        fetchOrder: true,
        fetchOrders: true,
        fetchOpenOrders: true,
        fetchClosedOrders: true,
        fetchMyTrades: true,
        withdraw: true,
        watchOrderBook: false,
        watchTrades: false,
        watchOrders: false,
      },
      timeframes: Object.fromEntries(Object.keys(CCXT_TIMEFRAMES).map((key) => [key, key])),
    });
  }

  override async fetchMarkets(_params: CCXTParams = {}): Promise<CCXTOfficialMarket[]> {
    return this.read(
      async () =>
        (await this.o2Client.getMarkets())
          // CCXT keys markets by symbol. Test/private O2 books without public
          // asset symbols would otherwise collapse into the same "/" market.
          .filter((market) => market.base.symbol.trim() !== "" && market.quote.symbol.trim() !== "")
          .map(parseMarket) as unknown as CCXTOfficialMarket[],
    );
  }

  override async fetchTicker(symbol: string, _params: CCXTParams = {}): Promise<Ticker> {
    const market = await this.resolveMarket(symbol);
    return this.read(
      async () =>
        parseTicker(await this.o2Client.getTicker(market.info), market) as unknown as Ticker,
    );
  }

  override async fetchOrderBook(
    symbol: string,
    limit?: number,
    params: CCXTParams = {},
  ): Promise<OrderBook> {
    const market = await this.resolveMarket(symbol);
    const requestedPrecision = params.precision;
    const parsedPrecision = numberOrNull(requestedPrecision);
    if (
      requestedPrecision !== undefined &&
      (parsedPrecision === null ||
        !Number.isInteger(parsedPrecision) ||
        parsedPrecision < 1 ||
        parsedPrecision > 18)
    ) {
      throw new BadRequest("fetchOrderBook params.precision must be an integer from 1 to 18");
    }
    const precision = parsedPrecision ?? 1;
    return this.read(
      async () =>
        parseOrderBook(
          await this.o2Client.getDepth(market.info, precision, limit),
          market,
        ) as OrderBook,
    );
  }

  override async fetchL2OrderBook(
    symbol: string,
    limit?: number,
    params: CCXTParams = {},
  ): Promise<OrderBook> {
    return this.fetchOrderBook(symbol, limit, params);
  }

  override async fetchTrades(
    symbol: string,
    since?: number,
    limit = 50,
    _params: CCXTParams = {},
  ): Promise<CCXTOfficialTrade[]> {
    const market = await this.resolveMarket(symbol);
    return this.read(async () => {
      const raw = await this.o2Client.getTrades(market.info, Math.min(limit, 50));
      return raw
        .map((trade) => parseTrade(trade, market))
        .filter((trade) => since === undefined || trade.timestamp >= since)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-limit) as unknown as CCXTOfficialTrade[];
    });
  }

  override async fetchOHLCV(
    symbol: string,
    timeframe = "1m",
    since?: number,
    limit = 100,
    params: CCXTParams = {},
  ): Promise<OHLCV[]> {
    const duration = CCXT_TIMEFRAMES[timeframe];
    if (!duration) throw new NotSupported(`Unsupported OHLCV timeframe: ${timeframe}`);
    const market = await this.resolveMarket(symbol);
    const until = numberOrNull(params.until) ?? Date.now();
    const from = since ?? until - duration * limit;
    const to = since === undefined ? until : Math.min(until, from + duration * limit);
    return this.read(async () =>
      (await this.o2Client.getBars(market.info, timeframe, from, to))
        .map(parseOHLCV)
        .filter((bar) => bar[0] >= from && bar[0] <= to)
        .sort((a, b) => a[0] - b[0])
        .slice(0, limit),
    );
  }

  override async fetchBalance(_params: CCXTParams = {}): Promise<Balances> {
    const account = this.resolveAccountId();
    return this.read(async () => {
      const raw = await this.o2Client.getBalances(account);
      const decimals = new Map<string, number>();
      for (const market of Object.values(await this.loadMarkets()) as unknown as CCXTMarket[]) {
        decimals.set(market.base, market.info.base.decimals);
        decimals.set(market.quote, market.info.quote.decimals);
      }
      return parseBalance(raw, decimals) as unknown as Balances;
    });
  }

  override async fetchOrder(
    id: string,
    symbol?: string,
    _params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder> {
    if (!symbol) throw new ArgumentsRequired("fetchOrder requires symbol for O2");
    const market = await this.resolveMarket(symbol);
    return this.read(
      async () =>
        parseOrder(
          await this.o2Client.getOrder(market.info, orderId(id)),
          market,
        ) as unknown as CCXTOfficialOrder,
    );
  }

  override async fetchOrders(
    symbol?: string,
    since?: number,
    limit = 20,
    params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder[]> {
    return this.fetchOrdersByStatus(symbol, since, limit, params);
  }

  override async fetchOpenOrders(
    symbol?: string,
    since?: number,
    limit = 20,
    params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder[]> {
    return this.fetchOrdersByStatus(symbol, since, limit, { ...params, isOpen: true });
  }

  override async fetchClosedOrders(
    symbol?: string,
    since?: number,
    limit = 20,
    params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder[]> {
    return this.fetchOrdersByStatus(symbol, since, limit, { ...params, isOpen: false });
  }

  override async fetchMyTrades(
    symbol?: string,
    since?: number,
    limit = 50,
    _params: CCXTParams = {},
  ): Promise<CCXTOfficialTrade[]> {
    const account = this.resolveAccountId();
    const selected = symbol
      ? [await this.resolveMarket(symbol)]
      : (Object.values(await this.loadMarkets()) as unknown as CCXTMarket[]);
    return this.read(async () => {
      const pages = await Promise.all(
        selected.map(async (market) => {
          const trades = await this.o2Client.getTrades(market.info, Math.min(limit, 50), account);
          return trades.map((trade) => parseTrade(trade, market, true));
        }),
      );
      return pages
        .flat()
        .filter((trade) => since === undefined || trade.timestamp >= since)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-limit) as unknown as CCXTOfficialTrade[];
    });
  }

  override async createOrder(
    symbol: string,
    type: string,
    side: OrderSide,
    amount: number,
    price?: number,
    params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder> {
    const normalizedType = type.toLowerCase();
    if (normalizedType !== "limit" && normalizedType !== "market") {
      throw new NotSupported(`The O2 CCXT alpha does not support order type: ${type}`);
    }
    if (side !== "buy" && side !== "sell") throw new InvalidOrder(`Invalid order side: ${side}`);
    const market = await this.resolveMarket(symbol);
    const nativeAmount = this.amountToPrecision(symbol, amount);
    if (nativeAmount === undefined) throw new InvalidOrder("createOrder requires a valid amount");
    let nativePrice: Numeric;
    let orderType: OrderType;
    if (normalizedType === "limit") {
      if (price === undefined) throw new ArgumentsRequired("createOrder requires a limit price");
      const formattedPrice = this.priceToPrecision(symbol, price);
      if (formattedPrice === undefined)
        throw new InvalidOrder("createOrder requires a valid price");
      nativePrice = formattedPrice;
      orderType = (params.orderType as OrderType | undefined) ?? "Spot";
    } else {
      const maxPrice = requiredPositiveNumeric(params, "maxPrice");
      const minPrice = requiredPositiveNumeric(params, "minPrice");
      if (Number(minPrice) > Number(maxPrice)) {
        throw new InvalidOrder("createOrder market orders require minPrice <= maxPrice");
      }
      if (price !== undefined && !(price >= Number(minPrice) && price <= Number(maxPrice))) {
        throw new InvalidOrder("createOrder market price must be between minPrice and maxPrice");
      }
      const formattedPrice = protectedPriceToPrecision(
        this,
        price === undefined ? (side === "buy" ? maxPrice : minPrice) : String(price),
        side,
        market.precision.price,
      );
      nativePrice = formattedPrice;
      // O2 BoundedMarket is a resting trigger-style order, not an immediate
      // CCXT market order. Emulate bounded execution with a protected FOK.
      orderType = "FillOrKill";
    }
    const response = this.ensureActionResponse(
      await this.submit(() =>
        this.o2Client.createOrder(market.info, side, nativePrice, nativeAmount, {
          orderType,
          settleFirst: optionalBoolean(params, "settleFirst", true),
          collectOrders: true,
        }),
      ),
    );
    // Native createOrder appends CreateOrder after its optional SettleBalance
    // action, so the collected create-order result is the final entry.
    const rawOrder = response.orders?.[response.orders.length - 1];
    if (!rawOrder) {
      throw new O2AmbiguousSubmission(
        "O2 accepted createOrder but returned no order. Reconcile orders and account nonce before retrying.",
        { transactionId: response.txId },
      );
    }
    const parsed = parseOrder(rawOrder, market);
    const responseOmitsAmount = parsed.amount === 0 && amount > 0;
    return {
      ...parsed,
      type: normalizedType === "market" ? "market" : parsed.type,
      amount: responseOmitsAmount ? amount : parsed.amount,
      filled: responseOmitsAmount ? 0 : parsed.filled,
      remaining: responseOmitsAmount ? amount : parsed.remaining,
      cost: responseOmitsAmount ? 0 : parsed.cost,
    } as unknown as CCXTOfficialOrder;
  }

  override async cancelOrder(
    id: string,
    symbol?: string,
    _params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder> {
    if (!symbol) throw new ArgumentsRequired("cancelOrder requires symbol for O2");
    const market = await this.resolveMarket(symbol);
    const raw = await this.read(() => this.o2Client.getOrder(market.info, orderId(id)));
    this.ensureActionResponse(
      await this.submit(() => this.o2Client.cancelOrder(orderId(id), market.info)),
    );
    return parseOrder(
      { ...raw, cancel: true, close: true },
      market,
    ) as unknown as CCXTOfficialOrder;
  }

  override async cancelAllOrders(
    symbol?: string,
    _params: CCXTParams = {},
  ): Promise<CCXTOfficialOrder[]> {
    if (!symbol) await this.loadMarkets();
    const selected = symbol ? [symbol] : this.symbols;
    const canceled: CCXTOfficialOrder[] = [];
    for (const marketSymbol of selected) {
      const open = await this.fetchOpenOrders(marketSymbol, undefined, 200);
      if (open.length === 0) continue;
      const results = await this.submit(() => this.o2Client.cancelAllOrders(marketSymbol));
      if (results === null) continue;
      for (const result of results) this.ensureActionResponse(result);
      canceled.push(...open.map((order) => ({ ...order, status: "canceled" as const })));
    }
    return canceled;
  }

  /** Explicit O2 account setup extension. Never called automatically. */
  async setupAccount(signer = this.requireSigner()) {
    const result = await this.submit(() => this.o2Client.setupAccount(signer));
    this.configuredTradeAccountId = result.tradeAccountId;
    return result;
  }

  /** Explicit O2 session creation extension. Never called automatically. */
  async createSession(markets: MarketRef[], expiryDays = 30, signer = this.requireSigner()) {
    const session = await this.submit(() =>
      this.o2Client.createSession(signer, markets, expiryDays),
    );
    this.configuredTradeAccountId = session.tradeAccountId;
    return session;
  }

  restoreSession(session: SessionState): void {
    this.o2Client.setSession(session);
    this.configuredTradeAccountId = session.tradeAccountId;
  }

  async settleBalance(market: MarketRef, _params: CCXTParams = {}) {
    return this.ensureActionResponse(await this.submit(() => this.o2Client.settleBalance(market)));
  }

  override async withdraw(
    code: string,
    amount: number,
    address: string,
    tag?: string,
    params: CCXTParams = {},
  ): Promise<Transaction> {
    const signer = (params.signer as Signer | undefined) ?? this.requireSigner();
    const response = await this.submit(() =>
      this.o2Client.withdraw(signer, code, String(amount), address),
    );
    return {
      info: response,
      id: response.tx_id,
      txid: response.tx_id,
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      address,
      addressFrom: undefined,
      addressTo: address,
      tag,
      tagFrom: undefined,
      tagTo: tag,
      type: "withdrawal",
      amount,
      currency: code,
      status: "pending",
      updated: undefined,
      fee: undefined,
      network: undefined,
      comment: undefined,
      internal: false,
    };
  }

  async batchActions(
    marketActions: MarketActionGroup[],
    collectOrders = false,
    session?: SessionState,
  ) {
    return this.ensureActionResponse(
      await this.submit(() => this.o2Client.batchActions(marketActions, collectOrders, session)),
    );
  }

  override close(): ReturnType<Exchange["close"]> {
    this.o2Client.close();
    return super.close() as ReturnType<Exchange["close"]>;
  }

  private async fetchOrdersByStatus(
    symbol: string | undefined,
    since: number | undefined,
    limit: number,
    params: CCXTParams,
  ): Promise<CCXTOfficialOrder[]> {
    const account = this.resolveAccountId();
    const selected = symbol
      ? [await this.resolveMarket(symbol)]
      : (Object.values(await this.loadMarkets()) as unknown as CCXTMarket[]);
    const isOpen = typeof params.isOpen === "boolean" ? params.isOpen : undefined;
    return this.read(async () => {
      const pages = await Promise.all(
        selected.map(async (market) =>
          (await this.o2Client.getOrders(market.info, account, isOpen, limit)).map(
            (order) => parseOrder(order, market) as unknown as CCXTOfficialOrder,
          ),
        ),
      );
      return pages
        .flat()
        .filter(
          (order) =>
            since === undefined ||
            (order.timestamp !== null && order.timestamp !== undefined && order.timestamp >= since),
        )
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .slice(-limit);
    });
  }

  private async resolveMarket(symbol: string): Promise<CCXTMarket> {
    await this.loadMarkets();
    const market = this.markets?.[symbol] ?? this.markets_by_id?.[symbol]?.[0];
    if (!market) throw new BadSymbol(`Unknown O2 market: ${symbol}`);
    return market as CCXTMarket;
  }

  private resolveAccountId(): TradeAccountId {
    const account = this.configuredTradeAccountId ?? this.o2Client.session?.tradeAccountId;
    if (!account) {
      throw new ArgumentsRequired(
        "A tradeAccountId or active O2 session is required for this private method",
      );
    }
    return account;
  }

  private requireSigner(): Signer {
    if (!this.ownerSigner) {
      throw new AuthenticationError(
        "An O2 signer or privateKey is required for this lifecycle extension",
      );
    }
    return this.ownerSigner;
  }

  private ensureActionResponse(response: SessionActionsResponse): SessionActionsResponse {
    if (response.isPreflightError) {
      throw mapO2Error(
        parseApiError({ code: response.code, message: response.message ?? "O2 action rejected" }),
        "privateSubmission",
      );
    }
    if (response.isOnChainRevert) {
      throw mapO2Error(
        new OnChainRevertError(
          response.message ?? "O2 action reverted",
          response.reason ?? undefined,
          response.receipts ?? undefined,
        ),
        "privateSubmission",
      );
    }
    if (!response.success) {
      throw new OperationFailed("O2 action failed without a transaction or structured error");
    }
    return response;
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapO2Error(error, "read");
    }
  }

  private async submit<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapO2Error(error, "privateSubmission");
    }
  }
}
