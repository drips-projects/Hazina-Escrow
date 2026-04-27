import * as StellarSdk from '@stellar/stellar-sdk';

const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const CONTRACT_CALL_TIMEOUT_MS = 30_000;

// Testnet USDC issuer (Circle testnet)
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

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

  const usdc = new StellarSdk.Asset('USDC', USDC_ISSUER);

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
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
    networkPassphrase: StellarSdk.Networks.TESTNET,
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

export function getAgentPublicKey(): string | null {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}
