/**
 * constants.ts — Issue #273
 *
 * Platform fee configuration. Driven by the `PLATFORM_FEE_RATE` environment
 * variable so the split can be tuned without a code change. Validated at
 * module load: throws if the value is outside [0, 1].
 */

const RAW_RATE = process.env.PLATFORM_FEE_RATE ?? '0.05';
const PARSED_RATE = parseFloat(RAW_RATE);

if (!Number.isFinite(PARSED_RATE) || PARSED_RATE < 0 || PARSED_RATE > 1) {
  throw new Error(
    `PLATFORM_FEE_RATE must be a number in [0, 1], got "${RAW_RATE}"`,
  );
}

/** Fraction of every payment that the platform keeps (default 5 %). */
export const PLATFORM_FEE_RATE = PARSED_RATE;

/** Fraction of every payment that goes to the seller (default 95 %). */
export const SELLER_PAYOUT_RATE = 1 - PLATFORM_FEE_RATE;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Compute the seller's share of `pricePerQuery`, rounded to 7 decimals. */
export function sellerShare(pricePerQuery: number): number {
  return parseFloat((pricePerQuery * SELLER_PAYOUT_RATE).toFixed(7));
}

/** Compute the platform fee from `pricePerQuery`, rounded to 4 decimals. */
export function platformFee(pricePerQuery: number): number {
  return parseFloat((pricePerQuery * PLATFORM_FEE_RATE).toFixed(4));
}
