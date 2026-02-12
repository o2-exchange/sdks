Changelog
=========

v0.1.0 (2026-02-11)
--------------------

Initial release.

- :class:`~o2_sdk.client.O2Client` high-level trading client.
- Fuel-native and EVM wallet support
  (:class:`~o2_sdk.crypto.Wallet`,
  :class:`~o2_sdk.crypto.EvmWallet`).
- External signer support for KMS/HSM integration
  (:class:`~o2_sdk.crypto.ExternalSigner`,
  :class:`~o2_sdk.crypto.ExternalEvmSigner`).
- Full REST API coverage via :class:`~o2_sdk.api.O2Api`.
- Real-time WebSocket streaming (depth, orders, trades, balances,
  nonce).
- Automatic price/quantity scaling, nonce management, and rate-limit
  retries.
- Typed error hierarchy with 25+ specific exception classes.
