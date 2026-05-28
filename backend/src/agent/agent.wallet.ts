import * as StellarSdk from '@stellar/stellar-sdk';
import { HORIZON_URL, SOROBAN_RPC_URL, USDC_ISSUER, getNetworkPassphrase } from '../lib/stellar.config';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const CONTRACT_CALL_TIMEOUT_MS = 30_000;

// SECURITY: The raw value of AGENT_WALLET_SECRET must NEVER appear in any log,
// error message, or exception payload shipped to Datadog or Sentry.
// Always derive and log the public key instead.

export interface SendPaymentParams {
  destinationAddress: string;
  amount: string; // string to match Stellar SDK precision
  memo?: string;
}

export interface SendPaymentResult {
  txHash: string;
  from: string;
  to: string;
  amount: string;
}

/**
 * Sends USDC from the agent's own wallet to a data seller.
 * Requires AGENT_WALLET_SECRET in env.
 */
export async function sendUsdcPayment(params: SendPaymentParams): Promise<SendPaymentResult> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) {
    throw new Error('AGENT_WALLET_SECRET not configured — agent cannot send payments');
  }

  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());

  const usdcBal = account.balances.find(b => {
    if (b.asset_type === 'native') return false;
    const bal = b as { asset_code: string; asset_issuer: string };
    return bal.asset_code === 'USDC' && bal.asset_issuer === USDC_ISSUER;
  }) as { balance: string } | undefined;

  if (!usdcBal) {
    throw new Error('Agent wallet has no USDC trustline — cannot send payment');
  }
  if (parseFloat(usdcBal.balance) < parseFloat(params.amount)) {
    throw new Error(
      `Insufficient USDC balance: need ${params.amount} USDC, have ${usdcBal.balance} USDC`,
    );
  }

  const usdc = new StellarSdk.Asset('USDC', USDC_ISSUER);

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: params.destinationAddress,
      asset: usdc,
      amount: params.amount,
    })
  );

  if (params.memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(params.memo.slice(0, 28))); // Stellar memo max 28 bytes
  }

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);
  return {
    txHash: result.hash,
    from: keypair.publicKey(),
    to: params.destinationAddress,
    amount: params.amount,
  };
}

/**
 * Invokes a Soroban contract function as admin (AGENT_WALLET_SECRET).
 * Simulates, assembles auth, signs, submits, and polls for confirmation.
 * Returns the confirmed transaction hash.
 */
export async function callContract(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) throw new Error('AGENT_WALLET_SECRET not configured');

  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const contract = new StellarSdk.Contract(contractId);

  const account = await rpc.getAccount(keypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    throw new Error(`Contract simulation failed for ${method}: ${JSON.stringify(simResult)}`);
  }

  const assembled = StellarSdk.rpc.assembleTransaction(tx, simResult).build();
  assembled.sign(keypair);

  const sendResult = await rpc.sendTransaction(assembled);
  if (sendResult.status === 'ERROR') {
    throw new Error(`Contract submit error for ${method}: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const txHash = sendResult.hash;
  const deadline = Date.now() + CONTRACT_CALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const txResult = await rpc.getTransaction(txHash);
    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) return txHash;
    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Contract call ${method} failed on-chain`);
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error(`Contract call ${method} timed out after ${CONTRACT_CALL_TIMEOUT_MS}ms`);
}

// SECURITY: returns only the derived PUBLIC key — the raw secret is never exposed.
export function getAgentPublicKey(): string | null {
  const rawSecret = process.env.AGENT_WALLET_SECRET;
  if (!rawSecret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(rawSecret).publicKey();
  } catch {
    // Do NOT log the exception message here — it may echo key material.
    return null;
  }
}

/**
 * Call once at application startup to verify the agent wallet is properly
 * configured. Logs ONLY the derived public key — never the secret.
 * Throws if the secret is absent or malformed.
 */
export function validateAgentWallet(): void {
  const rawSecret = process.env.AGENT_WALLET_SECRET;

  if (!rawSecret) {
    throw new Error(
      '[AgentWallet] AGENT_WALLET_SECRET is not set. ' +
      'The agent wallet cannot sign transactions.',
    );
  }

  let publicKey: string;
  try {
    // Only the derived public key is ever passed to the logger — not the secret.
    publicKey = StellarSdk.Keypair.fromSecret(rawSecret).publicKey();
  } catch {
    // Do NOT include the caught error in this throw — it may echo key material.
    throw new Error(
      '[AgentWallet] AGENT_WALLET_SECRET is set but is not a valid Stellar secret key. ' +
      'Check the value in your environment configuration.',
    );
  }

  // Safe to log — publicKey is the on-chain address, not secret key material.
  console.log(`[AgentWallet] Wallet ready. Public key: ${publicKey}`);
}
