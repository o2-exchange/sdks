import { O2CCXT } from "@o2exchange/sdk/ccxt";

const exchange = new O2CCXT();
if (exchange.id !== "o2") throw new Error(`Unexpected exchange id: ${exchange.id}`);
await exchange.close();
