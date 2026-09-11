import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex, fuelCompactSign, hexToBytes } from "../src/crypto.js";
import {
  FastBridgeClient,
  parseEvmUnsignedTransaction,
  parseFuelUnsignedTransaction,
  parsePreparationProof,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../../fixtures/bridge/transactions.json", import.meta.url), "utf8"),
);
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

describe("Fast Bridge offline inspection", () => {
  it("rejects mismatched or invalid Fuel consensus context", () => {
    for (const [vector, maxInputs] of [
      [vectors.fuel[0], 511],
      [vectors.fuel[3], 255],
    ] as const) {
      expect(() => parseFuelUnsignedTransaction(vector.unsignedTransaction, 0n, maxInputs)).toThrow(
        "Fuel call pointer does not address this transaction's script data",
      );
    }
    for (const maxInputs of [0, 65536]) {
      expect(() =>
        parseFuelUnsignedTransaction(vectors.fuel[0].unsignedTransaction, 0n, maxInputs),
      ).toThrow("Invalid Fuel consensus maxInputs");
    }
    expect(() =>
      parseFuelUnsignedTransaction(vectors.fuel[0].unsignedTransaction, 1n << 64n, 255),
    ).toThrow("Fuel chain ID must fit u64");
  });
  for (const v of vectors.invalidEvm) {
    it(`rejects EVM ${v.name}`, () => {
      expect(() => parseEvmUnsignedTransaction(v.unsignedTransaction)).toThrow();
    });
  }
  for (const v of vectors.invalidFuel) {
    it(`rejects Fuel ${v.name}`, () => {
      expect(() => parseFuelUnsignedTransaction(v.unsignedTransaction, 0n, 255)).toThrow();
    });
  }
  for (const vector of vectors.evm) {
    it(`parses ${vector.name} and derives the ethers signing digest`, () => {
      const result = parseEvmUnsignedTransaction(vector.unsignedTransaction);
      expect(normalize(result)).toMatchObject(vector.expected);
      const compact = fuelCompactSign(
        hexToBytes(`0x${"11".repeat(32)}`),
        hexToBytes(result.signingDigest),
      );
      const signature65 = new Uint8Array(65);
      signature65.set(compact);
      signature65[64] = 27 + (compact[32] >>> 7);
      signature65[32] &= 0x7f;
      expect(bytesToHex(signature65)).toBe(vector.signature);
      if (vector.name === "depositWithPermit")
        expect(result.permit).toMatchObject({ deadline: 2000000000n, v: 27 });
    });
  }
  for (const vector of vectors.fuel) {
    it(`derives fuels transaction ID on chain ${vector.fuelChainId}`, () => {
      const result = parseFuelUnsignedTransaction(
        vector.unsignedTransaction,
        BigInt(vector.fuelChainId),
        vector.fuelMaxInputs,
      );
      expect(normalize(result)).toMatchObject(vector.expected);
      expect(result.inputs.map((i) => i.type)).toEqual(["coin", "contract", "message"]);
      expect(result.outputs.map((o) => o.type)).toEqual(["change", "contract", "variable"]);
      expect(result.outputs[2].amount).toBe(2345n);
      expect(
        bytesToHex(
          fuelCompactSign(hexToBytes(`0x${"11".repeat(32)}`), hexToBytes(result.transactionId)),
        ),
      ).toBe(vector.signature);
    });
  }
  it("decodes both kinds of proof without claiming authentication", () => {
    for (const vector of vectors.proofs)
      expect(parsePreparationProof(vector.proof)).toEqual(vector.claims);
    const claims = { ...vectors.proofs[0].claims, expiresAt: 1 };
    const forged =
      Buffer.from(JSON.stringify(claims)).toString("base64url") +
      "." +
      Buffer.alloc(32).toString("base64url");
    expect(parsePreparationProof(forged).expiresAt).toBe(1);
  });
  it("rejects malformed and unsupported proofs", () => {
    for (const value of [
      "",
      "a.b",
      `${vectors.proofs[0].proof}.`,
      "x".repeat(2049),
      Buffer.from(JSON.stringify({ ...vectors.proofs[0].claims, version: 2 })).toString(
        "base64url",
      ) +
        "." +
        Buffer.alloc(32).toString("base64url"),
    ]) {
      expect(() => parsePreparationProof(value)).toThrow();
    }
  });
  it("rejects every truncated transaction and trailing data", () => {
    for (const vector of [...vectors.evm, vectors.fuel[0]]) {
      const parse = (s: string) =>
        "fuelChainId" in vector
          ? parseFuelUnsignedTransaction(s, 0n, 255)
          : parseEvmUnsignedTransaction(s);
      for (let end = 2; end < vector.unsignedTransaction.length; end += 2) {
        expect(() => parse(vector.unsignedTransaction.slice(0, end))).toThrow();
      }
      expect(() => parse(`${vector.unsignedTransaction}00`)).toThrow();
    }
  });
  it("rejects a modified Fuel script, non-empty witness, padding, and unsupported policies", () => {
    const raw = Buffer.from(vectors.fuel[0].unsignedTransaction.slice(2), "hex");
    for (const offset of [104, 72]) {
      const changed = Buffer.from(raw);
      changed[offset] ^= 0xff;
      expect(() => parseFuelUnsignedTransaction(`0x${changed.toString("hex")}`, 0n, 255)).toThrow();
    }
    const witness = Buffer.from(raw);
    witness[witness.length - 1] = 1;
    expect(() =>
      parseFuelUnsignedTransaction(`0x${witness.toString("hex")}${"00".repeat(8)}`, 0n, 255),
    ).toThrow();
    expect(() =>
      parseFuelUnsignedTransaction(vectors.fuel[0].unsignedTransaction, -1n, 255),
    ).toThrow();
  });
});

describe("Fast Bridge errors and transport", () => {
  it("preserves body-read transport errors without retrying a submit", async () => {
    const error = new DOMException("Response timed out", "AbortError");
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { status: 202 },
        ),
    );
    const client = new FastBridgeClient({ baseUrl: "https://bridge.example", fetch });
    await expect(
      client.submitWithdraw({
        preparationProof: "proof",
        unsignedTransaction: "0x00",
        signature: "0x01",
      }),
    ).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("handles malformed JSON response shapes predictably", async () => {
    for (const [status, payload, code] of [
      [200, null, "INVALID_RESPONSE"],
      [200, [], "INVALID_RESPONSE"],
      [502, { error: "gateway error" }, "HTTP_ERROR"],
      [502, { error: null }, "HTTP_ERROR"],
    ] as const) {
      const client = new FastBridgeClient({
        baseUrl: "https://bridge.example",
        fetch: async () => new Response(JSON.stringify(payload), { status }),
      });
      await expect(client.getInfo()).rejects.toMatchObject({ status, bridgeCode: code });
    }
  });
  it("preserves not-found, rate-limit and proof error codes and never retries", async () => {
    for (const status of [404, 410, 429, 503]) {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "TEST_CODE", message: "test", details: { retry: false } },
            }),
            { status },
          ),
      );
      const client = new FastBridgeClient({ baseUrl: "https://bridge.example", fetch });
      await expect(
        client.submitWithdraw({
          preparationProof: "proof",
          unsignedTransaction: "0x00",
          signature: "0x01",
        }),
      ).rejects.toMatchObject({
        status,
        bridgeCode: "TEST_CODE",
        details: { retry: false },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("preserves HTTP status on non-JSON responses", async () => {
    const client = new FastBridgeClient({
      baseUrl: "https://bridge.example",
      fetch: async () => new Response("gateway", { status: 502 }),
    });
    await expect(client.getInfo()).rejects.toMatchObject({
      status: 502,
      bridgeCode: "INVALID_RESPONSE",
    });
  });
  it("rejects invalid configuration", () => {
    expect(() => new FastBridgeClient({ baseUrl: "file:///tmp" })).toThrow();
    expect(() => new FastBridgeClient({ baseUrl: "https://bridge.example?query=yes" })).toThrow();
    expect(
      () => new FastBridgeClient({ baseUrl: "https://bridge.example", timeoutMs: 0 }),
    ).toThrow();
  });
});
