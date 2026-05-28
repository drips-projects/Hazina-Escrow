import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { HORIZON_URL, USDC_ISSUER } from '../lib/stellar.config';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const stellarBreaker = getCircuitBreaker('stellar-horizon', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000, // 60 s
});

// Configurable via env; read per-call so tests can override it after module load
const getStellarTimeoutMs = () => parseInt(process.env.STELLAR_TIMEOUT_MS ?? '10000', 10);

interface VerifyParams {
  txHash: string;
  expectedAmount: number;
  destinationAddress: string;
}

interface VerifyResult {
  valid: boolean;
  reason?: string;
  actualAmount?: number;
  memo?: string;
}

/**
 * Runs `fn` with a hard deadline of `timeoutMs` milliseconds.
 * Throws a user-friendly StellarTimeoutError if the deadline is exceeded.
 */
async function withStellarTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new StellarTimeoutError(timeoutMs));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class StellarTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Stellar Horizon did not respond within ${timeoutMs / 1000} seconds. ` +
        'The payment network may be congested — please try again shortly.',
    );
    this.name = 'StellarTimeoutError';
  }
}

async function withHorizonRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const is404 =
        err &&
        typeof err === 'object' &&
        'response' in err &&
        (err as { response?: { status?: number } }).response?.status === 404;
      if (is404 && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1_000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

export async function verifyStellarPayment(params: VerifyParams): Promise<VerifyResult> {
  const { txHash, expectedAmount, destinationAddress } = params;

  try {
    const [tx, ops] = await withStellarTimeout(
      () =>
        withHorizonRetry(() =>
          stellarBreaker.execute(() =>
            Promise.all([
              server.transactions().transaction(txHash).call(),
              server.operations().forTransaction(txHash).call(),
            ]),
          ),
        ),
      getStellarTimeoutMs(),
    );

    const paymentOps = ops.records.filter(
      op =>
        op.type === 'payment' &&
        (op as StellarSdk.Horizon.ServerApi.PaymentOperationRecord).to === destinationAddress,
    );

    if (paymentOps.length === 0) {
      return { valid: false, reason: 'No payment to escrow address found in transaction' };
    }

    // Find USDC payment — must match both asset code and issuer to prevent XLM/fake-USDC substitution
    const usdcOps = paymentOps.filter(op => {
      const payOp = op as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;
      return payOp.asset_code === 'USDC' && payOp.asset_issuer === USDC_ISSUER;
    });

    if (usdcOps.length === 0) {
      return {
        valid: false,
        reason: 'No USDC payment found — ensure you sent USDC on Stellar testnet',
      };
    }

    const payOp = usdcOps[0] as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;
    const actualAmount = parseFloat(payOp.amount);
    const tolerance = 0.001; // 0.001 USDC tolerance

    if (Math.abs(actualAmount - expectedAmount) > tolerance) {
      return {
        valid: false,
        reason: `Amount mismatch: expected ${expectedAmount} USDC, received ${actualAmount} USDC`,
        actualAmount,
      };
    }

    // Check not too old (5 minute window)
    const txTime = new Date(tx.created_at).getTime();
    const now = Date.now();
    if (now - txTime > 300_000) {
      return { valid: false, reason: 'Transaction expired (older than 5 minutes)' };
    }

    return {
      valid: true,
      actualAmount,
      memo: tx.memo || '',
    };
  } catch (err: unknown) {
    if (err instanceof StellarTimeoutError) {
      throw err; // propagate the user-friendly timeout error as-is
    }
    if (err && typeof err === 'object' && 'response' in err) {
      const httpErr = err as { response?: { status?: number } };
      if (httpErr.response?.status === 404) {
        return { valid: false, reason: 'Transaction not found on Stellar testnet' };
      }
    }
    throw err;
  }
}
