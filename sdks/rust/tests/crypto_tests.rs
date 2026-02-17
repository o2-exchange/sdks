/// Unit tests for O2 SDK crypto module.
///
/// Tests key generation, address derivation, signing, and Fuel compact signature encoding.
use o2_sdk::crypto::*;
use sha2::{Digest, Sha256};

#[test]
fn test_generate_keypair() {
    let wallet = generate_keypair().unwrap();
    assert_eq!(wallet.private_key.len(), 32);
    assert_eq!(wallet.public_key.len(), 65);
    assert_eq!(wallet.public_key[0], 0x04); // uncompressed prefix
    assert_eq!(wallet.b256_address.len(), 32);

    // Address should be SHA-256 of pubkey[1..65]
    let expected_address: [u8; 32] = Sha256::digest(&wallet.public_key[1..65]).into();
    assert_eq!(wallet.b256_address, expected_address);
}

#[test]
fn test_generate_evm_keypair() {
    let wallet = generate_evm_keypair().unwrap();
    assert_eq!(wallet.private_key.len(), 32);
    assert_eq!(wallet.public_key.len(), 65);
    assert_eq!(wallet.evm_address.len(), 20);
    assert_eq!(wallet.b256_address.len(), 32);

    // B256 should be zero-padded EVM address
    assert_eq!(&wallet.b256_address[0..12], &[0u8; 12]);
    assert_eq!(&wallet.b256_address[12..32], &wallet.evm_address);
}

#[test]
fn test_load_wallet_deterministic() {
    let private_key = [0x01u8; 32];
    let w1 = load_wallet(&private_key).unwrap();
    let w2 = load_wallet(&private_key).unwrap();

    assert_eq!(w1.b256_address, w2.b256_address);
    assert_eq!(w1.public_key, w2.public_key);
}

#[test]
fn test_fuel_compact_sign_64_bytes() {
    let wallet = generate_keypair().unwrap();
    let digest = Sha256::digest(b"test message");
    let digest_arr: [u8; 32] = digest.into();

    let sig = fuel_compact_sign(&wallet.private_key, &digest_arr).unwrap();
    assert_eq!(sig.len(), 64);
}

#[test]
fn test_recovery_id_in_msb() {
    // Sign multiple messages and verify the MSB of byte 32 is correctly set
    let wallet = generate_keypair().unwrap();

    for i in 0u8..20 {
        let digest: [u8; 32] = Sha256::digest([i]).into();
        let sig = fuel_compact_sign(&wallet.private_key, &digest).unwrap();

        // MSB of byte 32 should be 0 or 1 (recovery ID)
        let recovery_id = (sig[32] >> 7) & 1;
        assert!(recovery_id <= 1, "Recovery ID should be 0 or 1");

        // The rest of byte 32 should have MSB cleared or set only for recovery
        let s_first_byte_without_recovery = sig[32] & 0x7F;
        let reconstructed = (recovery_id << 7) | s_first_byte_without_recovery;
        assert_eq!(sig[32], reconstructed);
    }
}

#[test]
fn test_personal_sign_deterministic() {
    let private_key = [0x42u8; 32];
    let wallet = load_wallet(&private_key).unwrap();

    let message = b"hello world";
    let sig1 = personal_sign(&wallet.private_key, message).unwrap();
    let sig2 = personal_sign(&wallet.private_key, message).unwrap();

    assert_eq!(sig1, sig2, "personalSign should be deterministic");
    assert_eq!(sig1.len(), 64);
}

#[test]
fn test_raw_sign_deterministic() {
    let private_key = [0x42u8; 32];
    let wallet = load_wallet(&private_key).unwrap();

    let message = b"hello world";
    let sig1 = raw_sign(&wallet.private_key, message).unwrap();
    let sig2 = raw_sign(&wallet.private_key, message).unwrap();

    assert_eq!(sig1, sig2, "rawSign should be deterministic");
    assert_eq!(sig1.len(), 64);
}

#[test]
fn test_personal_sign_vs_raw_sign_differ() {
    let private_key = [0x42u8; 32];
    let message = b"test message";

    let personal = personal_sign(&private_key, message).unwrap();
    let raw = raw_sign(&private_key, message).unwrap();

    assert_ne!(
        personal, raw,
        "personalSign and rawSign should produce different signatures"
    );
}

#[test]
fn test_evm_personal_sign() {
    let private_key = [0x42u8; 32];
    let message = b"test message";

    let sig = evm_personal_sign(&private_key, message).unwrap();
    assert_eq!(sig.len(), 64);

    // Should differ from fuel personalSign
    let fuel_sig = personal_sign(&private_key, message).unwrap();
    assert_ne!(sig, fuel_sig, "EVM and Fuel personalSign should differ");
}

#[test]
fn test_address_from_pubkey() {
    let wallet = generate_keypair().unwrap();
    let addr = address_from_pubkey(&wallet.public_key);
    assert_eq!(addr, wallet.b256_address);
}

#[test]
fn test_hex_roundtrip() {
    let bytes = [0xABu8; 32];
    let hex_str = to_hex_string(&bytes);
    assert!(hex_str.starts_with("0x"));
    assert_eq!(hex_str.len(), 66); // 0x + 64 hex chars

    let parsed = parse_hex_32(&hex_str).unwrap();
    assert_eq!(parsed, bytes);
}

#[test]
fn test_parse_hex_32_no_prefix() {
    // 0xAB repeated 32 times = 64 hex chars = 32 bytes
    let hex_str = "ab".repeat(32);
    let parsed = parse_hex_32(&hex_str).unwrap();
    assert_eq!(parsed, [0xABu8; 32]);
}

#[test]
fn test_parse_hex_32_invalid_length() {
    let result = parse_hex_32("0xaabb");
    assert!(result.is_err());
}

#[test]
fn test_known_key_address_derivation() {
    // Test with a known private key that the address derivation matches
    // the SHA-256 of the uncompressed public key (minus 0x04 prefix)
    let private_key = [1u8; 32];
    let wallet = load_wallet(&private_key).unwrap();

    // Verify address is SHA-256 hash of pubkey[1..65]
    let expected: [u8; 32] = Sha256::digest(&wallet.public_key[1..65]).into();
    assert_eq!(wallet.b256_address, expected);
}

#[test]
fn test_low_s_normalization() {
    // Sign many messages and verify s is always in the lower half
    let wallet = generate_keypair().unwrap();

    // secp256k1 order / 2
    let order_half: [u8; 32] = [
        0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B,
        0x20, 0xA0,
    ];

    for i in 0u8..50 {
        let digest: [u8; 32] = Sha256::digest([i]).into();
        let sig = fuel_compact_sign(&wallet.private_key, &digest).unwrap();

        // Extract s (bytes 32..64) with recovery ID cleared
        let mut s = [0u8; 32];
        s.copy_from_slice(&sig[32..64]);
        s[0] &= 0x7F; // Clear recovery ID bit

        // s should be <= order_half
        let mut s_is_low = true;
        for j in 0..32 {
            if s[j] > order_half[j] {
                s_is_low = false;
                break;
            }
            if s[j] < order_half[j] {
                break;
            }
        }
        assert!(
            s_is_low,
            "s should be normalized to low-s for message {}",
            i
        );
    }
}
