"""Network configuration for the O2 Exchange SDK."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Network(Enum):
    TESTNET = "testnet"
    DEVNET = "devnet"
    MAINNET = "mainnet"


@dataclass(frozen=True)
class NetworkConfig:
    api_base: str
    ws_url: str
    fuel_rpc: str
    faucet_url: Optional[str]


NETWORK_CONFIGS: dict[Network, NetworkConfig] = {
    Network.TESTNET: NetworkConfig(
        api_base="https://api.testnet.o2.app",
        ws_url="wss://api.testnet.o2.app/v1/ws",
        fuel_rpc="https://testnet.fuel.network/v1/graphql",
        faucet_url="https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2",
    ),
    Network.DEVNET: NetworkConfig(
        api_base="https://api.devnet.o2.app",
        ws_url="wss://api.devnet.o2.app/v1/ws",
        fuel_rpc="https://devnet.fuel.network/v1/graphql",
        faucet_url="https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2",
    ),
    Network.MAINNET: NetworkConfig(
        api_base="https://api.o2.app",
        ws_url="wss://api.o2.app/v1/ws",
        fuel_rpc="https://mainnet.fuel.network/v1/graphql",
        faucet_url=None,
    ),
}


def get_config(network: Network) -> NetworkConfig:
    """Return the network configuration for the given network."""
    return NETWORK_CONFIGS[network]
