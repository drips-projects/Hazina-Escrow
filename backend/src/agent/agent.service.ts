import { v4 as uuidv4 } from 'uuid';
import { getAllDatasets, getDataset, updateDataset, addTransaction, txHashUsed } from '../common/storage';
import { verifyStellarPayment } from '../payments/stellar.service';
import { sendUsdcPayment, getAgentPublicKey } from './agent.wallet';
import { synthesizeResearch, parseRiskTolerance, parseBudget, ResearchReport } from '../ai/research.service';
import { notifySeller } from '../webhooks/webhook.service';

// Fee the agent charges the human (1 USDC flat)
export const AGENT_FEE_USDC = 1;

// Dataset types the agent purchases and their roles in the report
export const SELLER_TYPES = [
  { type: 'yield-data',    role: 'yieldData',     description: 'APY & protocol data' },
  { type: 'whale-wallets', role: 'whaleData',     description: 'Whale wallet movements' },
  { type: 'risk-scores',   role: 'riskData',      description: 'Protocol risk scores' },
  { type: 'sentiment',     role: 'sentimentData', description: 'Social market sentiment' },
] as const;

export interface AgentJob {
  jobId: string;
  query: string;
  budget: number;
  riskTolerance: string;
  humanTxHash: string;
  agentWallet: string | null;
  purchases: PurchaseRecord[];
  totalSpent: number;
  agentProfit: number;
  report: ResearchReport;
  timestamp: string;
}

export interface PurchaseRecord {
  datasetId: string;
  datasetName: string;
  type: string;
  role: string;
  amountPaid: number;
  txHash: string;
  demo: boolean;
}

/**
 * Verifies the human's 1 USDC payment then runs the full research pipeline.
 * Real mode: sends actual Stellar payments from agent's funded wallet.
 */
export async function runResearchAgent(
  query: string,
  humanTxHash: string
): Promise<AgentJob> {
  // 1. Verify human's 1 USDC payment to escrow wallet
  if (await txHashUsed(humanTxHash)) {
    throw new Error('Transaction hash already used');
  }

  const escrowWallet = process.env.ESCROW_WALLET;
  if (!escrowWallet) throw new Error('ESCROW_WALLET not configured');

  const verification = await verifyStellarPayment({
    txHash: humanTxHash,
    expectedAmount: AGENT_FEE_USDC,
    destinationAddress: escrowWallet,
  });

  if (!verification.valid) {
    throw new Error(verification.reason || 'Human payment verification failed');
  }

  return _executeResearch(query, humanTxHash, false);
}

/**
 * Demo mode — skips real Stellar payments. Uses stored dataset data directly.
 * Simulates the x402 flow and shows what payments would have been made.
 */
export async function runResearchAgentDemo(query: string): Promise<AgentJob> {
  const demoTxHash = `demo-agent-${Date.now()}`;
  return _executeResearch(query, demoTxHash, true);
}

async function _executeResearch(
  query: string,
  humanTxHash: string,
  demo: boolean
): Promise<AgentJob> {
  const jobId = `job-${uuidv4()}`;
  const budget = parseBudget(query);
  const riskTolerance = parseRiskTolerance(query);
  const agentWallet = getAgentPublicKey();

  const allDatasets = await getAllDatasets();

  // 2. Find the best dataset for each seller role
  const purchases: PurchaseRecord[] = [];
  const collectedData: Record<string, Record<string, unknown>> = {};
  let totalSpent = 0;

  for (const seller of SELLER_TYPES) {
    const dataset = allDatasets.find((d) => d.type === seller.type);
    if (!dataset) {
      console.warn(`[Agent] No dataset found for type: ${seller.type}`);
      collectedData[seller.role] = {};
      continue;
    }

    let txHash: string;

    if (demo) {
      // Demo: simulate payment, read data directly
      txHash = `demo-${seller.type}-${Date.now()}`;
      console.log(
        `[Agent][Demo] Simulating payment of ${dataset.pricePerQuery} USDC → ${dataset.sellerWallet} for ${dataset.name}`,
      );
    } else {
      // Real: send USDC from agent wallet → seller wallet
      console.log(
        `[Agent] Paying ${dataset.pricePerQuery} USDC → ${dataset.sellerWallet} for ${dataset.name}`,
      );
      const payment = await sendUsdcPayment({
        destinationAddress: dataset.sellerWallet,
        amount: dataset.pricePerQuery.toFixed(7),
        memo: `haz-agent-${jobId.slice(0, 8)}`,
      });
      txHash = payment.txHash;
    }

    // Record the purchase
    purchases.push({
      datasetId: dataset.id,
      datasetName: dataset.name,
      type: dataset.type,
      role: seller.role,
      amountPaid: dataset.pricePerQuery,
      txHash,
      demo,
    });

    totalSpent += dataset.pricePerQuery;

    // Update dataset stats
    await updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat((dataset.totalEarned + dataset.pricePerQuery * 0.95).toFixed(4)),
    });

    // Log individual transaction
    await addTransaction({
      id: `tx-agent-${uuidv4()}`,
      datasetId: dataset.id,
      txHash,
      amount: dataset.pricePerQuery,
      sellerPaid: true,
      sellerAmount: parseFloat((dataset.pricePerQuery * 0.95).toFixed(7)),
      sellerTxHash: txHash,
      buyerQuery: `[Agent Job ${jobId}] ${query}`,
      timestamp: new Date().toISOString(),
    });

    // Notify seller via webhook
    notifySeller(dataset.sellerWallet, 'dataset.queried', {
      datasetId: dataset.id,
      datasetName: dataset.name,
      type: dataset.type,
      txHash,
      amount: dataset.pricePerQuery,
      agentJobId: jobId,
      demo,
    }).catch(() => {});

    // Read the actual data
    const fresh = await getDataset(dataset.id);
    collectedData[seller.role] = fresh?.data ?? {};
  }

  const agentProfit = parseFloat((AGENT_FEE_USDC - totalSpent).toFixed(4));

  const datasetCosts: Record<string, number> = {};
  purchases.forEach(p => {
    datasetCosts[p.role] = p.amountPaid;
  });

  // 3. Synthesise with Claude
  const report = await synthesizeResearch({
    userQuery: query,
    budget,
    riskTolerance,
    yieldData:     collectedData['yieldData']     ?? {},
    whaleData:     collectedData['whaleData']      ?? {},
    riskData:      collectedData['riskData']       ?? {},
    sentimentData: collectedData['sentimentData']  ?? {},
    datasetCosts,
  });

  // 4. Log the agent job as a transaction for audit trail
  await addTransaction({
    id: `tx-agent-job-${jobId}`,
    datasetId: 'agent-job',
    txHash: humanTxHash,
    amount: AGENT_FEE_USDC,
    sellerPaid: true,
    buyerQuery: query,
    aiSummary: report.rawAnalysis,
    timestamp: new Date().toISOString(),
  });

  return {
    jobId,
    query,
    budget,
    riskTolerance,
    humanTxHash,
    agentWallet,
    purchases,
    totalSpent: parseFloat(totalSpent.toFixed(4)),
    agentProfit,
    report,
    timestamp: new Date().toISOString(),
  };
}
