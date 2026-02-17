/// Network configuration for O2 Exchange API endpoints.
/// Supported O2 Exchange networks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Testnet,
    Devnet,
    Mainnet,
}

/// Configuration holding API and RPC URLs for a specific network.
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub api_base: String,
    pub ws_url: String,
    pub fuel_rpc: String,
    pub faucet_url: Option<String>,
    pub whitelist_required: bool,
}

impl NetworkConfig {
    pub fn from_network(network: Network) -> Self {
        match network {
            Network::Testnet => Self {
                api_base: "https://api.testnet.o2.app".into(),
                ws_url: "wss://api.testnet.o2.app/v1/ws".into(),
                fuel_rpc: "https://testnet.fuel.network/v1/graphql".into(),
                faucet_url: Some("https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2".into()),
                whitelist_required: true,
            },
            Network::Devnet => Self {
                api_base: "https://api.devnet.o2.app".into(),
                ws_url: "wss://api.devnet.o2.app/v1/ws".into(),
                fuel_rpc: "https://devnet.fuel.network/v1/graphql".into(),
                faucet_url: Some("https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2".into()),
                whitelist_required: false,
            },
            Network::Mainnet => Self {
                api_base: "https://api.o2.app".into(),
                ws_url: "wss://api.o2.app/v1/ws".into(),
                fuel_rpc: "https://mainnet.fuel.network/v1/graphql".into(),
                faucet_url: None,
                whitelist_required: false,
            },
        }
    }
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self::from_network(Network::Testnet)
    }
}
