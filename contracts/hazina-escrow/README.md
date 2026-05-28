# Hazina Escrow Contract

The Soroban contract now supports:

- A default platform fee plus dataset-specific fee overrides
- Admin-managed whitelist and blacklist controls for buyer and seller addresses
- Invariant-focused verification tests that can be run independently
- Buyer-confirmed release flow and expiry-based seller claims
- `emergency_withdraw` for stuck tokens (admin-only, contract must be paused)

## Emergency withdrawal policy

`emergency_withdraw` is an escape hatch for stuck assets and is intentionally constrained:

- Only the contract admin can call it.
- The contract must be paused first.
- Every withdrawal emits an `emerg_wd` event with `(token, to, amount)`.

## Verification scripts

From the repository root:

```sh
npm run contracts:check
npm run contracts:formal
```

`contracts:check` runs formatting, clippy, the full Rust test suite, and a release wasm build.

`contracts:formal` runs the invariant-oriented tests whose names start with `formal_`.
