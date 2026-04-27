# Hazina Escrow Contract

The Soroban contract now supports:

- A default platform fee plus dataset-specific fee overrides
- Admin-managed whitelist and blacklist controls for buyer and seller addresses
- An admin-controlled pause/unpause circuit breaker for emergencies
- Invariant-focused verification tests that can be run independently

## Verification scripts

From the repository root:

```sh
npm run contracts:check
npm run contracts:formal
```

`contracts:check` runs formatting, clippy, the full Rust test suite, and a release wasm build.

`contracts:formal` runs the invariant-oriented tests whose names start with `formal_`.

## Integration Tests (Stellar Testnet)

These tests run against the real Stellar testnet. They are ignored by default.

### Setup

1.  **Fund accounts**: Create and fund three accounts on testnet (Admin, Buyer, Seller). You can use the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator).
2.  **USDC Trustlines**: Ensure the Buyer and Seller accounts have trustlines for USDC on testnet (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`).
3.  **Fund Buyer with USDC**: Send some testnet USDC to the Buyer account.
4.  **Configure Env**: Copy `contracts/hazina-escrow/.env.test` and fill in the real secrets and contract ID.

### Running

From `contracts/hazina-escrow`:

```sh
cargo test -- --ignored
```

Or specific test:

```sh
cargo test integration_lock_and_release -- --ignored
```

