import type { ConstructorArgs } from "ccxt";
import type { O2Client } from "../client.js";
import type { Network, NetworkConfig } from "../config.js";
import type { Signer } from "../crypto.js";
import type {
  BalanceResponse,
  Market,
  MarketTicker,
  Order,
  SessionState,
  Trade,
  TradeAccountId,
} from "../models.js";

export type CCXTParams = Record<string, unknown>;
export type O2CCXTNetwork = Network | "testnet" | "devnet" | "mainnet";

export interface O2CCXTOptions extends Omit<ConstructorArgs, "privateKey"> {
  /** Existing O2 client. When omitted, the adapter constructs one. */
  client?: O2Client;
  network?: O2CCXTNetwork;
  config?: NetworkConfig;
  /** Fuel private key convenience. Prefer `signer` for production custody. */
  privateKey?: string;
  /** Existing local or external signer used by explicit lifecycle extensions. */
  signer?: Signer;
  /** Session restored synchronously during construction. */
  session?: SessionState;
  /** Account used by balance and history calls. Defaults to the active session account. */
  tradeAccountId?: string | TradeAccountId;
}

export interface CCXTMarket {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  baseId: string;
  quoteId: string;
  type: "spot";
  spot: true;
  margin: false;
  swap: false;
  future: false;
  option: false;
  active: true;
  contract: false;
  maker: null;
  taker: null;
  percentage: true;
  precision: { amount: number; price: number };
  limits: {
    amount: { min: null; max: null };
    price: { min: null; max: null };
    cost: { min: number; max: null };
  };
  info: Market;
}

export interface CCXTOrderBook {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number | null;
  datetime: string | null;
  nonce: number | null;
}

export interface CCXTTrade {
  id: string;
  timestamp: number;
  datetime: string;
  symbol: string;
  order: null;
  type: null;
  side: "buy" | "sell" | null;
  takerOrMaker: "taker" | "maker" | null;
  price: number;
  amount: number;
  cost: number;
  fee: null;
  info: Trade;
}

export interface CCXTTicker {
  symbol: string;
  timestamp: number;
  datetime: string;
  high: null;
  low: null;
  bid: number | null;
  bidVolume: null;
  ask: number | null;
  askVolume: null;
  vwap: null;
  open: null;
  close: number | null;
  last: number | null;
  previousClose: null;
  change: null;
  percentage: null;
  average: null;
  baseVolume: number | null;
  quoteVolume: number | null;
  info: MarketTicker;
}

export type CCXTOHLCV = [
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
];

export interface CCXTBalanceEntry {
  free: number;
  used: number;
  total: number;
}

export interface CCXTBalance {
  free: Record<string, number>;
  used: Record<string, number>;
  total: Record<string, number>;
  info: Record<string, BalanceResponse>;
  [currency: string]: CCXTBalanceEntry | Record<string, number> | Record<string, BalanceResponse>;
}

export interface CCXTOrder {
  id: string;
  clientOrderId: null;
  timestamp: number | null;
  datetime: string | null;
  lastTradeTimestamp: null;
  lastUpdateTimestamp: null;
  symbol: string;
  type: "limit" | "market";
  timeInForce: "GTC" | "FOK" | "PO" | null;
  postOnly: boolean;
  reduceOnly: false;
  side: "buy" | "sell";
  price: number;
  triggerPrice: null;
  amount: number;
  cost: number;
  average: number | null;
  filled: number;
  remaining: number;
  status: "open" | "closed" | "canceled";
  fee: null;
  trades: null;
  info: Order;
}
