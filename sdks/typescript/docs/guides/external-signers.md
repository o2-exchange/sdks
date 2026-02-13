# External Signers Guide

For production deployments, you likely manage private keys in a secure
enclave (hardware wallet, AWS KMS, Google Cloud KMS, HashiCorp Vault,
etc.) rather than in-process. The O2 TypeScript SDK supports this via the
`Signer` interface, with built-in `ExternalSigner` and `ExternalEvmSigner`
classes.

## How It Works

The SDK handles all message framing (prefix bytes, hashing) internally.
Your external signing function only needs to:

1. **Receive** a 32-byte digest.
2. **Sign** it with secp256k1 (ECDSA).
3. **Return** a 64-byte Fuel compact signature.

Use `toFuelCompactSignature()` to convert standard `(r, s, recoveryId)`
components to the expected format.

## The `Signer` Interface

The SDK defines a `Signer` interface that all wallet types implement.
Client methods (`createSession`, `setupAccount`, `withdraw`) accept any
`Signer`:

```ts
interface Signer {
  readonly b256Address: string;
  personalSign(message: Uint8Array): Uint8Array;
}
```

The built-in `WalletState` (returned by `O2Client.generateWallet()`,
`O2Client.loadWallet()`, etc.) extends `Signer` automatically.

## Fuel-Native External Signer

For Fuel-native accounts, use `ExternalSigner`. The SDK handles the Fuel
`personalSign` message framing; your callback only signs a 32-byte digest:

```ts
import {
  O2Client,
  Network,
  ExternalSigner,
  toFuelCompactSignature,
} from "@o2exchange/sdk";

function myKmsSign(digest: Uint8Array): Uint8Array {
  const { r, s, recoveryId } = myKms.sign("my-key-id", digest);
  return toFuelCompactSignature(r, s, recoveryId);
}

const signer = new ExternalSigner("0x1234...abcd", myKmsSign);

const client = new O2Client({ network: Network.MAINNET });
await client.setupAccount(signer);
await client.createSession(signer, ["FUEL/USDC"]);

// Session actions use the session key — not the external signer
const response = await client.createOrder("FUEL/USDC", "Buy", "0.02", "100");
```

> **Important:** Session **actions** (orders, cancels, settlements) are
> signed with the session key — not the external signer. The external
> signer is only needed for session creation and withdrawals.

## EVM External Signer

For EVM-compatible accounts (MetaMask, Ledger via Ethereum, etc.), use
`ExternalEvmSigner`. The only difference is the message framing: EVM uses
`\x19Ethereum Signed Message:\n` prefix + keccak256 instead of Fuel's
`\x19Fuel Signed Message:\n` prefix + SHA-256:

```ts
import { ExternalEvmSigner, toFuelCompactSignature } from "@o2exchange/sdk";

const signer = new ExternalEvmSigner(
  "0x000000000000000000000000abcd...1234", // b256 (zero-padded)
  "0xabcd...1234",                          // EVM address
  myKmsSign,
);

await client.setupAccount(signer);
await client.createSession(signer, ["FUEL/USDC"]);
```

## Implementing the Callback

The `SignDigestFn` callback must return a **64-byte Fuel compact signature**.
Use `toFuelCompactSignature` to convert from standard `(r, s, recoveryId)`
components:

```ts
import { toFuelCompactSignature } from "@o2exchange/sdk";

function signDigest(digest: Uint8Array): Uint8Array {
  const r: Uint8Array = ...;   // 32 bytes
  const s: Uint8Array = ...;   // 32 bytes (must be low-s normalized)
  const v: number     = ...;   // 0 or 1

  return toFuelCompactSignature(r, s, v);
}
```

The Fuel compact format stores the recovery ID in the MSB of the first
byte of `s`:

```
s[0] = (recoveryId << 7) | (s[0] & 0x7F)
```

> **Warning:** The `s` component **must be low-s normalized** before
> passing to `toFuelCompactSignature`. Most modern signing libraries
> (ethers.js, @noble/secp256k1, etc.) do this automatically, but check
> your KMS documentation.

## AWS KMS Example

```ts
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { ExternalSigner, toFuelCompactSignature } from "@o2exchange/sdk";

const kms = new KMSClient({ region: "us-east-1" });

function awsKmsSign(digest: Uint8Array): Uint8Array {
  const command = new SignCommand({
    KeyId: "alias/my-trading-key",
    Message: digest,
    MessageType: "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",
  });

  const response = kms.send(command);
  const { r, s, recoveryId } = parseDerSignature(response.Signature);
  return toFuelCompactSignature(r, s, recoveryId);
}

const signer = new ExternalSigner("0x...", awsKmsSign);
```

## Custom Signer Implementation

You can also implement the `Signer` interface directly for full control.
Use the digest helpers to ensure your framing matches the SDK:

```ts
import {
  type Signer,
  fuelPersonalSignDigest,
} from "@o2exchange/sdk";

class MyCustomSigner implements Signer {
  readonly b256Address: string;

  constructor(address: string) {
    this.b256Address = address;
  }

  personalSign(message: Uint8Array): Uint8Array {
    const digest = fuelPersonalSignDigest(message);
    return myBackendSign(digest);
  }
}

const signer = new MyCustomSigner("0x1234...abcd");
await client.createSession(signer, ["FUEL/USDC"]);
```

For EVM accounts, use `evmPersonalSignDigest` instead of
`fuelPersonalSignDigest`.
