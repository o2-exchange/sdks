import { O2CCXT } from "@o2exchange/sdk/ccxt";
import type { Exchange } from "ccxt";

const exchange = new O2CCXT();
// This assignment catches adapter/base declaration drift across supported CCXT versions.
const compatibleExchange: Exchange = exchange;
const closing: ReturnType<O2CCXT["close"]> = exchange.close();
void compatibleExchange;
void closing;
