// Offline oracle fixture generator. No SDK runtime/dev dependencies are added.
// Usage: node fixtures/bridge/generate.mjs /absolute/path/to/fuel-fast-bridge
// Requires that checkout's services/bridge-proxy dependencies (fuels 0.103.0,
// ethers 6.15.0). Emits JSON to stdout; no RPCs or on-chain submissions.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "services/bridge-proxy/package.json"));
const { Contract, ScriptTransactionRequest, Signer, InputType, OutputType, bn } = require("fuels");
const { Interface, Transaction, Wallet, decodeRlp, encodeRlp } = require("ethers");
const b256 = (byte) => "0x" + byte.repeat(32);
const evmAddress = "0x" + "66".repeat(20);
const signer = new Signer(b256("11"));
const owner = signer.address.toB256();
const wallet = new Wallet(b256("11"));
const assetId = b256("22"), registryId = b256("99"), subId = b256("55");
const iface = new Interface([
  "function deposit(bytes32,address,uint256,bool)",
  "function depositWithPermit(bytes32,address,uint256,uint256,uint8,bytes32,bytes32,bool)",
  "function depositETH(bytes32,bool)",
]);
const evm = [];
for (const [method, args, value] of [
  ["depositETH", [owner, false], 10n ** 16n],
  ["deposit", [owner, evmAddress, 2n ** 200n, true], 0n],
  ["depositWithPermit", [owner, evmAddress, 123456789n, 2000000000n, 27, b256("33"), b256("44"), false], 0n],
]) {
  const tx = Transaction.from({
    type: 2, chainId: 11155111, nonce: 7, maxPriorityFeePerGas: 1000000000n,
    maxFeePerGas: 3000000000n, gasLimit: 150000n, to: evmAddress,
    value, data: iface.encodeFunctionData(method, args),
  });
  evm.push({ name: method, unsignedTransaction: tx.unsignedSerialized,
    expected: { method, chainId: tx.chainId.toString(), nonce: "7",
      messengerAddress: evmAddress, value: value.toString(), gasLimit: "150000",
      maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1000000000",
      estimatedNetworkFee: "450000000000000", recipient: owner,
      recipientIsContract: args.at(-1), tokenAddress: method === "depositETH" ? null : evmAddress,
      amount: (method === "depositETH" ? value : args[2]).toString(), signingDigest: tx.unsignedHash },
    signature: wallet.signingKey.sign(tx.unsignedHash).serialized });
}
const abi = JSON.parse(readFileSync(resolve(repo, "src/abis/asset-registry.json"), "utf8"));
const provider = { getChain: async () => ({ consensusParameters: { txParameters: { maxInputs: bn(255) } } }) };
const contract = new Contract(registryId, abi, provider);
const call = await contract.functions.withdraw_via_fast_bridge_with_fee(subId, 11155111, "0x" + "00".repeat(12) + evmAddress.slice(2), bn(2345))
  .callParams({ forward: [bn(1000000), assetId] }).getTransactionRequest();
const tx = ScriptTransactionRequest.from({
  script: call.script, scriptData: call.scriptData, gasLimit: bn(1000000),
  maxFee: bn(100000), expiration: 123456, tip: bn(3), maturity: 123000, ownerInputIndex: 0, witnessLimit: bn(72),
  inputs: [
    { type: InputType.Coin, id: b256("33") + "0001", owner, amount: bn(5000000), assetId,
      txPointer: "0x00000000000000010000000000000002", witnessIndex: 0, predicateGasUsed: bn(0), predicate: "0x", predicateData: "0x" },
    { type: InputType.Contract, txID: b256("77"), outputIndex: 3,
      txPointer: "0x00000000000000010000000000000002", contractId: registryId },
    { type: InputType.Message, sender: b256("44"), recipient: owner, amount: bn(2000000),
      nonce: b256("66"), witnessIndex: 0, predicateGasUsed: bn(0), data: "0x", predicate: "0x", predicateData: "0x" },
  ],
  outputs: [
    { type: OutputType.Change, to: owner, amount: bn(4000000), assetId },
    { type: OutputType.Contract, inputIndex: 1, balanceRoot: b256("88"), stateRoot: b256("99") },
    { type: OutputType.Variable, to: b256("aa"), amount: bn(2345), assetId },
  ],
  witnesses: ["0x"],
});
const fuel = [0n, 9889n, 18446744073709551615n].map((chain) => ({
  fuelChainId: chain.toString(), fuelMaxInputs: 255, unsignedTransaction: "0x" + Buffer.from(tx.toTransactionBytes()).toString("hex"),
  expected: { assetId, assetSubId: subId, assetRegistryContractId: registryId, destinationChainId: 11155111,
    recipient: evmAddress, grossAmount: "1000000", bridgeFee: "2345", netAmount: "997655",
    networkFee: { maxFee: "100000" }, expirationBlockHeight: 123456, transactionId: tx.getTransactionId(chain) },
  signature: signer.sign(tx.getTransactionId(chain)),
}));
const proofs = [["deposit", evm[0].unsignedTransaction, wallet.address.toLowerCase()],
  ["withdraw", fuel[0].unsignedTransaction, owner]].map(([operation, unsigned, signer]) => {
    const claims = { version: 1, keyId: "fixture-key", expiresAt: 2000000000, signer };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const mac = createHmac("sha256", Buffer.alloc(32, 1)).update(
      Buffer.concat([Buffer.from(`fuel-fast-bridge:preparation-proof:${operation}:v1\0${encoded}\0`),
        Buffer.from(unsigned.slice(2), "hex")])).digest("base64url");
    return { operation, claims, proof: encoded + "." + mac };
  });
const invalidEvm = [];
const invalidEnvelope = (name, index, mutate) => {
  const fields = decodeRlp("0x" + evm[index].unsignedTransaction.slice(4));
  mutate(fields);
  invalidEvm.push({ name, unsignedTransaction: "0x02" + encodeRlp(fields).slice(2) });
};
const signed = Transaction.from(evm[0].unsignedTransaction);
signed.signature = wallet.signingKey.sign(signed.unsignedHash);
invalidEvm.push({ name: "signed envelope", unsignedTransaction: signed.serialized });
invalidEnvelope("zero-prefixed nonce", 0, (f) => { f[1] = "0x0007"; });
invalidEnvelope("uint256 overflow", 0, (f) => { f[4] = "0x01" + "00".repeat(32); });
invalidEnvelope("nonempty access list", 0, (f) => { f[8] = [[evmAddress, []]]; });
invalidEnvelope("unknown call", 0, (f) => { f[7] = "0xdeadbeef" + f[7].slice(10); });
invalidEnvelope("invalid bool", 0, (f) => { f[7] = f[7].slice(0, -2) + "02"; });
invalidEnvelope("token deposit with ETH value", 1, (f) => { f[6] = "0x01"; });
invalidEnvelope("nonzero token address padding", 1, (f) => {
  const data = Buffer.from(f[7].slice(2), "hex"); data[36] = 1; f[7] = "0x" + data.toString("hex");
});
invalidEnvelope("permit v overflow", 2, (f) => {
  const data = Buffer.from(f[7].slice(2), "hex"); data[4 + 4 * 32 + 30] = 1; f[7] = "0x" + data.toString("hex");
});
const invalidFuel = [];
const mutateFuel = (name, mutate) => {
  const raw = Buffer.from(tx.toTransactionBytes()); mutate(raw);
  invalidFuel.push({ name, unsignedTransaction: "0x" + raw.toString("hex") });
};
const padded = (n) => Math.ceil(n / 8) * 8;
const dataStart = 96 + padded(call.script.length);
const inputStart = dataStart + padded(call.scriptData.length) + 6 * 8;
mutateFuel("unknown policies", (b) => { b[71] |= 64; });
mutateFuel("nonempty witness", (b) => { b[b.length - 1] = 1; });
mutateFuel("unsupported script", (b) => { b[96] = 0; });
mutateFuel("invalid selector pointer", (b) => { b[dataStart + 79] ^= 1; });
mutateFuel("invalid args pointer", (b) => { b[dataStart + 87] ^= 1; });
mutateFuel("relocated but self-consistent pointers", (b) => {
  for (const offset of [96, 100, 108]) b.writeUInt32BE(b.readUInt32BE(offset) + 8, offset);
  for (const offset of [dataStart + 72, dataStart + 80]) b.writeBigUInt64BE(b.readBigUInt64BE(offset) + 8n, offset);
});
mutateFuel("wrong selector", (b) => { b[dataStart + 96] ^= 1; });
mutateFuel("nonzero data padding", (b) => { b[dataStart + call.scriptData.length] = 1; });
mutateFuel("predicate input", (b) => { b[inputStart + 159] = 1; });
mutateFuel("unsupported witness index", (b) => { b[inputStart + 143] = 1; });
mutateFuel("unsupported input type", (b) => { b[inputStart + 7] = 3; });
const alternateProvider = { getChain: async () => ({ consensusParameters: { txParameters: { maxInputs: bn(511) } } }) };
const alternateRegistry = new Contract(registryId, abi, alternateProvider);
const alternateCall = await alternateRegistry.functions.withdraw_via_fast_bridge_with_fee(subId, 11155111, "0x" + "00".repeat(12) + evmAddress.slice(2), bn(2345))
  .callParams({ forward: [bn(1000000), assetId] }).getTransactionRequest();
tx.script = alternateCall.script;
tx.scriptData = alternateCall.scriptData;
fuel.push({ ...fuel[0], fuelMaxInputs: 511,
  unsignedTransaction: "0x" + Buffer.from(tx.toTransactionBytes()).toString("hex"),
  expected: { ...fuel[0].expected, transactionId: tx.getTransactionId(0) },
  signature: signer.sign(tx.getTransactionId(0)) });
console.log(JSON.stringify({ source: { fuels: "0.103.0", ethers: "6.15.0" }, evm, fuel, proofs, invalidEvm, invalidFuel }, null, 2));
