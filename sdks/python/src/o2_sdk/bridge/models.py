"""Proxy v1 wire models. Decimal amount strings use Fuel asset base units."""

from __future__ import annotations

from dataclasses import MISSING, dataclass, fields
from types import UnionType
from typing import Any, Literal, TypeVar, cast, get_args, get_origin, get_type_hints

T = TypeVar("T", bound="BridgeModel")


class BridgeModel:
    """Typed wire model using Python names and camelCase JSON."""

    @classmethod
    def from_dict(cls: type[T], data: dict[str, Any]) -> T:
        hints = get_type_hints(cls)

        def convert(typ: Any, value: Any) -> Any:
            if value is None:
                return None
            origin = get_origin(typ)
            if origin is UnionType:
                return convert(next(t for t in get_args(typ) if t is not type(None)), value)
            if origin is list:
                return [convert(get_args(typ)[0], v) for v in value]
            if isinstance(typ, type) and issubclass(typ, BridgeModel):
                return typ.from_dict(value)
            return value

        return cls(
            **{
                f.name: convert(hints[f.name], data[_wire_name(f.name)])
                for f in fields(cast(Any, cls))
                if _wire_name(f.name) in data
            }
        )

    def to_dict(self) -> dict[str, Any]:
        def convert(value: Any) -> Any:
            if isinstance(value, BridgeModel):
                return value.to_dict()
            if isinstance(value, list):
                return [convert(v) for v in value]
            return value

        return {
            _wire_name(f.name): convert(getattr(self, f.name))
            for f in fields(cast(Any, self))
            if getattr(self, f.name) is not None or f.default is MISSING
        }


def _wire_name(name: str) -> str:
    if name == "from_address":
        return "from"
    first, *rest = name.split("_")
    return first + "".join(s.title() for s in rest)


@dataclass
class FuelContracts(BridgeModel):
    fast_bridge: str
    asset_registry: str
    wrapped_assets_minter: str
    gas_oracle: str
    rate_limiter: str


@dataclass
class WithdrawalFuelContracts(BridgeModel):
    asset_registry: str
    wrapped_assets_minter: str
    gas_oracle: str
    rate_limiter: str


@dataclass
class ChainSummary(BridgeModel):
    chain_id: int
    name: str
    messenger_address: str
    outpost_address: str


@dataclass
class FuelInfo(BridgeModel):
    chain_id: str
    network: str
    contracts: FuelContracts


@dataclass
class InfoResponse(BridgeModel):
    environment: str
    api_version: str
    config_version: str
    preparation_proof_ttl_seconds: int
    fuel: FuelInfo
    chains: list[ChainSummary]


@dataclass
class AssetRoute(BridgeModel):
    chain_id: int
    token_address: str | None
    token_decimals: int


@dataclass
class Asset(BridgeModel):
    asset_id: str
    symbol: str
    fuel_decimals: int
    routes: list[AssetRoute]


@dataclass
class AssetsResponse(BridgeModel):
    config_version: str
    assets: list[Asset]


@dataclass
class DepositAssetInfo(BridgeModel):
    asset_id: str
    token_address: str | None
    token_decimals: int
    fuel_decimals: int
    whitelisted: bool
    deposit_cap: str | None
    deposited_amount: str
    remaining_capacity: str | None
    requires_allowance: bool
    allowance_spender: str | None
    permit_supported: bool
    amount_eligible: bool | None = None
    ineligibility_reason: str | None = None


@dataclass
class DepositInfoResponse(BridgeModel):
    source_chain_id: int
    route_enabled: bool
    messenger_address: str
    paused: bool
    assets: list[DepositAssetInfo]


@dataclass
class DepositPermit(BridgeModel):
    deadline: str
    v: int
    r: str
    s: str


@dataclass
class DepositPrepareRequest(BridgeModel):
    source_chain_id: int
    from_address: str
    to: str
    to_type: Literal["address", "contract"]
    asset_id: str
    amount: str
    permit: DepositPermit | None = None


@dataclass
class DepositPrepareResponse(BridgeModel):
    unsigned_transaction: str
    preparation_proof: str


@dataclass
class SubmitRequest(BridgeModel):
    preparation_proof: str
    unsigned_transaction: str
    signature: str


@dataclass
class DepositSubmitResponse(BridgeModel):
    source_chain_id: int
    evm_tx_hash: str
    status: Literal["submitted"]
    submitted_at: str


@dataclass
class DepositSourceStatus(BridgeModel):
    status: Literal["pending", "confirmed", "reverted"]
    block_number: str | None = None
    confirmations: str | None = None


@dataclass
class UnavailableStatus(BridgeModel):
    status: Literal["unavailable"]


@dataclass
class DepositStatusResponse(BridgeModel):
    source_chain_id: int
    evm_tx_hash: str
    source: DepositSourceStatus
    fuel: UnavailableStatus
    request_hash: str | None = None


@dataclass
class RateLimitInfo(BridgeModel):
    transaction_limit: str | None
    daily_limit: str | None
    withdrawn_today: str
    remaining_today: str | None
    resets_at: str


@dataclass
class WithdrawAssetInfo(BridgeModel):
    asset_id: str
    token_address: str | None
    fuel_decimals: int
    token_decimals: int
    withdraw_enabled: bool
    fee: str
    fee_quote_block_height: str
    fee_observed_at: str
    rate_limit: RateLimitInfo
    amount_eligible: bool | None = None
    ineligibility_reason: str | None = None


@dataclass
class WithdrawInfoResponse(BridgeModel):
    destination_chain_id: int
    route_enabled: bool
    messenger_address: str
    outpost_address: str
    fuel_contracts: WithdrawalFuelContracts
    paused: bool
    recipient_format: Literal["evm-address"]
    assets: list[WithdrawAssetInfo]


@dataclass
class WithdrawFeeResponse(BridgeModel):
    destination_chain_id: int
    asset_id: str
    fee: str
    fuel_block_height: str
    observed_at: str
    config_version: str


@dataclass
class WithdrawPrepareRequest(BridgeModel):
    destination_chain_id: int
    from_address: str
    to: str
    asset_id: str
    amount: str


@dataclass
class WithdrawPrepareResponse(BridgeModel):
    unsigned_transaction: str
    fuel_chain_id: str
    preparation_proof: str


@dataclass
class WithdrawSubmitResponse(BridgeModel):
    fuel_tx_id: str
    status: Literal["submitted"]
    submitted_at: str


@dataclass
class FuelStatus(BridgeModel):
    status: Literal["pending", "success", "reverted"]
    block_height: str | None = None
    failure_reason: str | None = None


@dataclass
class WithdrawStatusResponse(BridgeModel):
    fuel_tx_id: str
    fuel: FuelStatus
    request_hash: str | None = None
    destination_chain_id: int | None = None
    destination: UnavailableStatus | None = None
