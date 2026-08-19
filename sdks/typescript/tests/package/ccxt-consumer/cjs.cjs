const { O2CCXT } = require("@o2exchange/sdk/ccxt");

const exchange = new O2CCXT();
if (exchange.id !== "o2") throw new Error(`Unexpected exchange id: ${exchange.id}`);
exchange.close().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
