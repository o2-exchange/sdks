import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Claims are UNAUTHENTICATED. Parsing does not verify the HMAC or transaction binding. */
export interface PreparationProofClaims {
  version: 1;
  keyId: string;
  /** Unix seconds; parsing does not reject expired proofs. */
  expiresAt: number;
  signer: string;
}

function requireValue(ok: unknown, message = "Invalid bridge transaction"): asserts ok {
  if (!ok) throw new Error(message);
}
function unhex(value: string): Uint8Array {
  requireValue(value.length <= 32770 && /^0x(?:[\da-fA-F]{2})+$/.test(value));
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}
function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function integer(value: Uint8Array): bigint {
  return value.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}
function word(value: bigint): Uint8Array {
  requireValue(value >= 0n && value <= 0xffffffffffffffffn, "Fuel chain ID must fit u64");
  return unhex(`0x${value.toString(16).padStart(16, "0")}`);
}
function base64url(value: string): Uint8Array {
  requireValue(/^[A-Za-z0-9_-]+$/.test(value), "Invalid preparation proof encoding");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  requireValue(canonical === value, "Noncanonical preparation proof encoding");
  return bytes;
}
/** Decode only. Never use these claims to establish the API's authenticity or signer ownership. */
export function parsePreparationProof(proof: string): PreparationProofClaims {
  requireValue(proof.length <= 2048, "Preparation proof too large");
  const parts = proof.split(".");
  requireValue(
    parts.length === 2 && base64url(parts[1] ?? "").length === 32,
    "Invalid preparation proof",
  );
  const claims = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(base64url(parts[0] ?? "")),
  ) as PreparationProofClaims;
  requireValue(
    claims &&
      Object.keys(claims).sort().join() === "expiresAt,keyId,signer,version" &&
      claims.version === 1 &&
      typeof claims.keyId === "string" &&
      claims.keyId.length > 0 &&
      Number.isSafeInteger(claims.expiresAt) &&
      claims.expiresAt > 0 &&
      typeof claims.signer === "string" &&
      /^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(claims.signer),
    "Invalid preparation proof claims",
  );
  return claims;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(size: number): Uint8Array {
    requireValue(
      Number.isSafeInteger(size) && size >= 0 && size <= this.bytes.length - this.offset,
      "Truncated transaction",
    );
    const result = this.bytes.slice(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  num(size = 8): bigint {
    return integer(this.take(size));
  }
  count(max = 16384): number {
    const n = this.num();
    requireValue(n <= BigInt(max), "Unsupported transaction size or field");
    return Number(n);
  }
  padded(size: number): Uint8Array {
    const data = this.take(size);
    requireValue(
      this.take((8 - (size % 8)) % 8).every((b) => b === 0),
      "Nonzero transaction padding",
    );
    return data;
  }
  done(): void {
    requireValue(this.offset === this.bytes.length, "Trailing transaction data");
  }
}

// Bounded canonical RLP, used only for the proxy's unsigned EIP-1559 envelope.
type Rlp = Uint8Array | Rlp[];
function rlp(reader: Reader, depth = 0): Rlp {
  requireValue(depth < 4, "RLP nesting too deep");
  const tag = reader.take(1)[0] ?? 0;
  if (tag < 128) return Uint8Array.of(tag);
  const list = tag >= 192;
  const short = list ? 192 : 128;
  const long = list ? 247 : 183;
  let length = tag - short;
  if (tag > long) {
    const encoded = reader.take(tag - long);
    requireValue(encoded[0] !== 0);
    const n = integer(encoded);
    requireValue(n >= 56n && n <= 16384n);
    length = Number(n);
  }
  const data = reader.take(length);
  if (!list) {
    requireValue(length !== 1 || (data[0] ?? 0) >= 128, "Noncanonical RLP");
    return data;
  }
  const children = new Reader(data);
  const result: Rlp[] = [];
  while (children.offset < data.length) result.push(rlp(children, depth + 1));
  return result;
}
function leaf(value: Rlp | undefined, size?: number): Uint8Array {
  requireValue(
    value instanceof Uint8Array && (size === undefined || value.length === size),
    "Invalid EVM field",
  );
  return value;
}
function evmInt(value: Rlp | undefined): bigint {
  const data = leaf(value);
  requireValue(
    data.length <= 32 && (data.length === 0 || data[0] !== 0),
    "Noncanonical EVM integer",
  );
  return integer(data);
}

export interface EvmDepositInspection {
  type: 2;
  chainId: bigint;
  nonce: bigint;
  messengerAddress: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gasLimit * maxFeePerGas, in wei: an upper bound, NOT an actual fee quote.
   * Does not include chain-specific extra fees such as rollup L1 data fees. */
  estimatedNetworkFee: bigint;
  data: string;
  method: "deposit" | "depositWithPermit" | "depositETH";
  recipient: string;
  recipientIsContract: boolean;
  tokenAddress: string | null;
  /** EVM token base units (or wei for depositETH), not API/Fuel base units. */
  amount: bigint;
  permit?: { deadline: bigint; v: number; r: string; s: string };
  /** Locally derived keccak256 of the unsigned envelope; sign as a raw digest. */
  signingDigest: string;
}
/** Inspect the proxy's canonical unsigned type-2 deposit. Rejects signed/other transaction types. */
export function parseEvmUnsignedTransaction(unsignedTransaction: string): EvmDepositInspection {
  const bytes = unhex(unsignedTransaction);
  const reader = new Reader(bytes);
  requireValue(reader.num(1) === 2n, "Only unsigned EIP-1559 deposits are supported");
  const fields = rlp(reader);
  reader.done();
  requireValue(Array.isArray(fields) && fields.length === 9, "Expected unsigned EIP-1559 fields");
  requireValue(
    Array.isArray(fields[8]) && fields[8].length === 0,
    "Proxy deposits require an empty access list",
  );
  const chainId = evmInt(fields[0]),
    nonce = evmInt(fields[1]);
  const maxPriorityFeePerGas = evmInt(fields[2]),
    maxFeePerGas = evmInt(fields[3]),
    gasLimit = evmInt(fields[4]);
  requireValue(chainId > 0n && maxPriorityFeePerGas <= maxFeePerGas);
  const messengerAddress = hex(leaf(fields[5], 20)),
    value = evmInt(fields[6]),
    data = leaf(fields[7]);
  const signatures = [
    "deposit(bytes32,address,uint256,bool)",
    "depositWithPermit(bytes32,address,uint256,uint256,uint8,bytes32,bytes32,bool)",
    "depositETH(bytes32,bool)",
  ];
  const methodIndex = signatures.findIndex(
    (s) => hex(keccak_256(new TextEncoder().encode(s)).slice(0, 4)) === hex(data.slice(0, 4)),
  );
  requireValue(methodIndex >= 0, "Unknown Messenger method");
  const count = [4, 8, 2][methodIndex] ?? 0;
  requireValue(data.length === 4 + count * 32, "Invalid Messenger calldata length");
  const arg = (i: number) => data.slice(4 + i * 32, 36 + i * 32);
  const recipient = hex(arg(0)),
    flag = integer(arg(count - 1));
  requireValue(flag <= 1n, "Invalid recipientIsContract");
  let tokenAddress: string | null = null;
  let amount = value;
  let permit: EvmDepositInspection["permit"];
  if (methodIndex !== 2) {
    requireValue(
      value === 0n &&
        arg(1)
          .slice(0, 12)
          .every((b) => b === 0),
    );
    tokenAddress = hex(arg(1).slice(12));
    amount = integer(arg(2));
    if (methodIndex === 1) {
      requireValue(integer(arg(4)) <= 255n, "Invalid permit v");
      permit = {
        deadline: integer(arg(3)),
        v: Number(integer(arg(4))),
        r: hex(arg(5)),
        s: hex(arg(6)),
      };
    }
  }
  return {
    type: 2,
    chainId,
    nonce,
    messengerAddress,
    value,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    estimatedNetworkFee: gasLimit * maxFeePerGas,
    data: hex(data),
    method: (["deposit", "depositWithPermit", "depositETH"] as const)[methodIndex] ?? "deposit",
    recipient,
    recipientIsContract: flag === 1n,
    tokenAddress,
    amount,
    ...(permit ? { permit } : {}),
    signingDigest: hex(keccak_256(bytes)),
  };
}

export interface FuelInputInspection {
  type: "coin" | "contract" | "message";
  owner?: string;
  amount?: bigint;
  assetId?: string;
  contractId?: string;
  witnessIndex?: number;
}
export interface FuelOutputInspection {
  type: "contract" | "change" | "variable";
  /** Variable recipients/assets and Change/Variable amounts are execution results, not signed guarantees. */
  to?: string;
  amount?: bigint;
  assetId?: string;
  inputIndex?: number;
}
export interface FuelWithdrawalInspection {
  assetId: string;
  /** Asset sub-ID encoded in the Asset Registry call. */
  assetSubId: string;
  assetRegistryContractId: string;
  destinationChainId: number;
  recipient: string;
  grossAmount: bigint;
  /** Fee quote embedded in the call, in Fuel asset base units. Execution may charge a different fee within contract tolerance. */
  bridgeFee: bigint;
  /** grossAmount - bridgeFee: expected, not guaranteed, delivery amount. */
  netAmount: bigint;
  networkFee: { maxFee: bigint };
  expirationBlockHeight: number;
  scriptGasLimit: bigint;
  policies: Record<string, bigint>;
  inputs: FuelInputInspection[];
  outputs: FuelOutputInspection[];
  /** Locally computed using the caller-supplied, independently trusted Fuel chain ID. */
  transactionId: string;
}

/** Inspect the pinned proxy single-call script, not arbitrary Fuel programs.
 * Parsing is not a safety approval: compare recipients, amounts, contracts, inputs and outputs
 * with independently trusted expectations before signing transactionId. No RPC calls are made.
 * @param fuelChainId Independently trusted chain ID used to derive the signing ID.
 * @param fuelMaxInputs Independently trusted consensus txParameters.maxInputs, needed to locate script data in VM memory.
 */
export function parseFuelUnsignedTransaction(
  unsignedTransaction: string,
  fuelChainId: bigint,
  fuelMaxInputs: number,
): FuelWithdrawalInspection {
  requireValue(
    Number.isSafeInteger(fuelMaxInputs) && fuelMaxInputs > 0 && fuelMaxInputs <= 65535,
    "Invalid Fuel consensus maxInputs",
  );
  const bytes = unhex(unsignedTransaction),
    normalized = bytes.slice(),
    r = new Reader(bytes);
  const zero = (start: number, size: number) => normalized.fill(0, start, start + size);
  requireValue(r.num() === 0n, "Expected Fuel Script transaction");
  const scriptGasLimit = r.num();
  r.take(32);
  zero(16, 32);
  const scriptLength = r.count(),
    dataLength = r.count(),
    mask = r.count(63);
  const inputCount = r.count(),
    outputCount = r.count(),
    witnesses = r.count();
  requireValue(
    inputCount > 0 && inputCount <= fuelMaxInputs && witnesses === 1,
    "Expected supported inputs and one unsigned owner witness",
  );
  const script = r.padded(scriptLength),
    data = r.padded(dataLength);
  const policies: Record<string, bigint> = {};
  ["tip", "witnessLimit", "maturity", "maxFee", "expiration", "owner"].forEach((name, i) => {
    if (mask & (1 << i)) policies[name] = r.num();
  });
  requireValue(
    policies.maxFee !== undefined &&
      policies.expiration !== undefined &&
      policies.expiration <= 0xffffffffn,
  );
  const inputs: FuelInputInspection[] = [];
  for (let i = 0; i < inputCount; i++) {
    const kind = r.count(2),
      start = r.offset;
    if (kind === 1) {
      r.take(32);
      r.count(65535);
      r.take(64);
      r.count(0xffffffff);
      r.count(65535);
      zero(start, 120);
      inputs.push({ type: "contract", contractId: hex(r.take(32)) });
    } else {
      let owner: string, amount: bigint, assetId: string | undefined;
      if (kind === 0) {
        r.take(32);
        r.count(65535);
        owner = hex(r.take(32));
        amount = r.num();
        assetId = hex(r.take(32));
        const pointer = r.offset;
        r.count(0xffffffff);
        r.count(65535);
        zero(pointer, 16);
      } else {
        r.take(32);
        owner = hex(r.take(32));
        amount = r.num();
        r.take(32);
      }
      const witnessIndex = r.count(65535);
      requireValue(witnessIndex === 0);
      const gasOffset = r.offset;
      requireValue(r.num() === 0n, "Predicates are unsupported");
      zero(gasOffset, 8);
      if (kind === 2) requireValue(r.num() === 0n, "Message data is unsupported");
      requireValue(r.num() === 0n && r.num() === 0n, "Predicates are unsupported");
      inputs.push({
        type: kind === 0 ? "coin" : "message",
        owner,
        amount,
        ...(assetId ? { assetId } : {}),
        witnessIndex,
      });
    }
  }
  const outputs: FuelOutputInspection[] = [];
  for (let i = 0; i < outputCount; i++) {
    const kind = r.count(3);
    requireValue(kind !== 0, "Coin outputs are unsupported in proxy withdrawals");
    if (kind === 1) {
      const inputIndex = r.count();
      requireValue(inputs[inputIndex]?.type === "contract");
      zero(r.offset, 64);
      r.take(64);
      outputs.push({ type: "contract", inputIndex });
    } else {
      const start = r.offset,
        to = hex(r.take(32)),
        amount = r.num(),
        assetId = hex(r.take(32));
      if (kind === 2) zero(start + 32, 8);
      if (kind === 3) zero(start, 72);
      outputs.push({
        type: kind === 2 ? "change" : "variable",
        to,
        amount,
        assetId,
      });
    }
  }
  const witnessOffset = r.offset;
  requireValue(r.num() === 0n, "Expected empty unsigned witness");
  r.done();
  zero(88, 8);
  const d = new Reader(data);
  const grossAmount = d.num(),
    assetId = hex(d.take(32)),
    assetRegistryContractId = hex(d.take(32));
  const selectorPointer = d.count(0x3ffff + 88),
    argsPointer = d.count(0x3ffff + 256);
  const selector = new TextEncoder().encode("withdraw_via_fast_bridge_with_fee");
  requireValue(
    d.num() === BigInt(selector.length) && hex(d.take(selector.length)) === hex(selector),
    "Unknown Fuel call",
  );
  requireValue(
    argsPointer === selectorPointer + 8 + selector.length,
    "Invalid Fuel argument pointer",
  );
  const amountOffset = selectorPointer - 88;
  // VM memory prefix = 72 + maxInputs * 40; Script header = 96; CALL script = 24.
  requireValue(
    amountOffset === 192 + 40 * fuelMaxInputs,
    "Fuel call pointer does not address this transaction's script data",
  );
  requireValue(amountOffset >= 0 && amountOffset + 40 <= 0x3ffff);
  const expected = [
    0x72400000 | (amountOffset + 40),
    0x72440000 | amountOffset,
    0x5d451000,
    0x72480000 | (amountOffset + 8),
    0x2d41148a,
    0x24040000,
  ];
  const s = new Reader(script);
  requireValue(
    script.length === 24 && expected.every((v) => s.num(4) === BigInt(v)),
    "Unsupported Fuel script",
  );
  const assetSubId = hex(d.take(32)),
    destinationChainId = Number(d.num(4)),
    paddedRecipient = d.take(32),
    bridgeFee = d.num();
  d.done();
  requireValue(paddedRecipient.slice(0, 12).every((b) => b === 0) && grossAmount >= bridgeFee);
  requireValue(
    paddedRecipient.slice(12).some((b) => b !== 0),
    "Zero withdrawal recipient",
  );
  requireValue(
    inputs.some((i) => i.contractId === assetRegistryContractId),
    "Missing Asset Registry input",
  );
  const signingBytes = new Uint8Array(8 + witnessOffset);
  signingBytes.set(word(fuelChainId));
  signingBytes.set(normalized.slice(0, witnessOffset), 8);
  return {
    assetId,
    assetSubId,
    assetRegistryContractId,
    destinationChainId,
    recipient: hex(paddedRecipient.slice(12)),
    grossAmount,
    bridgeFee,
    netAmount: grossAmount - bridgeFee,
    networkFee: { maxFee: policies.maxFee },
    expirationBlockHeight: Number(policies.expiration),
    scriptGasLimit,
    policies,
    inputs,
    outputs,
    transactionId: hex(sha256(signingBytes)),
  };
}
