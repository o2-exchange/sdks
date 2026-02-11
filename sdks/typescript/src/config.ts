/** Network configuration for O2 Exchange environments. */

export interface NetworkConfig {
  apiBase: string;
  wsUrl: string;
  fuelRpc: string;
  faucetUrl: string | null;
}

export const TESTNET: NetworkConfig = {
  apiBase: "https://api.testnet.o2.app",
  wsUrl: "wss://api.testnet.o2.app/v1/ws",
  fuelRpc: "https://testnet.fuel.network/v1/graphql",
  faucetUrl: "https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2",
};

export const DEVNET: NetworkConfig = {
  apiBase: "https://api.devnet.o2.app",
  wsUrl: "wss://api.devnet.o2.app/v1/ws",
  fuelRpc: "https://devnet.fuel.network/v1/graphql",
  faucetUrl: "https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2",
};

export const MAINNET: NetworkConfig = {
  apiBase: "https://api.o2.app",
  wsUrl: "wss://api.o2.app/v1/ws",
  fuelRpc: "https://mainnet.fuel.network/v1/graphql",
  faucetUrl: null,
};

export enum Network {
  TESTNET = "testnet",
  DEVNET = "devnet",
  MAINNET = "mainnet",
}

export function getNetworkConfig(network: Network): NetworkConfig {
  switch (network) {
    case Network.TESTNET:
      return TESTNET;
    case Network.DEVNET:
      return DEVNET;
    case Network.MAINNET:
      return MAINNET;
  }
}
