"""Unit tests for the crypto module using known test vectors."""

import hashlib

from coincurve import PrivateKey

from o2_sdk.crypto import (
    ExternalEvmSigner,
    ExternalSigner,
    Signer,
    evm_personal_sign,
    fuel_compact_sign,
    generate_evm_wallet,
    generate_keypair,
    generate_wallet,
    load_evm_wallet,
    load_wallet,
    personal_sign,
    raw_sign,
    to_fuel_compact_signature,
)

# Known test private key for deterministic tests
TEST_PRIVATE_KEY_HEX = "a" * 64
TEST_PRIVATE_KEY = bytes.fromhex(TEST_PRIVATE_KEY_HEX)


class TestKeyGeneration:
    def test_generate_keypair(self):
        priv_hex, pub_key, address = generate_keypair()
        assert len(bytes.fromhex(priv_hex)) == 32
        assert len(pub_key) == 65
        assert pub_key[0] == 0x04
        assert address.startswith("0x")
        assert len(address) == 66  # 0x + 64 hex chars

    def test_generate_wallet(self):
        wallet = generate_wallet()
        assert len(wallet.private_key) == 32
        assert len(wallet.public_key) == 65
        assert wallet.b256_address.startswith("0x")
        assert len(wallet.address_bytes) == 32

    def test_load_wallet_deterministic(self):
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        pk = PrivateKey(TEST_PRIVATE_KEY)
        pub = pk.public_key.format(compressed=False)
        expected_address = "0x" + hashlib.sha256(pub[1:]).hexdigest()
        assert wallet.b256_address == expected_address
        assert wallet.private_key == TEST_PRIVATE_KEY

    def test_evm_wallet(self):
        wallet = generate_evm_wallet()
        assert wallet.b256_address.startswith("0x000000000000000000000000")
        assert len(wallet.evm_address) == 42  # 0x + 40 hex chars
        evm_part = wallet.b256_address[26:]  # strip 0x + 24 zeros
        assert evm_part == wallet.evm_address[2:]

    def test_load_evm_wallet_deterministic(self):
        wallet = load_evm_wallet(TEST_PRIVATE_KEY_HEX)
        assert wallet.b256_address.startswith("0x000000000000000000000000")
        assert wallet.private_key == TEST_PRIVATE_KEY

    def test_fuel_vs_evm_address_different(self):
        fuel = load_wallet(TEST_PRIVATE_KEY_HEX)
        evm = load_evm_wallet(TEST_PRIVATE_KEY_HEX)
        assert fuel.b256_address != evm.b256_address


class TestFuelCompactSign:
    def test_signature_length(self):
        digest = hashlib.sha256(b"test message").digest()
        sig = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        assert len(sig) == 64

    def test_recovery_id_in_msb(self):
        digest = hashlib.sha256(b"test message for recovery").digest()
        sig = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        # Recovery ID should be in the MSB of byte 32 (first byte of s)
        recovery_id = (sig[32] >> 7) & 1
        assert recovery_id in (0, 1)

    def test_deterministic_signature(self):
        digest = hashlib.sha256(b"deterministic test").digest()
        sig1 = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        sig2 = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        assert sig1 == sig2

    def test_low_s_normalization(self):
        """Verify that s values are in the lower half of the curve order."""
        SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
        half_order = SECP256K1_ORDER // 2

        for i in range(20):
            digest = hashlib.sha256(f"low-s test {i}".encode()).digest()
            sig = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
            # Extract s (bytes 32-63), but first clear the recovery ID bit
            s_bytes = bytearray(sig[32:64])
            s_bytes[0] = s_bytes[0] & 0x7F
            s = int.from_bytes(s_bytes, "big")
            assert s <= half_order, f"s value not normalized at iteration {i}"


class TestPersonalSign:
    def test_personal_sign_length(self):
        sig = personal_sign(TEST_PRIVATE_KEY, b"hello world")
        assert len(sig) == 64

    def test_personal_sign_deterministic(self):
        sig1 = personal_sign(TEST_PRIVATE_KEY, b"hello")
        sig2 = personal_sign(TEST_PRIVATE_KEY, b"hello")
        assert sig1 == sig2

    def test_personal_sign_different_messages(self):
        sig1 = personal_sign(TEST_PRIVATE_KEY, b"message1")
        sig2 = personal_sign(TEST_PRIVATE_KEY, b"message2")
        assert sig1 != sig2

    def test_personal_sign_prefix_applied(self):
        """Verify personalSign uses the Fuel prefix."""
        msg = b"test"
        # Manual computation of what personal_sign should produce
        prefix = b"\x19Fuel Signed Message:\n"
        length_str = str(len(msg)).encode("utf-8")
        full_message = prefix + length_str + msg
        digest = hashlib.sha256(full_message).digest()
        expected = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        actual = personal_sign(TEST_PRIVATE_KEY, msg)
        assert actual == expected


class TestRawSign:
    def test_raw_sign_length(self):
        sig = raw_sign(TEST_PRIVATE_KEY, b"hello world")
        assert len(sig) == 64

    def test_raw_sign_deterministic(self):
        sig1 = raw_sign(TEST_PRIVATE_KEY, b"hello")
        sig2 = raw_sign(TEST_PRIVATE_KEY, b"hello")
        assert sig1 == sig2

    def test_raw_sign_is_sha256_then_sign(self):
        """Verify rawSign is sha256(message) then fuel_compact_sign."""
        msg = b"test raw sign"
        digest = hashlib.sha256(msg).digest()
        expected = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        actual = raw_sign(TEST_PRIVATE_KEY, msg)
        assert actual == expected

    def test_personal_sign_vs_raw_sign_differ(self):
        """personalSign and rawSign should produce different signatures for the same message."""
        msg = b"same message"
        sig_personal = personal_sign(TEST_PRIVATE_KEY, msg)
        sig_raw = raw_sign(TEST_PRIVATE_KEY, msg)
        assert sig_personal != sig_raw


class TestEvmPersonalSign:
    def test_evm_personal_sign_length(self):
        sig = evm_personal_sign(TEST_PRIVATE_KEY, b"hello")
        assert len(sig) == 64

    def test_evm_personal_sign_uses_keccak(self):
        """Verify evm_personal_sign uses Ethereum prefix + keccak256."""
        from Crypto.Hash import keccak

        msg = b"test"
        prefix = f"\x19Ethereum Signed Message:\n{len(msg)}".encode()
        k = keccak.new(digest_bits=256)
        k.update(prefix + msg)
        digest = k.digest()
        expected = fuel_compact_sign(TEST_PRIVATE_KEY, digest)
        actual = evm_personal_sign(TEST_PRIVATE_KEY, msg)
        assert actual == expected

    def test_evm_vs_fuel_personal_sign_differ(self):
        """EVM and Fuel personal_sign produce different signatures."""
        msg = b"same message"
        fuel_sig = personal_sign(TEST_PRIVATE_KEY, msg)
        evm_sig = evm_personal_sign(TEST_PRIVATE_KEY, msg)
        assert fuel_sig != evm_sig


class TestToFuelCompactSignature:
    def test_roundtrip(self):
        """to_fuel_compact_signature matches fuel_compact_sign output."""
        digest = hashlib.sha256(b"roundtrip test").digest()
        # Sign with fuel_compact_sign to get reference output
        expected = fuel_compact_sign(TEST_PRIVATE_KEY, digest)

        # Manually sign to get (r, s, recovery_id) components
        pk = PrivateKey(TEST_PRIVATE_KEY)
        sig = pk.sign_recoverable(digest, hasher=None)
        r = sig[0:32]
        s = sig[32:64]
        recovery_id = sig[64]

        result = to_fuel_compact_signature(r, s, recovery_id)
        assert result == expected

    def test_invalid_r_length(self):
        import pytest

        with pytest.raises(ValueError, match="r must be 32 bytes"):
            to_fuel_compact_signature(b"\x00" * 31, b"\x00" * 32, 0)

    def test_invalid_s_length(self):
        import pytest

        with pytest.raises(ValueError, match="s must be 32 bytes"):
            to_fuel_compact_signature(b"\x00" * 32, b"\x00" * 33, 0)

    def test_invalid_recovery_id(self):
        import pytest

        with pytest.raises(ValueError, match="recovery_id must be 0 or 1"):
            to_fuel_compact_signature(b"\x00" * 32, b"\x00" * 32, 2)


class TestWalletPersonalSign:
    """Test Wallet.personal_sign method matches module-level personal_sign."""

    def test_matches_module_function(self):
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        msg = b"test personal sign method"
        expected = personal_sign(TEST_PRIVATE_KEY, msg)
        assert wallet.personal_sign(msg) == expected

    def test_deterministic(self):
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        msg = b"deterministic"
        assert wallet.personal_sign(msg) == wallet.personal_sign(msg)

    def test_different_messages_differ(self):
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        sig1 = wallet.personal_sign(b"message1")
        sig2 = wallet.personal_sign(b"message2")
        assert sig1 != sig2


class TestEvmWalletPersonalSign:
    """Test EvmWallet.personal_sign method matches module-level evm_personal_sign."""

    def test_matches_module_function(self):
        wallet = load_evm_wallet(TEST_PRIVATE_KEY_HEX)
        msg = b"test evm personal sign method"
        expected = evm_personal_sign(TEST_PRIVATE_KEY, msg)
        assert wallet.personal_sign(msg) == expected

    def test_fuel_vs_evm_differ(self):
        """Wallet.personal_sign and EvmWallet.personal_sign produce different results."""
        fuel_wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        evm_wallet = load_evm_wallet(TEST_PRIVATE_KEY_HEX)
        msg = b"same message"
        assert fuel_wallet.personal_sign(msg) != evm_wallet.personal_sign(msg)


class TestSignerProtocol:
    """Test that Wallet and EvmWallet satisfy the Signer protocol."""

    def test_wallet_is_signer(self):
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)
        assert isinstance(wallet, Signer)

    def test_evm_wallet_is_signer(self):
        wallet = load_evm_wallet(TEST_PRIVATE_KEY_HEX)
        assert isinstance(wallet, Signer)

    def test_external_signer_is_signer(self):
        signer = ExternalSigner(
            b256_address="0x" + "ab" * 32,
            sign_digest=lambda digest: b"\x00" * 64,
        )
        assert isinstance(signer, Signer)

    def test_external_evm_signer_is_signer(self):
        signer = ExternalEvmSigner(
            b256_address="0x" + "ab" * 32,
            evm_address="0x" + "cd" * 20,
            sign_digest=lambda digest: b"\x00" * 64,
        )
        assert isinstance(signer, Signer)


class TestExternalSigner:
    """Test ExternalSigner with fuel_compact_sign as the backing function."""

    def test_matches_wallet(self):
        """ExternalSigner using fuel_compact_sign should match Wallet.personal_sign."""
        wallet = load_wallet(TEST_PRIVATE_KEY_HEX)

        def local_sign(digest: bytes) -> bytes:
            return fuel_compact_sign(TEST_PRIVATE_KEY, digest)

        signer = ExternalSigner(
            b256_address=wallet.b256_address,
            sign_digest=local_sign,
        )

        msg = b"test external signer"
        assert signer.personal_sign(msg) == wallet.personal_sign(msg)

    def test_b256_address(self):
        addr = "0x" + "ab" * 32
        signer = ExternalSigner(b256_address=addr, sign_digest=lambda d: b"\x00" * 64)
        assert signer.b256_address == addr

    def test_address_bytes(self):
        addr = "0x" + "ab" * 32
        signer = ExternalSigner(b256_address=addr, sign_digest=lambda d: b"\x00" * 64)
        assert signer.address_bytes == bytes.fromhex("ab" * 32)

    def test_callback_receives_correct_digest(self):
        """Verify that the sign_digest callback receives the correct SHA-256 digest."""
        received_digests: list[bytes] = []

        def capture_digest(digest: bytes) -> bytes:
            received_digests.append(digest)
            return b"\x00" * 64

        signer = ExternalSigner(
            b256_address="0x" + "00" * 32,
            sign_digest=capture_digest,
        )

        msg = b"hello"
        signer.personal_sign(msg)

        # Manually compute expected digest
        prefix = b"\x19Fuel Signed Message:\n"
        length_str = str(len(msg)).encode("utf-8")
        full_message = prefix + length_str + msg
        expected_digest = hashlib.sha256(full_message).digest()

        assert len(received_digests) == 1
        assert received_digests[0] == expected_digest


class TestExternalEvmSigner:
    """Test ExternalEvmSigner with fuel_compact_sign as the backing function."""

    def test_matches_evm_wallet(self):
        """ExternalEvmSigner using fuel_compact_sign should match EvmWallet.personal_sign."""
        wallet = load_evm_wallet(TEST_PRIVATE_KEY_HEX)

        def local_sign(digest: bytes) -> bytes:
            return fuel_compact_sign(TEST_PRIVATE_KEY, digest)

        signer = ExternalEvmSigner(
            b256_address=wallet.b256_address,
            evm_address=wallet.evm_address,
            sign_digest=local_sign,
        )

        msg = b"test external evm signer"
        assert signer.personal_sign(msg) == wallet.personal_sign(msg)

    def test_evm_address(self):
        evm_addr = "0x" + "cd" * 20
        signer = ExternalEvmSigner(
            b256_address="0x" + "00" * 32,
            evm_address=evm_addr,
            sign_digest=lambda d: b"\x00" * 64,
        )
        assert signer.evm_address == evm_addr

    def test_callback_receives_keccak_digest(self):
        """Verify that the sign_digest callback receives a keccak256 digest."""
        from Crypto.Hash import keccak

        received_digests: list[bytes] = []

        def capture_digest(digest: bytes) -> bytes:
            received_digests.append(digest)
            return b"\x00" * 64

        signer = ExternalEvmSigner(
            b256_address="0x" + "00" * 32,
            evm_address="0x" + "00" * 20,
            sign_digest=capture_digest,
        )

        msg = b"hello"
        signer.personal_sign(msg)

        # Manually compute expected keccak256 digest
        prefix = f"\x19Ethereum Signed Message:\n{len(msg)}".encode()
        k = keccak.new(digest_bits=256)
        k.update(prefix + msg)
        expected_digest = k.digest()

        assert len(received_digests) == 1
        assert received_digests[0] == expected_digest
