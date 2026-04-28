import * as StellarSdk from '@stellar/stellar-sdk';
import { callContract } from '../agent/agent.wallet';
import { SOROBAN_RPC_URL } from './stellar.config';

const DEFAULT_CONTRACT_ID = 'CCPG2CSL6WDUA2IFUDHFN5SCJQUTFCLFKMTARALQ5RWGB2RGG345HEEH';

function contractId(): string {
  return process.env.CONTRACT_ID || DEFAULT_CONTRACT_ID;
}

export interface EscrowRecord {
  escrow_id: bigint;
  dataset_id: string;
  buyer: string;
  seller: string;
  amount: bigint;  // in stroops (7 decimal places: 1 USDC = 10_000_000)
  released: boolean;
  refunded: boolean;
}

/** Convert a USDC float (e.g. 1.5) to Soroban i128 stroops. */
export function usdcToStroops(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10_000_000));
}

/**
 * Read an escrow record from the contract without signing (simulate-only).
 * Throws if the escrow does not exist.
 */
export async function getEscrow(escrowId: number): Promise<EscrowRecord> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) throw new Error('AGENT_WALLET_SECRET not configured');

  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const contract = new StellarSdk.Contract(contractId());

  const account = await rpc.getAccount(keypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      contract.call('get_escrow', StellarSdk.nativeToScVal(BigInt(escrowId), { type: 'u64' })),
    )
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    throw new Error(`get_escrow(${escrowId}) failed: ${JSON.stringify(simResult)}`);
  }

  const retval = simResult.result?.retval;
  if (!retval) throw new Error(`get_escrow(${escrowId}) returned no value`);

  const raw = StellarSdk.scValToNative(retval) as Record<string, unknown>;
  return {
    escrow_id: BigInt(String(raw.escrow_id)),
    dataset_id: String(raw.dataset_id),
    buyer: String(raw.buyer),
    seller: String(raw.seller),
    amount: BigInt(String(raw.amount)),
    released: Boolean(raw.released),
    refunded: Boolean(raw.refunded),
  };
}

/**
 * Admin calls release(escrowId) — contract pays 95% to seller, 5% to admin.
 * Returns the confirmed transaction hash.
 */
export async function releaseEscrow(escrowId: number): Promise<string> {
  const adminPublicKey = StellarSdk.Keypair.fromSecret(
    process.env.AGENT_WALLET_SECRET!,
  ).publicKey();

  return callContract(contractId(), 'release', [
    new StellarSdk.Address(adminPublicKey).toScVal(),
    StellarSdk.nativeToScVal(BigInt(escrowId), { type: 'u64' }),
  ]);
}

/**
 * Admin calls refund(escrowId) — contract returns full amount to buyer.
 * Returns the confirmed transaction hash.
 */
export async function refundEscrow(escrowId: number): Promise<string> {
  const adminPublicKey = StellarSdk.Keypair.fromSecret(
    process.env.AGENT_WALLET_SECRET!,
  ).publicKey();

  return callContract(contractId(), 'refund', [
    new StellarSdk.Address(adminPublicKey).toScVal(),
    StellarSdk.nativeToScVal(BigInt(escrowId), { type: 'u64' }),
  ]);
}

/**
 * lockEscrow is called by the buyer's wallet, not the backend.
 * The buyer invokes lock() directly on the Soroban contract from their own keypair,
 * then passes the returned escrow_id to POST /api/verify/:id.
 *
 * This stub is included so the typed interface is complete for frontend consumers.
 */
export async function lockEscrow(_params: {
  buyerPublicKey: string;
  sellerPublicKey: string;
  tokenAddress: string;
  amountStroops: bigint;
  datasetId: string;
}): Promise<never> {
  throw new Error(
    'lockEscrow must be signed by the buyer. Call lock() directly from the buyer wallet.',
  );
}
