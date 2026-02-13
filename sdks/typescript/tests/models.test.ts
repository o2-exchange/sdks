import { describe, expect, it } from "vitest";
import { InvalidSignature, OnChainRevertError, parseApiError } from "../src/errors.js";
import {
  type BalanceResponse,
  formatPrice,
  formatQuantity,
  type Identity,
  identityValue,
  isAddress,
  isContractId,
  type Market,
  type MarketsResponse,
  type Order,
  parseBigInt,
  parseDepthLevel,
  parseDesiredQuantity,
  parseOrder,
  parseTrade,
  scalePriceForMarket,
  scaleQuantityForMarket,
  type Trade,
} from "../src/models.js";

describe("Models Module", () => {
  describe("Identity helpers", () => {
    it("isAddress identifies Address identity", () => {
      const id: Identity = { Address: "0xabc123" };
      expect(isAddress(id)).toBe(true);
      expect(isContractId(id)).toBe(false);
    });

    it("isContractId identifies ContractId identity", () => {
      const id: Identity = { ContractId: "0xdef456" };
      expect(isAddress(id)).toBe(false);
      expect(isContractId(id)).toBe(true);
    });

    it("identityValue extracts the hex value", () => {
      expect(identityValue({ Address: "0xabc" })).toBe("0xabc");
      expect(identityValue({ ContractId: "0xdef" })).toBe("0xdef");
    });
  });

  describe("Market decimal helpers", () => {
    const mockMarket: Market = {
      contract_id: "0x1234",
      market_id: "0x5678",
      maker_fee: "0",
      taker_fee: "100",
      min_order: "1000000000",
      dust: "1000",
      price_window: 0,
      base: {
        symbol: "FUEL",
        asset: "0xbase",
        decimals: 9,
        max_precision: 3,
      },
      quote: {
        symbol: "USDC",
        asset: "0xquote",
        decimals: 9,
        max_precision: 9,
      },
    };

    it("formatPrice converts chain to human", () => {
      expect(formatPrice(mockMarket, 84000000n)).toBeCloseTo(0.084, 6);
      expect(formatPrice(mockMarket, 1000000000n)).toBe(1.0);
    });

    it("scalePriceForMarket converts human to chain with truncation", () => {
      // quote decimals=9, max_precision=9 -> truncate_factor=1
      expect(scalePriceForMarket(mockMarket, 0.084)).toBe(84000000n);
      expect(scalePriceForMarket(mockMarket, 1.0)).toBe(1000000000n);
    });

    it("formatQuantity converts chain to human", () => {
      expect(formatQuantity(mockMarket, 5000000000n)).toBe(5.0);
    });

    it("scaleQuantityForMarket converts human to chain", () => {
      // base decimals=9, max_precision=3 -> truncate_factor=10^6
      const result = scaleQuantityForMarket(mockMarket, 5.0);
      expect(result).toBe(5000000000n);
    });
  });

  describe("JSON response parsing", () => {
    it("parses markets response", () => {
      const json: MarketsResponse = {
        books_registry_id: "0xabc",
        accounts_registry_id: "0xdef",
        trade_account_oracle_id: "0x789",
        chain_id: "0x0000000000000000",
        base_asset_id: "0xbase",
        markets: [
          {
            contract_id: "0x9ad52fb8",
            market_id: "0x09c17f77",
            maker_fee: "0",
            taker_fee: "100",
            min_order: "1000000000",
            dust: "1000",
            price_window: 0,
            base: {
              symbol: "FUEL",
              asset: "0xa1b2",
              decimals: 9,
              max_precision: 3,
            },
            quote: {
              symbol: "USDC",
              asset: "0xf6e5",
              decimals: 9,
              max_precision: 9,
            },
          },
        ],
      };

      expect(json.markets.length).toBe(1);
      expect(json.markets[0].base.symbol).toBe("FUEL");
      expect(json.chain_id).toBe("0x0000000000000000");
    });

    it("parses order with various order types", () => {
      const spotOrder: Order = {
        order_id: "0x1122",
        side: "buy",
        order_type: "Spot",
        quantity: "5000000000",
        price: "100000000",
        timestamp: "1734876543",
        close: false,
      };
      expect(spotOrder.order_type).toBe("Spot");

      const limitOrder: Order = {
        order_id: "0x3344",
        side: "sell",
        order_type: { Limit: ["100000000", "1734876543210"] },
        quantity: "5000000000",
        price: "100000000",
        timestamp: "1734876543",
        close: false,
      };
      expect(typeof limitOrder.order_type).toBe("object");
    });

    it("parses balance response", () => {
      const balance: BalanceResponse = {
        order_books: {
          "0x9ad52fb8": { locked: "2000000000", unlocked: "34878720000" },
        },
        total_locked: "2000000000",
        total_unlocked: "34878720000",
        trading_account_balance: "25000000000",
      };

      expect(BigInt(balance.trading_account_balance)).toBe(25000000000n);
      expect(Object.keys(balance.order_books).length).toBe(1);
    });

    it("parses trade response", () => {
      const trade: Trade = {
        trade_id: "12345",
        side: "buy",
        total: "500000000000",
        quantity: "5000000000",
        price: "100000000",
        timestamp: "1734876543",
      };

      expect(trade.side).toBe("buy");
      expect(BigInt(trade.quantity)).toBe(5000000000n);
    });
  });

  describe("Parse functions", () => {
    describe("parseBigInt", () => {
      it("converts string to bigint", () => {
        expect(parseBigInt("123")).toBe(123n);
      });

      it("converts number to bigint", () => {
        expect(parseBigInt(42)).toBe(42n);
      });

      it("passes through bigint", () => {
        expect(parseBigInt(99n)).toBe(99n);
      });

      it("throws TypeError on undefined", () => {
        expect(() => parseBigInt(undefined)).toThrow(TypeError);
      });

      it("throws TypeError on null", () => {
        expect(() => parseBigInt(null)).toThrow(TypeError);
      });

      it("throws TypeError on boolean", () => {
        expect(() => parseBigInt(true)).toThrow(TypeError);
      });

      it("throws TypeError on object", () => {
        expect(() => parseBigInt({})).toThrow(TypeError);
      });
    });

    describe("parseOrder", () => {
      it("parses a complete raw order", () => {
        const raw = {
          order_id: "0xABC",
          side: "Buy",
          order_type: "Spot",
          price: "100000000",
          quantity: "5000000000",
          timestamp: "1734876543",
          close: false,
        };
        const order = parseOrder(raw);
        expect(order.order_id).toBe("0xabc");
        expect(order.side).toBe("buy");
        expect(order.price).toBe(100000000n);
        expect(order.quantity).toBe(5000000000n);
      });

      it("defaults price to 0n when missing", () => {
        const raw = {
          order_id: "0x1",
          side: "buy",
          order_type: "Spot",
          quantity: "100",
          timestamp: "0",
          close: false,
        };
        const order = parseOrder(raw);
        expect(order.price).toBe(0n);
      });

      it("defaults quantity to 0n when missing", () => {
        const raw = {
          order_id: "0x1",
          side: "sell",
          order_type: "Spot",
          price: "100",
          timestamp: "0",
          close: false,
        };
        const order = parseOrder(raw);
        expect(order.quantity).toBe(0n);
      });

      it("normalizes side to lowercase", () => {
        const raw = {
          order_id: "0x1",
          side: "Sell",
          order_type: "Spot",
          price: "1",
          quantity: "1",
          timestamp: "0",
          close: false,
        };
        expect(parseOrder(raw).side).toBe("sell");
      });

      it("parses Quote desired_quantity from API", () => {
        const raw = {
          order_id: "0x1",
          side: "Buy",
          order_type: "Spot",
          price: "100",
          quantity: "500",
          timestamp: "0",
          close: false,
          desired_quantity: {
            Quote: {
              desired_base_quantity: { Quantity: 500 },
              remaining_quote_token: 9000,
            },
          },
        };
        const order = parseOrder(raw);
        expect(order.desired_quantity).toEqual({
          Quote: {
            desired_base_quantity: { Quantity: 500n },
            remaining_quote_token: 9000n,
          },
        });
      });
    });

    describe("parseDesiredQuantity", () => {
      it("returns undefined for null", () => {
        expect(parseDesiredQuantity(null)).toBeUndefined();
      });

      it("returns undefined for undefined", () => {
        expect(parseDesiredQuantity(undefined)).toBeUndefined();
      });

      it("parses Base variant (sell orders)", () => {
        const raw = { Base: { remaining_quantity: "1000000000" } };
        expect(parseDesiredQuantity(raw)).toEqual({
          Base: { remaining_quantity: 1000000000n },
        });
      });

      it("parses Quote variant with Quantity (buy limit)", () => {
        const raw = {
          Quote: {
            desired_base_quantity: { Quantity: 500 },
            remaining_quote_token: "9000",
          },
        };
        expect(parseDesiredQuantity(raw)).toEqual({
          Quote: {
            desired_base_quantity: { Quantity: 500n },
            remaining_quote_token: 9000n,
          },
        });
      });

      it("parses Quote variant with Infinite (buy market)", () => {
        const raw = {
          Quote: {
            desired_base_quantity: "Infinite",
            remaining_quote_token: 90000000000,
          },
        };
        expect(parseDesiredQuantity(raw)).toEqual({
          Quote: {
            desired_base_quantity: "Infinite",
            remaining_quote_token: 90000000000n,
          },
        });
      });
    });

    describe("parseDepthLevel", () => {
      it("parses a complete raw depth level", () => {
        const level = parseDepthLevel({ price: "500", quantity: "200" });
        expect(level.price).toBe(500n);
        expect(level.quantity).toBe(200n);
      });

      it("defaults price to 0n when undefined", () => {
        const level = parseDepthLevel({ quantity: "200" });
        expect(level.price).toBe(0n);
      });

      it("defaults quantity to 0n when undefined", () => {
        const level = parseDepthLevel({ price: "500" });
        expect(level.quantity).toBe(0n);
      });
    });

    describe("parseTrade", () => {
      it("parses a complete raw trade", () => {
        const raw = {
          trade_id: "42",
          side: "Buy",
          price: "100",
          quantity: "50",
          total: "5000",
          timestamp: "1734876543",
        };
        const trade = parseTrade(raw);
        expect(trade.price).toBe(100n);
        expect(trade.quantity).toBe(50n);
        expect(trade.total).toBe(5000n);
        expect(trade.side).toBe("buy");
      });

      it("defaults price, quantity, total to 0n when missing", () => {
        const raw = {
          trade_id: "1",
          side: "sell",
          timestamp: "0",
        };
        const trade = parseTrade(raw);
        expect(trade.price).toBe(0n);
        expect(trade.quantity).toBe(0n);
        expect(trade.total).toBe(0n);
      });
    });
  });

  describe("Error parsing", () => {
    it("parses pre-flight validation error", () => {
      const error = parseApiError({
        code: 4000,
        message: "Signature verification failed",
      });
      expect(error).toBeInstanceOf(InvalidSignature);
      expect(error.code).toBe(4000);
    });

    it("parses on-chain revert error (no code)", () => {
      const error = parseApiError({
        message: "Revert(18446744073709486080)",
        reason: "NotEnoughBalance",
        receipts: [],
      });
      expect(error).toBeInstanceOf(OnChainRevertError);
      expect(error.code).toBeUndefined();
      expect(error.reason).toBe("NotEnoughBalance");
    });

    it("parses unknown error code", () => {
      const error = parseApiError({
        code: 9999,
        message: "Unknown error",
      });
      expect(error.code).toBe(9999);
    });
  });
});
