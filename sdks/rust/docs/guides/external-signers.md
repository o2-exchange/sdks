# External Signers Guide

For production deployments, you likely manage private keys in a secure
enclave (hardware wallet, AWS KMS, Google Cloud KMS, HashiCorp Vault,
etc.) rather than in-process. The O2 Rust SDK supports this via the
[`SignableWallet`](crate::SignableWallet) trait.

## How It Works

The SDK handles all message framing (prefix bytes, hashing) internally.
Your external signing implementation only needs to:

1. **Receive** a message byte slice.
2. **Hash** it with the appropriate prefix (Fuel SHA-256 or EVM keccak256).
3. **Sign** the 32-byte digest with secp256k1 (ECDSA).
4. **Return** a 64-byte Fuel compact signature.

Use [`fuel_compact_sign`](crate::crypto::fuel_compact_sign) or the lower-level helpers to produce the
correct signature format.

## The `SignableWallet` Trait

The SDK defines a [`SignableWallet`](crate::SignableWallet) trait that both [`Wallet`](crate::Wallet) and
[`EvmWallet`](crate::EvmWallet) implement. You can implement this trait for your own signer type:

```rust,ignore
use o2_sdk::{O2Error, SignableWallet};

pub trait SignableWallet {
    /// The B256 address used as the owner identity.
    fn b256_address(&self) -> &[u8; 32];

    /// Sign a message using the wallet's personal_sign scheme.
    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error>;
}
```

## Fuel-Native External Signer

For Fuel-native accounts, implement [`SignableWallet`](crate::SignableWallet) with your KMS
backend. Use the [`personal_sign`](crate::crypto::personal_sign) function from `o2_sdk::crypto` as a
reference for the expected signing format:

```rust,ignore
use o2_sdk::{O2Error, SignableWallet};
use o2_sdk::crypto::{fuel_compact_sign, parse_hex_32};
use sha2::{Digest, Sha256};

struct KmsSigner {
    b256_address: [u8; 32],
    // ... your KMS client handle
}

impl SignableWallet for KmsSigner {
    fn b256_address(&self) -> &[u8; 32] {
        &self.b256_address
    }

    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error> {
        // Fuel personalSign: prefix + SHA-256
        let prefix = b"\x19Fuel Signed Message:\n";
        let length_str = message.len().to_string();

        let mut hasher = Sha256::new();
        hasher.update(prefix);
        hasher.update(length_str.as_bytes());
        hasher.update(message);
        let digest: [u8; 32] = hasher.finalize().into();

        // Sign the digest with your KMS
        let signature = self.kms_sign(&digest)?;
        Ok(signature)
    }
}
```

Then use it with any `O2Client` method that accepts a wallet:

```rust,ignore
let signer = KmsSigner {
    b256_address: parse_hex_32("0x1234...abcd")?,
    // ...
};

let account = client.setup_account(&signer).await?;
let session = client.create_session(&signer, &["FUEL/USDC"], std::time::Duration::from_secs(30 * 24 * 3600)).await?;
```

> **Important:** Session **actions** (orders, cancels, settlements) are
> signed with the session key — not the external signer. The external
> signer is only needed for session creation and withdrawals.

## EVM External Signer

For EVM-compatible accounts, use the Ethereum signing scheme. The only
difference is the message framing: EVM uses
`\x19Ethereum Signed Message:\n` prefix + keccak256 instead of Fuel's
`\x19Fuel Signed Message:\n` prefix + SHA-256:

```rust,ignore
use o2_sdk::{O2Error, SignableWallet};
use sha3::{Digest, Keccak256};

struct EvmKmsSigner {
    b256_address: [u8; 32],
    evm_address: [u8; 20],
    // ... your KMS client handle
}

impl SignableWallet for EvmKmsSigner {
    fn b256_address(&self) -> &[u8; 32] {
        &self.b256_address
    }

    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error> {
        // EVM personalSign: prefix + keccak256
        let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());

        let mut hasher = Keccak256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(message);
        let digest: [u8; 32] = hasher.finalize().into();

        // Sign the digest with your KMS
        let signature = self.kms_sign(&digest)?;
        Ok(signature)
    }
}
```

## Fuel Compact Signature Format

The SDK expects a 64-byte Fuel compact signature. The recovery ID is
embedded in the MSB of byte 32 (first byte of `s`):

```text
s[0] = (recovery_id << 7) | (s[0] & 0x7F)
```

If your KMS returns standard `(r, s, recovery_id)` components, build the
compact signature manually:

```rust,ignore
fn to_fuel_compact_signature(r: &[u8; 32], s: &[u8; 32], recovery_id: u8) -> [u8; 64] {
    let mut sig = [0u8; 64];
    sig[0..32].copy_from_slice(r);
    sig[32..64].copy_from_slice(s);
    // Embed recovery ID in MSB of s[0]
    sig[32] = (recovery_id << 7) | (sig[32] & 0x7F);
    sig
}
```

> **Warning:** The `s` component **must be low-s normalized** before
> embedding the recovery ID. If `s > secp256k1_order / 2`, negate it
> (`s = order - s`) and flip the recovery ID (`recovery_id ^= 1`).
> Most modern signing libraries do this automatically, but check your
> KMS documentation.

## Using the Built-In Helpers

The SDK exposes the low-level signing primitives if you need them:

```rust,ignore
use o2_sdk::crypto::{fuel_compact_sign, personal_sign, raw_sign, evm_personal_sign};

// Sign a raw 32-byte digest → 64-byte Fuel compact signature
let sig = fuel_compact_sign(&private_key, &digest)?;

// Fuel personalSign (prefix + SHA-256)
let sig = personal_sign(&private_key, &message)?;

// Raw SHA-256 signing (used for session actions)
let sig = raw_sign(&private_key, &message)?;

// EVM personalSign (prefix + keccak256)
let sig = evm_personal_sign(&private_key, &message)?;
```
