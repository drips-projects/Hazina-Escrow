import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runResearchAgent, runResearchAgentDemo, SELLER_TYPES, AGENT_FEE_USDC } from './agent.service';
import { getAgentPublicKey } from './agent.wallet';
import { validateBody } from '../common/validate';
import { getAllDatasets } from '../common/storage';

export const agentRouter = Router();

const researchSchema = z.object({
  query: z.string().trim().min(5, 'query must be at least 5 characters').max(1000),
  txHash: z.string().trim().min(1, 'txHash is required').max(200),
});

const researchDemoSchema = z.object({
  query: z.string().trim().min(5, 'query must be at least 5 characters').max(1000),
});

/**
 * @openapi
 * /api/agent/info:
 *   get:
 *     summary: Get agent information
 *     description: Retrieve details about the Hazina Research Agent, including its wallet address and fee structure
 *     responses:
 *       200:
 *         description: Agent information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 agent:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     version:
 *                       type: string
 *                     description:
 *                       type: string
 *                     agentWallet:
 *                       type: string
 *                     fee:
 *                       type: object
 *                     sellers:
 *                       type: array
 *                       items:
 *                         type: object
 */

/**
 * @openapi
 * /api/agent/research:
 *   post:
 *     summary: Run autonomous research job
 *     description: Starts a research job using the autonomous agent. Requires a 1 USDC Stellar payment.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *               - txHash
 *             properties:
 *               query:
 *                 type: string
 *                 minLength: 5
 *               txHash:
 *                 type: string
 *     responses:
 *       200:
 *         description: Research job completed
 *       400:
 *         description: Invalid query or transaction hash
 *       402:
 *         description: Payment Required or verification failed
 */

/**
 * @openapi
 * /api/agent/research/demo:
 *   post:
 *     summary: Run research job in demo mode
 *     description: Simulates an autonomous research job without requiring real payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 minLength: 5
 *     responses:
 *       200:
 *         description: Research job completed (demo mode)
 *       400:
 *         description: Invalid query
 */


// GET /api/agent/info — agent wallet address and capabilities
agentRouter.get('/info', async (_req: Request, res: Response) => {
  const datasets = await getAllDatasets();

  const sellers = SELLER_TYPES.map(st => {
    const ds = datasets.find(d => d.type === st.type);
    return {
      type: st.type,
      role: st.description,
      cost: ds?.pricePerQuery ?? 0
    };
  });

  const totalCost = sellers.reduce((sum, s) => sum + (typeof s.cost === 'number' ? s.cost : 0), 0);
  const agentProfit = parseFloat((AGENT_FEE_USDC - totalCost).toFixed(4));

  res.json({
    success: true,
    agent: {
      name: 'Hazina Research Agent',
      version: '1.0.0',
      description: 'Autonomous DeFi yield researcher. Pays data sellers via x402 on Stellar, synthesises with Claude AI.',
      agentWallet: getAgentPublicKey() ?? 'Not configured (demo-only mode)',
      fee: {
        amount: AGENT_FEE_USDC,
        currency: 'USDC',
        network: 'Stellar',
        description: 'Flat fee per research job',
      },
      sellers,
      agentProfit,
      escrowWallet: process.env.ESCROW_WALLET ?? 'Not configured',
    },
  });
});

// POST /api/agent/research — real mode (requires Stellar payment + funded agent wallet)
// Body: { query: string, txHash: string }
agentRouter.post('/research', validateBody(researchSchema), async (req: Request, res: Response) => {
  const { query, txHash } = req.body as z.infer<typeof researchSchema>;

  // Respond with 402 first if no ESCROW_WALLET configured
  if (!process.env.ESCROW_WALLET) {
    return res.status(402).json({
      error: 'Payment Required',
      x402: true,
      message: 'ESCROW_WALLET not configured. Use /api/agent/research/demo for testing.',
    });
  }

  try {
    console.log(`[Agent] New research job: "${query}"`);
    const job = await runResearchAgent(query, txHash);

    return res.json({
      success: true,
      jobId: job.jobId,
      query: job.query,
      report: job.report,
      payments: {
        humanPaid: 1,
        currency: 'USDC',
        network: 'Stellar',
        humanTxHash: job.humanTxHash,
        sellerPayments: job.purchases.map((p) => ({
          seller: p.datasetName,
          type: p.type,
          amount: p.amountPaid,
          txHash: p.txHash,
          onChain: !p.demo,
        })),
        totalSpent: job.totalSpent,
        agentProfit: job.agentProfit,
      },
      meta: {
        agentWallet: job.agentWallet,
        timestamp: job.timestamp,
        datasetsQueried: job.purchases.length,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Research agent error';
    console.error('[Agent] Error:', err);

    if (message.includes('Payment verification failed') || message.includes('verification failed')) {
      return res.status(402).json({ error: message });
    }
    if (message.includes('already used')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

// POST /api/agent/research/demo — demo mode, no real payments needed
// Body: { query: string }
agentRouter.post('/research/demo', validateBody(researchDemoSchema), async (req: Request, res: Response) => {
  const { query } = req.body as z.infer<typeof researchDemoSchema>;

  try {
    console.log(`[Agent][Demo] New research job: "${query}"`);
    const job = await runResearchAgentDemo(query);

    return res.json({
      success: true,
      demo: true,
      jobId: job.jobId,
      query: job.query,
      report: job.report,
      payments: {
        humanPaid: 1,
        currency: 'USDC',
        network: 'Stellar (simulated)',
        note: 'Demo mode — no real Stellar transactions. All payments simulated.',
        sellerPayments: job.purchases.map((p) => ({
          seller: p.datasetName,
          type: p.type,
          amount: p.amountPaid,
          txHash: p.txHash,
          onChain: false,
        })),
        totalSpent: job.totalSpent,
        agentProfit: job.agentProfit,
      },
      meta: {
        agentWallet: job.agentWallet ?? 'demo-wallet',
        timestamp: job.timestamp,
        datasetsQueried: job.purchases.length,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Research agent error';
    console.error('[Agent][Demo] Error:', err);
    return res.status(500).json({ error: message });
  }
});
