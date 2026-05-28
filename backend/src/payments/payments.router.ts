import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  getDataset,
  updateDataset,
  addTransaction,
  getFailedDeliveryTransactions,
  txHashUsed,
  getUnpaidTransactions,
} from "../common/storage";
import { validateBody } from "../common/validate";
import { sellerShare, platformFee as computePlatformFee } from "../common/constants";
import { generateDataSummary } from "../ai/claude.service";
import { sanitizeUserText } from "../common/sanitize";
import { requireAdminKey } from "../common/auth.middleware";
import {
  getManualReviewPayouts,
  recordPayoutFailure,
  runDuePayoutRetries,
  scheduleRetrySweep,
} from "./payout-retry.service";
import { transactionEventEmitter } from "../websocket/transaction-events";
import { requireAdminKey } from "../common/auth.middleware";
import {
  deliverVerifiedPayment,
  markDeliveryFailure,
  processPayment,
} from "./payments.service";

export const paymentsRouter = Router();
scheduleRetrySweep(1_000);

const verifySchema = z.object({
  txHash: z.string().min(1),
  buyerQuestion: z
    .string()
    .max(500)
    .transform(value => {
      const sanitized = sanitizeUserText(value);
      return sanitized.length > 0 ? sanitized : undefined;
    })
    .optional(),
});

const verifyDemoSchema = z.object({
  buyerQuestion: z
    .string()
    .max(500)
    .transform(value => {
      const sanitized = sanitizeUserText(value);
      return sanitized.length > 0 ? sanitized : undefined;
    })
    .optional(),
});

/**
 * @openapi
 * /api/query/{id}:
 *   post:
 *     summary: Initiate a dataset query
 *     description: Returns a 402 Payment Required response with payment instructions and memo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       402:
 *         description: Payment Required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 x402:
 *                   type: boolean
 *                 dataset:
 *                   type: object
 *                 payment:
 *                   type: object
 *       404:
 *         description: Dataset not found
 */

/**
 * @openapi
 * /api/verify/{id}:
 *   post:
 *     summary: Verify payment and release data
 *     description: Verifies the Stellar payment transaction and releases the dataset content with an AI summary
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - txHash
 *             properties:
 *               txHash:
 *                 type: string
 *                 description: Stellar transaction hash for the buyer payment
 *               buyerQuestion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified and data delivered successfully
 *       202:
 *         description: Payment verified but delivery is pending retry
 *       400:
 *         description: Invalid transaction hash or payment
 *       404:
 *         description: Dataset not found
 */

/**
 * @openapi
 * /api/verify/{id}/demo:
 *   post:
 *     summary: Verify payment in demo mode (skip on-chain check)
 *     description: releases the dataset content with an AI summary without requiring a real Stellar transaction
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               buyerQuestion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Data released successfully (demo mode)
 *       404:
 *         description: Dataset not found
 */



import { v4 as uuidv4 } from "uuid";
 main
// POST /api/query/:id — initiate query, returns 402 Payment Required
paymentsRouter.post('/query/:id', async (req: Request, res: Response) => {
  const dataset = await getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  const timestamp = Date.now();
  const memo = `haz-${req.params.id.slice(0, 8)}-${timestamp}`;

  const transactionId = `tx-${uuidv4()}`;
  await addTransaction({
    id: transactionId,
    datasetId: dataset.id,
    txHash: '', // Not yet known
    memo,
    amount: dataset.pricePerQuery,
    status: 'pending',
    deliveryStatus: 'pending',
    timestamp: new Date().toISOString(),
  });

  // x402 Payment Required response
  return res.status(402).json({
    error: 'Payment Required',
    x402: true,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      type: dataset.type,
    },
    payment: {
      paymentAddress: process.env.ESCROW_WALLET || dataset.sellerWallet,
      amount: dataset.pricePerQuery,
      currency: 'USDC',
      network: 'Stellar Testnet',
      memo,
      expiresIn: 300, // 5 minutes
      instructions: [
        `1. Open your Stellar wallet (Lobstr, StellarX, or testnet faucet)`,
        `2. Send exactly ${dataset.pricePerQuery} USDC to the address above`,
        `3. Include memo: ${memo}`,
        `4. Submit the transaction hash below to receive your data`,
      ],
    },
  });
});

export async function retryFailedDeliveries(): Promise<void> {
  const failedTransactions = await getFailedDeliveryTransactions();

  await Promise.all(
    failedTransactions.map(async transaction => {
      try {
        await deliverVerifiedPayment({
          transactionId: transaction.id,
          txHash: transaction.txHash,
          datasetId: transaction.datasetId,
          buyerQuestion: transaction.buyerQuery,
        });
      } catch (error) {
        await markDeliveryFailure({
          transactionId: transaction.id,
          txHash: transaction.txHash,
          datasetId: transaction.datasetId,
          buyerQuestion: transaction.buyerQuery,
          error,
        });
      }
    }),
  );
}

let deliveryRetryWorker: NodeJS.Timeout | null = null;

export function startDeliveryRetryWorker(intervalMs = 60_000): void {
  if (deliveryRetryWorker) {
    return;
  }

  void retryFailedDeliveries().catch(error => {
    console.error('[Escrow] Initial delivery retry run failed:', error);
  });

  deliveryRetryWorker = setInterval(() => {
    void retryFailedDeliveries().catch(error => {
      console.error('[Escrow] Delivery retry worker failed:', error);
    });
  }, intervalMs);
}

export function stopDeliveryRetryWorker(): void {
  if (!deliveryRetryWorker) {
    return;
  }

  clearInterval(deliveryRetryWorker);
  deliveryRetryWorker = null;
}

    // Forward 95% to seller on-chain
    let sellerTxHash: string | undefined;
    const sellerAmount = parseFloat((dataset.pricePerQuery * 0.95).toFixed(7));
    try {
      const payment = await sendUsdcPayment({
        destinationAddress: dataset.sellerWallet,
        amount: sellerAmount.toFixed(7),
        memo: `hazina-${dataset.id.slice(0, 10)}`,
      });
      sellerTxHash = payment.txHash;
      console.log(
        `[Escrow] Paid seller ${sellerAmount} USDC → ${dataset.sellerWallet} (${sellerTxHash})`,
      );
    } catch (payErr) {
      console.warn(
        "[Escrow] Seller payment failed (data still delivered):",
        payErr instanceof Error ? payErr.message : payErr,
      );
      await recordPayoutFailure({
        datasetId: dataset.id,
        sellerWallet: dataset.sellerWallet,
        buyerTxHash: txHash,
        intendedAmount: sellerAmount,
        error: payErr instanceof Error ? payErr.message : String(payErr),
      });
    }
// POST /api/verify/:id — verify payment on Stellar and release the dataset to the buyer
paymentsRouter.post(
  '/verify/:id',
  validateBody(verifySchema),
  async (req: Request, res: Response) => {
    const { txHash, buyerQuestion } = req.body as z.infer<typeof verifySchema>;
    const dataset = await getDataset(req.params.id);

    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    if (await txHashUsed(txHash)) {
      return res.status(400).json({ error: 'Escrow already processed' });
    }

    try {
      const result = await processPayment({
        txHash,
        datasetId: dataset.id,
        buyerQuestion,
      });

// GET /api/admin/payouts/stuck — list payouts requiring manual review
paymentsRouter.get("/admin/payouts/stuck", requireAdminKey, (_req: Request, res: Response) => {
  return res.json({
    payouts: getManualReviewPayouts(),
  });
});

// POST /api/admin/payouts/retry — trigger retry sweep now
paymentsRouter.post("/admin/payouts/retry", requireAdminKey, async (_req: Request, res: Response) => {
  const processed = await runDuePayoutRetries();
  scheduleRetrySweep(1_000);
  return res.json({ success: true, processed });
});

// POST /api/verify/:id/demo — demo mode (skip Stellar check) for hackathon
paymentsRouter.post("/verify/:id/demo", validateBody(verifyDemoSchema), async (req: Request, res: Response) => {
  const { buyerQuestion } = req.body as z.infer<typeof verifyDemoSchema>;
  const dataset = await getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  const transactionId = `tx-demo-id-${Date.now()}`; // Simplified for demo

  // Emit verifying status
  transactionEventEmitter.updateTransactionStatus(
    transactionId,
    dataset.id,
    "verifying"
  );

      return res.json({
        ...result,
        warning: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal verification error';
      return res.status(400).json({ error: message });
    }
  },
);

// POST /api/verify/:id/demo — demo mode (skip Stellar check) for hackathon
paymentsRouter.post(
  '/verify/:id/demo',
  validateBody(verifyDemoSchema),
  async (req: Request, res: Response) => {
    const { buyerQuestion } = req.body as z.infer<typeof verifyDemoSchema>;
    const dataset = await getDataset(req.params.id);

    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const transactionId = `tx-demo-id-${Date.now()}`; // Simplified for demo

    // Emit verifying status
    transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'verifying');

    // Emit payment received
    transactionEventEmitter.receivePayment(
      transactionId,
      dataset.id,
      dataset.pricePerQuery.toString(),
    );

    let summary = '';
    let answer: string | undefined;
    try {
      const result = await generateDataSummary(dataset.data, buyerQuestion);
      summary = result.summary;
      answer = result.answer;
    } catch (err) {
      console.error('Demo mode AI error:', err);
      summary = 'Demo mode: AI summary unavailable. Set ANTHROPIC_API_KEY to enable.';
    }

    const sellerAmount = sellerShare(dataset.pricePerQuery);
    const platformFee = computePlatformFee(dataset.pricePerQuery);

    // Emit payment forwarded
    transactionEventEmitter.forwardPayment(
      transactionId,
      dataset.id,
      sellerAmount.toFixed(7),
      platformFee.toFixed(4),
    );

    await updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
    });

    await addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash: `demo-${Date.now()}`,
      amount: dataset.pricePerQuery,
      status: 'completed',
      deliveryStatus: 'delivered',
      sellerPaid: true,
      sellerAmount,
      buyerQuery: buyerQuestion,
      aiSummary: summary,
      timestamp: new Date().toISOString(),
    });

    // Emit completed status
    transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'completed', {
      amount: dataset.pricePerQuery.toString(),
      aiSummary: summary,
    });

    // Emit dataset queried event
    transactionEventEmitter.queryDataset(transactionId, dataset.id, dataset.queriesServed + 1);

    return res.json({
      success: true,
      demo: true,
      data: dataset.data,
      ai: { summary, answer },
      transaction: {
        hash: `demo-${Date.now()}`,
        status: 'completed',
        deliveryStatus: 'delivered',
        amount: dataset.pricePerQuery,
        sellerReceived: parseFloat(sellerAmount.toFixed(4)),
        platformFee: parseFloat(platformFee.toFixed(4)),
      },
    });
  },
);

paymentsRouter.get(
  '/admin/unpaid-sellers',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    const unpaid = await getUnpaidTransactions();
    const unpaidTransactions = await Promise.all(
      unpaid.map(async transaction => {
        const dataset = await getDataset(transaction.datasetId);
        return {
          ...transaction,
          datasetName: dataset?.name ?? null,
          sellerWallet: dataset?.sellerWallet ?? null,
        };
      }),
    );

    return res.json({
      success: true,
      unpaidTransactions,
      total: unpaidTransactions.length,
    });
  },
);
