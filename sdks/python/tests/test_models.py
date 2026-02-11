"""Unit tests for model parsing."""

from typing import ClassVar

from o2_sdk.models import (
    AccountInfo,
    ActionsResponse,
    Balance,
    DepthSnapshot,
    DepthUpdate,
    FaucetResponse,
    Identity,
    Market,
    MarketsResponse,
    Order,
    Trade,
    WhitelistResponse,
)


class TestMarket:
    MARKET_JSON: ClassVar[dict] = {
        "contract_id": "0x9ad52fb8a2be1c4603dfeeb8118a922c8cfafa8f260eeb41d68ade8d442be65b",
        "market_id": "0x09c17f779eb0a7658424e48935b2bef24013766f8b3da757becb2264406f9e96",
        "maker_fee": "0",
        "taker_fee": "100",
        "min_order": "1000000000",
        "dust": "1000",
        "price_window": 0,
        "base": {
            "symbol": "FUEL",
            "asset": "0xa1b2c3d4e5f60000000000000000000000000000000000000000000000000000",
            "decimals": 9,
            "max_precision": 3,
        },
        "quote": {
            "symbol": "USDC",
            "asset": "0xf6e5d4c3b2a10000000000000000000000000000000000000000000000000000",
            "decimals": 9,
            "max_precision": 9,
        },
    }

    def test_from_dict(self):
        m = Market.from_dict(self.MARKET_JSON)
        assert m.contract_id == self.MARKET_JSON["contract_id"]
        assert m.market_id == self.MARKET_JSON["market_id"]
        assert m.base.symbol == "FUEL"
        assert m.quote.symbol == "USDC"
        assert m.base.decimals == 9
        assert m.quote.max_precision == 9
        assert m.pair == "FUEL/USDC"

    def test_format_price(self):
        m = Market.from_dict(self.MARKET_JSON)
        assert m.format_price(100000000) == 0.1
        assert m.format_price(1000000000) == 1.0

    def test_scale_price(self):
        m = Market.from_dict(self.MARKET_JSON)
        # quote decimals=9, max_precision=9 -> truncate_factor=1
        assert m.scale_price(0.1) == 100000000
        assert m.scale_price(1.0) == 1000000000

    def test_format_quantity(self):
        m = Market.from_dict(self.MARKET_JSON)
        assert m.format_quantity(5000000000) == 5.0

    def test_scale_quantity(self):
        m = Market.from_dict(self.MARKET_JSON)
        # base decimals=9, max_precision=3 -> truncate_factor=10^6
        result = m.scale_quantity(5.0)
        assert result == 5000000000

    def test_scale_quantity_truncation(self):
        m = Market.from_dict(self.MARKET_JSON)
        # 5.1234567 with max_precision=3 should truncate
        result = m.scale_quantity(5.1234567)
        # Truncate factor = 10^6
        # 5.1234567 * 10^9 = 5123456700
        # floor(5123456700 / 1000000) * 1000000 = 5123000000
        assert result == 5123000000

    def test_validate_order_passes(self):
        m = Market.from_dict(self.MARKET_JSON)
        # price=100000000 (0.1), quantity=10000000000 (10.0)
        # (100000000 * 10000000000) / 10^9 = 1000000000 >= min_order
        # (100000000 * 10000000000) % 10^9 = 0
        m.validate_order(100000000, 10000000000)

    def test_validate_order_min_order_fail(self):
        m = Market.from_dict(self.MARKET_JSON)
        import pytest

        with pytest.raises(ValueError, match="min_order"):
            # Too small
            m.validate_order(100000000, 1000000000)

    def test_adjust_quantity(self):
        m = Market.from_dict(self.MARKET_JSON)
        # If price * quantity is not divisible by 10^base_decimals
        adjusted = m.adjust_quantity(100000000, 10000000000)
        assert adjusted == 10000000000  # already valid


class TestMarketsResponse:
    def test_from_dict(self):
        data = {
            "books_registry_id": "0xabc",
            "accounts_registry_id": "0xdef",
            "trade_account_oracle_id": "0x789",
            "chain_id": "0x0000000000000000",
            "base_asset_id": "0x000",
            "markets": [],
        }
        resp = MarketsResponse.from_dict(data)
        assert resp.chain_id_int == 0
        assert resp.accounts_registry_id == "0xdef"


class TestIdentity:
    def test_address(self):
        i = Identity.from_dict({"Address": "0xabc"})
        assert i.variant == "Address"
        assert i.value == "0xabc"
        assert i.discriminant == 0
        assert i.to_dict() == {"Address": "0xabc"}

    def test_contract_id(self):
        i = Identity.from_dict({"ContractId": "0xdef"})
        assert i.variant == "ContractId"
        assert i.discriminant == 1


class TestAccountInfo:
    def test_exists(self):
        data = {
            "trade_account_id": "0xabc",
            "trade_account": {
                "last_modification": 1734876543,
                "nonce": "5",
                "owner": {"Address": "0xdef"},
            },
        }
        info = AccountInfo.from_dict(data)
        assert info.exists
        assert info.nonce == 5

    def test_not_exists(self):
        data = {
            "trade_account_id": None,
            "trade_account": None,
        }
        info = AccountInfo.from_dict(data)
        assert not info.exists
        assert info.nonce == 0


class TestOrder:
    def test_from_dict(self):
        data = {
            "order_id": "0x1122",
            "side": "Buy",
            "order_type": "Spot",
            "quantity": "5000000000",
            "quantity_fill": "0",
            "price": "100000000",
            "price_fill": "0",
            "timestamp": "1734876543",
            "close": False,
            "partially_filled": False,
            "cancel": False,
        }
        order = Order.from_dict(data)
        assert order.order_id == "0x1122"
        assert order.side == "Buy"
        assert order.is_open

    def test_closed_order(self):
        data = {
            "order_id": "0x3344",
            "side": "Sell",
            "order_type": "Spot",
            "quantity": "1000",
            "quantity_fill": "1000",
            "price": "100",
            "price_fill": "100",
            "timestamp": "0",
            "close": True,
            "partially_filled": False,
            "cancel": False,
        }
        order = Order.from_dict(data)
        assert not order.is_open


class TestBalance:
    def test_from_dict(self):
        data = {
            "order_books": {
                "0x9ad5": {
                    "locked": "2000000000",
                    "unlocked": "34878720000",
                }
            },
            "total_locked": "2000000000",
            "total_unlocked": "34878720000",
            "trading_account_balance": "25000000000",
        }
        bal = Balance.from_dict(data)
        assert bal.available == 25000000000
        assert "0x9ad5" in bal.order_books
        assert bal.order_books["0x9ad5"].locked == "2000000000"


class TestDepthSnapshot:
    def test_from_dict(self):
        data = {
            "view": {
                "buys": [{"price": "100", "quantity": "500"}],
                "sells": [{"price": "101", "quantity": "200"}],
            },
            "market_id": "0xabc",
        }
        snap = DepthSnapshot.from_dict(data)
        assert snap.best_bid.price == "100"
        assert snap.best_ask.price == "101"

    def test_empty(self):
        data = {"view": {"buys": [], "sells": []}}
        snap = DepthSnapshot.from_dict(data)
        assert snap.best_bid is None
        assert snap.best_ask is None


class TestDepthUpdate:
    def test_snapshot(self):
        data = {
            "action": "subscribe_depth",
            "view": {
                "buys": [{"price": "100", "quantity": "500"}],
                "sells": [],
            },
            "market_id": "0xabc",
        }
        update = DepthUpdate.from_dict(data)
        assert update.is_snapshot
        assert len(update.changes.buys) == 1

    def test_incremental(self):
        data = {
            "action": "subscribe_depth_update",
            "changes": {
                "buys": [{"price": "100", "quantity": "600"}],
                "sells": [{"price": "101", "quantity": "0"}],
            },
            "market_id": "0xabc",
        }
        update = DepthUpdate.from_dict(data)
        assert not update.is_snapshot
        assert len(update.changes.sells) == 1


class TestActionsResponse:
    def test_success(self):
        data = {
            "tx_id": "0xfed",
            "orders": [
                {
                    "order_id": "0x1122",
                    "side": "Buy",
                    "order_type": "Spot",
                    "quantity": "5000000000",
                    "quantity_fill": "0",
                    "price": "100000000",
                    "price_fill": "0",
                    "timestamp": "0",
                    "close": False,
                    "partially_filled": False,
                    "cancel": False,
                }
            ],
        }
        resp = ActionsResponse.from_dict(data)
        assert resp.success
        assert len(resp.orders) == 1

    def test_error_with_code(self):
        data = {
            "code": 4000,
            "message": "Signature verification failed",
        }
        resp = ActionsResponse.from_dict(data)
        assert not resp.success
        assert resp.code == 4000

    def test_on_chain_revert(self):
        data = {
            "message": "Revert(18446744073709486080)",
            "reason": "NotEnoughBalance",
            "receipts": [],
        }
        resp = ActionsResponse.from_dict(data)
        assert not resp.success
        assert resp.reason == "NotEnoughBalance"


class TestTrade:
    def test_from_dict(self):
        data = {
            "trade_id": "12345",
            "side": "Buy",
            "total": "500000000000",
            "quantity": "5000000000",
            "price": "100000000",
            "timestamp": "1734876543",
        }
        trade = Trade.from_dict(data)
        assert trade.trade_id == "12345"
        assert trade.side == "Buy"


class TestWhitelistResponse:
    def test_new(self):
        data = {"success": True, "tradeAccount": "0xabc"}
        resp = WhitelistResponse.from_dict(data)
        assert resp.success
        assert not resp.already_whitelisted

    def test_already(self):
        data = {"success": True, "tradeAccount": "0xabc", "alreadyWhitelisted": True}
        resp = WhitelistResponse.from_dict(data)
        assert resp.already_whitelisted


class TestFaucetResponse:
    def test_success(self):
        data = {"message": "Tokens minted successfully"}
        resp = FaucetResponse.from_dict(data)
        assert resp.success

    def test_rate_limited(self):
        data = {"error": "You can request faucet funds only once every 60 seconds"}
        resp = FaucetResponse.from_dict(data)
        assert not resp.success
