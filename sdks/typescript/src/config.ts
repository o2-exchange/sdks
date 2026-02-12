/**
 * Network configuration for O2 Exchange environments.
 *
 * Provides pre-configured endpoints for testnet, devnet, and mainnet,
 * as well as a {@link Network} enum for convenient selection.
 *
 * @module
 */

/**
 * Network endpoint configuration.
 *
 * Pass a custom `NetworkConfig` to {@link O2Client} or {@link O2Api} to
 * connect to a private or custom O2 Exchange deployment.
 *
 * @example
 * ```ts
 * const config: NetworkConfig = {
 *   apiBase: "https://my-gateway.example.com",
 *   wsUrl: "wss://my-gateway.example.com/v1/ws",
 *   fuelRpc: "https://mainnet.fuel.network/v1/graphql",
 *   faucetUrl: null,
 * };
 * const client = new O2Client({ config });
 * ```
 */
export interface NetworkConfig {
  /** Base URL for REST API endpoints (e.g., `"https://api.testnet.o2.app"`). */
  apiBase: string;
  /** WebSocket URL for real-time data (e.g., `"wss://api.testnet.o2.app/v1/ws"`). */
  wsUrl: string;
  /** Fuel Network GraphQL RPC endpoint. */
  fuelRpc: string;
  /** Faucet URL for minting test tokens, or `null` if unavailable (mainnet). */
  faucetUrl: string | null;
}

/** Pre-configured endpoints for O2 Exchange testnet. */
export const TESTNET: NetworkConfig = {
  apiBase: "https://api.testnet.o2.app",
  wsUrl: "wss://api.testnet.o2.app/v1/ws",
  fuelRpc: "https://testnet.fuel.network/v1/graphql",
  faucetUrl: "https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2",
};

/** Pre-configured endpoints for O2 Exchange devnet. */
export const DEVNET: NetworkConfig = {
  apiBase: "https://api.devnet.o2.app",
  wsUrl: "wss://api.devnet.o2.app/v1/ws",
  fuelRpc: "https://devnet.fuel.network/v1/graphql",
  faucetUrl: "https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2",
};

/** Pre-configured endpoints for O2 Exchange mainnet. */
export const MAINNET: NetworkConfig = {
  apiBase: "https://api.o2.app",
  wsUrl: "wss://api.o2.app/v1/ws",
  fuelRpc: "https://mainnet.fuel.network/v1/graphql",
  faucetUrl: null,
};

/**
 * Available O2 Exchange network environments.
 *
 * @example
 * ```ts
 * const client = new O2Client({ network: Network.TESTNET });
 * ```
 */
export enum Network {
  /** O2 Exchange testnet — for integration testing with test tokens. */
  TESTNET = "testnet",
  /** O2 Exchange devnet — for development and early testing. */
  DEVNET = "devnet",
  /** O2 Exchange mainnet — production trading. */
  MAINNET = "mainnet",
}

/**
 * Resolve a {@link Network} enum value to its {@link NetworkConfig}.
 *
 * @param network - The network to resolve.
 * @returns The corresponding network configuration.
 */
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
