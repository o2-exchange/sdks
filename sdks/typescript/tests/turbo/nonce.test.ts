/**
 * Nonces belong to the account a batch EXECUTES AS, not to the session.
 *
 * A sequential nonce coordinates with that account's own on-chain counter,
 * and a Turbo batch executes as the margin CHILD — whose counter is
 * entirely separate from its parent's. Regression tests for PR #76 review.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractCall } from "../../src/encoding.js";
import { Network, O2Client } from "../../src/index.js";
import type { SessionState } from "../../src/models.js";
import type { PreparedBatch } from "../../src/turbo/host.js";

const PARENT = "0x1111111111111111111111111111111111111111111111111111111111111111";
const CHILD = "0x2222222222222222222222222222222222222222222222222222222222222222";

const CALL: ContractCall = {
  contractId: new Uint8Array(32),
  functionSelector: new Uint8Array(4),
  amount: 0n,
  assetId: new Uint8Array(32),
  gas: 0n,
  callData: null,
};

/** Exposes the protected batch submitter and lets a fake API be injected. */
class TestClient extends O2Client {
  submit(batch: Omit<PreparedBatch, "endpoint"> & { endpoint?: PreparedBatch["endpoint"] }) {
    return this.submitPrepared(batch);
  }
  setApi(api: unknown) {
    (this as unknown as { api: unknown }).api = api;
  }
  nonces() {
    return (this as unknown as { accountNonces: Map<string, bigint> }).accountNonces;
  }
}

describe("per-account nonces", () => {
  let client: TestClient;
  let session: SessionState;
  let submitActions: ReturnType<typeof vi.fn>;
  let getAccount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new TestClient({ network: Network.TESTNET });
    submitActions = vi.fn().mockResolvedValue({ txId: "0xtx", isPreflightError: false });
    getAccount = vi
      .fn()
      .mockImplementation(async ({ tradeAccountId }: { tradeAccountId: string }) =>
        tradeAccountId === CHILD
          ? { trade_account: { nonce: 40n } }
          : { trade_account: { nonce: 7n } },
      );
    client.setApi({ submitActions, submitMarginAccountActions: submitActions, getAccount });

    session = {
      ownerAddress: "0xowner",
      tradeAccountId: PARENT as never,
      sessionPrivateKey: new Uint8Array(32).fill(9),
      sessionAddress: "0xsession",
      contractIds: [],
      expiry: 2_000_000_000,
      nonce: 7n,
    };
    client.setSession(session);
  });

  const batch = (tradeAccountId: string) => ({
    marketActions: [{ market_id: "m", actions: [{ SettleBalance: {} }] }],
    calls: [CALL],
    tradeAccountId,
  });

  it("signs a PARENT batch with the session nonce, exactly as before", async () => {
    await client.submit(batch(PARENT));
    expect(submitActions.mock.calls[0][1].nonce).toBe("7");
    expect(session.nonce).toBe(8n);
    expect(client.nonces().size).toBe(0);
  });

  it("signs a CHILD batch with the CHILD's own nonce", async () => {
    await client.submit(batch(CHILD));
    expect(getAccount).toHaveBeenCalledWith({ tradeAccountId: CHILD });
    expect(submitActions.mock.calls[0][1].nonce).toBe("40");
  });

  it("does not touch the parent's counter when a child batch succeeds", async () => {
    // This is the corrupting half: a Turbo trade that advanced the
    // session's nonce desynced every later spot action.
    await client.submit(batch(CHILD));
    expect(session.nonce).toBe(7n);
    expect(client.nonces().get(CHILD)).toBe(41n);
  });

  it("tracks each account independently across interleaved batches", async () => {
    await client.submit(batch(PARENT)); // 7
    await client.submit(batch(CHILD)); // 40
    await client.submit(batch(PARENT)); // 8
    await client.submit(batch(CHILD)); // 41
    expect(submitActions.mock.calls.map((c) => c[1].nonce)).toEqual(["7", "40", "8", "41"]);
    expect(session.nonce).toBe(9n);
    expect(client.nonces().get(CHILD)).toBe(42n);
  });

  it("fetches a child's nonce once, then tracks it locally", async () => {
    await client.submit(batch(CHILD));
    await client.submit(batch(CHILD));
    const childLookups = getAccount.mock.calls.filter((c) => c[0].tradeAccountId === CHILD);
    expect(childLookups).toHaveLength(1);
  });

  it("resyncs from the account that actually executed, on error", async () => {
    submitActions.mockRejectedValueOnce(new Error("reverted"));
    getAccount.mockResolvedValue({ trade_account: { nonce: 99n } });
    await expect(client.submit(batch(CHILD))).rejects.toThrow("reverted");
    // Resynced the CHILD, and left the parent's counter alone.
    expect(client.nonces().get(CHILD)).toBe(99n);
    expect(session.nonce).toBe(7n);
  });

  it("leaves the nonce alone on a preflight error — it never reached the chain", async () => {
    submitActions.mockResolvedValue({ txId: null, isPreflightError: true });
    await client.submit(batch(CHILD));
    expect(client.nonces().get(CHILD)).toBe(40n);
  });

  it("refreshAccountNonce re-reads and replaces the tracked value", async () => {
    await client.submit(batch(CHILD));
    expect(client.nonces().get(CHILD)).toBe(41n);
    getAccount.mockResolvedValue({ trade_account: { nonce: 60n } });
    await expect(client.refreshAccountNonce(CHILD as never)).resolves.toBe(60n);
    expect(client.nonces().get(CHILD)).toBe(60n);
  });
});
