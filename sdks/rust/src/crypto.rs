use secp256k1::ecdsa::RecoverableSignature;
/// Cryptographic operations for O2 Exchange: key generation, signing, and address derivation.
///
/// Implements:
/// - Fuel-native key generation (SHA-256 address derivation)
/// - EVM key generation (keccak256 address derivation)
/// - personalSign (Fuel prefix + SHA-256)
/// - rawSign (plain SHA-256)
/// - evm_personal_sign (Ethereum prefix + keccak256)
/// - fuel_compact_sign with low-s normalization and recovery ID in MSB of byte 32
use secp256k1::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest as Sha256Digest, Sha256};
use sha3::Keccak256;

use crate::errors::O2Error;

/// Half of the secp256k1 group order, used for low-s normalization.
const SECP256K1_ORDER_HALF: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

/// Full secp256k1 group order.
const SECP256K1_ORDER: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

/// A Fuel-native wallet with SHA-256 derived B256 address.
#[derive(Debug, Clone)]
pub struct Wallet {
    pub private_key: [u8; 32],
    pub public_key: [u8; 65],
    pub b256_address: [u8; 32],
}

/// An EVM-compatible wallet with keccak256 derived address, zero-padded to B256.
#[derive(Debug, Clone)]
pub struct EvmWallet {
    pub private_key: [u8; 32],
    pub public_key: [u8; 65],
    pub evm_address: [u8; 20],
    pub b256_address: [u8; 32],
}

/// Generate a Fuel-native secp256k1 keypair.
/// Address = SHA-256(uncompressed_pubkey[1..65])
pub fn generate_keypair() -> Result<Wallet, O2Error> {
    let secp = Secp256k1::new();
    let mut rng = rand::thread_rng();
    let (secret_key, public_key) = secp.generate_keypair(&mut rng);

    let pubkey_bytes = public_key.serialize_uncompressed();
    let address = Sha256::digest(&pubkey_bytes[1..65]);

    Ok(Wallet {
        private_key: secret_key.secret_bytes(),
        public_key: pubkey_bytes,
        b256_address: address.into(),
    })
}

/// Generate an EVM-compatible keypair.
/// EVM address = last 20 bytes of keccak256(uncompressed_pubkey[1..65])
/// B256 address = 12 zero bytes + 20 EVM address bytes
pub fn generate_evm_keypair() -> Result<EvmWallet, O2Error> {
    let secp = Secp256k1::new();
    let mut rng = rand::thread_rng();
    let (secret_key, public_key) = secp.generate_keypair(&mut rng);

    let pubkey_bytes = public_key.serialize_uncompressed();
    let keccak_hash = Keccak256::digest(&pubkey_bytes[1..65]);

    let mut evm_address = [0u8; 20];
    evm_address.copy_from_slice(&keccak_hash[12..32]);

    let mut b256_address = [0u8; 32];
    b256_address[12..32].copy_from_slice(&evm_address);

    Ok(EvmWallet {
        private_key: secret_key.secret_bytes(),
        public_key: pubkey_bytes,
        evm_address,
        b256_address,
    })
}

/// Load a Fuel-native wallet from a private key.
pub fn load_wallet(private_key: &[u8; 32]) -> Result<Wallet, O2Error> {
    let secp = Secp256k1::new();
    let secret_key = SecretKey::from_slice(private_key)
        .map_err(|e| O2Error::CryptoError(format!("Invalid private key: {e}")))?;
    let public_key = PublicKey::from_secret_key(&secp, &secret_key);
    let pubkey_bytes = public_key.serialize_uncompressed();
    let address = Sha256::digest(&pubkey_bytes[1..65]);

    Ok(Wallet {
        private_key: *private_key,
        public_key: pubkey_bytes,
        b256_address: address.into(),
    })
}

/// Load an EVM wallet from a private key.
pub fn load_evm_wallet(private_key: &[u8; 32]) -> Result<EvmWallet, O2Error> {
    let secp = Secp256k1::new();
    let secret_key = SecretKey::from_slice(private_key)
        .map_err(|e| O2Error::CryptoError(format!("Invalid private key: {e}")))?;
    let public_key = PublicKey::from_secret_key(&secp, &secret_key);
    let pubkey_bytes = public_key.serialize_uncompressed();
    let keccak_hash = Keccak256::digest(&pubkey_bytes[1..65]);

    let mut evm_address = [0u8; 20];
    evm_address.copy_from_slice(&keccak_hash[12..32]);

    let mut b256_address = [0u8; 32];
    b256_address[12..32].copy_from_slice(&evm_address);

    Ok(EvmWallet {
        private_key: *private_key,
        public_key: pubkey_bytes,
        evm_address,
        b256_address,
    })
}

/// Compare two 32-byte big-endian numbers: returns true if a > b.
fn gt_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] > b[i] {
            return true;
        }
        if a[i] < b[i] {
            return false;
        }
    }
    false
}

/// Negate a 32-byte big-endian number modulo the secp256k1 order.
/// result = ORDER - value
fn negate_s(s: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut borrow: u16 = 0;
    for i in (0..32).rev() {
        let diff = SECP256K1_ORDER[i] as u16 - s[i] as u16 - borrow;
        result[i] = diff as u8;
        borrow = if diff > 255 { 1 } else { 0 };
    }
    result
}

/// Sign a 32-byte digest and return a 64-byte Fuel compact signature.
///
/// The recovery ID is embedded in the MSB of byte 32 (first byte of s).
/// Low-s normalization is applied: if s > order/2, negate s and flip recovery_id.
pub fn fuel_compact_sign(private_key: &[u8; 32], digest: &[u8; 32]) -> Result<[u8; 64], O2Error> {
    let secp = Secp256k1::new();
    let secret_key = SecretKey::from_slice(private_key)
        .map_err(|e| O2Error::CryptoError(format!("Invalid private key: {e}")))?;
    let message = Message::from_digest(*digest);

    let recoverable_sig: RecoverableSignature = secp.sign_ecdsa_recoverable(&message, &secret_key);
    let (rec_id, compact) = recoverable_sig.serialize_compact();
    let mut recovery_id = rec_id.to_i32() as u8;

    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&compact[0..32]);
    s.copy_from_slice(&compact[32..64]);

    // Low-s normalization
    if gt_be(&s, &SECP256K1_ORDER_HALF) {
        s = negate_s(&s);
        recovery_id ^= 1;
    }

    // Embed recovery ID in MSB of s[0]
    s[0] = (recovery_id << 7) | (s[0] & 0x7F);

    let mut result = [0u8; 64];
    result[0..32].copy_from_slice(&r);
    result[32..64].copy_from_slice(&s);
    Ok(result)
}

/// Sign using Fuel's personalSign format (for session creation).
/// prefix = b"\x19Fuel Signed Message:\n" + str(len(message)) + message
/// digest = sha256(prefix)
pub fn personal_sign(private_key: &[u8; 32], message: &[u8]) -> Result<[u8; 64], O2Error> {
    let prefix = b"\x19Fuel Signed Message:\n";
    let length_str = message.len().to_string();

    let mut hasher = Sha256::new();
    hasher.update(prefix);
    hasher.update(length_str.as_bytes());
    hasher.update(message);
    let digest: [u8; 32] = hasher.finalize().into();

    fuel_compact_sign(private_key, &digest)
}

/// Sign using raw SHA-256 hash, no prefix (for session actions).
/// digest = sha256(message)
pub fn raw_sign(private_key: &[u8; 32], message: &[u8]) -> Result<[u8; 64], O2Error> {
    let digest: [u8; 32] = Sha256::digest(message).into();
    fuel_compact_sign(private_key, &digest)
}

/// Sign using Ethereum's personal_sign format (for EVM owner session creation).
/// prefix = "\x19Ethereum Signed Message:\n" + str(len(message))
/// digest = keccak256(prefix_bytes + message)
pub fn evm_personal_sign(private_key: &[u8; 32], message: &[u8]) -> Result<[u8; 64], O2Error> {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());

    let mut hasher = Keccak256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(message);
    let digest: [u8; 32] = hasher.finalize().into();

    fuel_compact_sign(private_key, &digest)
}

/// Trait for wallets that can sign messages for O2 Exchange operations.
///
/// Implemented for both [`Wallet`] (Fuel-native, SHA-256) and [`EvmWallet`] (keccak256).
pub trait SignableWallet {
    /// The B256 address used as the owner identity.
    fn b256_address(&self) -> &[u8; 32];
    /// Sign a message using the wallet's personal_sign scheme.
    ///
    /// - Fuel wallets use `\x19Fuel Signed Message:\n` prefix + SHA-256.
    /// - EVM wallets use `\x19Ethereum Signed Message:\n` prefix + keccak256.
    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error>;
}

impl SignableWallet for Wallet {
    fn b256_address(&self) -> &[u8; 32] {
        &self.b256_address
    }
    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error> {
        personal_sign(&self.private_key, message)
    }
}

impl SignableWallet for EvmWallet {
    fn b256_address(&self) -> &[u8; 32] {
        &self.b256_address
    }
    fn personal_sign(&self, message: &[u8]) -> Result<[u8; 64], O2Error> {
        evm_personal_sign(&self.private_key, message)
    }
}

/// Derive a Fuel B256 address from a public key (65 bytes, 0x04 prefix).
pub fn address_from_pubkey(public_key: &[u8; 65]) -> [u8; 32] {
    Sha256::digest(&public_key[1..65]).into()
}

/// Derive an EVM address from a public key (65 bytes, 0x04 prefix).
pub fn evm_address_from_pubkey(public_key: &[u8; 65]) -> [u8; 20] {
    let hash = Keccak256::digest(&public_key[1..65]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    addr
}

/// Format a 32-byte array as a "0x"-prefixed hex string.
pub fn to_hex_string(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Parse a "0x"-prefixed hex string into a 32-byte array.
pub fn parse_hex_32(s: &str) -> Result<[u8; 32], O2Error> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).map_err(|e| O2Error::CryptoError(format!("Invalid hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(O2Error::CryptoError(format!(
            "Expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&bytes);
    Ok(result)
}
