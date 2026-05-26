import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  getDataset,
  updateDataset,
  addTransaction,
  getFailedDeliveryTransactions,
  getTransactionByHash,
  updateTransactionByHash,
  txHashUsed,
} from "../common/storage";
import { validateBody } from "../common/validate";
import { generateDataSummary } from "../ai/claude.service";
import { notifySeller } from "../webhooks/webhook.service";
import { verifyStellarPayment } from "./stellar.service";
import { sanitizeUserText } from "../common/sanitize";
import { transactionEventEmitter } from "../websocket/transaction-events";
import { requireAdminKey } from "../common/auth.middleware";

export const paymentsRouter = Router();

const verifySchema = z.object({
  txHash: z.string().min(1),
  buyerQuestion: z
    .string()
    .max(500)
    .transform((value) => {
      const sanitized = sanitizeUserText(value);
      return sanitized.length > 0 ? sanitized : undefined;
    })
    .optional(),
});

const verifyDemoSchema = z.object({
  buyerQuestion: z
    .string()
    .max(500)
    .transform((value) => {
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


// POST /api/query/:id — initiate query, returns 402 Payment Required
paymentsRouter.post("/query/:id", (req: Request, res: Response) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  const timestamp = Date.now();
  const memo = `haz-${req.params.id.slice(0, 8)}-${timestamp}`;

  // x402 Payment Required response
  return res.status(402).json({
    error: "Payment Required",
    x402: true,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      type: dataset.type,
    },
    payment: {
      paymentAddress: process.env.ESCROW_WALLET || dataset.sellerWallet,
      amount: dataset.pricePerQuery,
      currency: "USDC",
      network: "Stellar Testnet",
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

async function deliverVerifiedPayment(params: {
  transactionId: string;
  txHash: string;
  datasetId: string;
  buyerQuestion?: string;
}) {
  const { transactionId, txHash, datasetId, buyerQuestion } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new Error("Dataset not found");
  }

  const summaryResult = await generateDataSummary(dataset.data, buyerQuestion);
  const sellerAmount = parseFloat((dataset.pricePerQuery * 0.95).toFixed(7));
  const platformFee = parseFloat((dataset.pricePerQuery * 0.05).toFixed(4));

  await updateDataset(dataset.id, {
    queriesServed: dataset.queriesServed + 1,
    totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
  });

  await updateTransactionByHash(txHash, {
    status: "completed",
    deliveryStatus: "delivered",
    deliveryError: undefined,
    deliveredAt: new Date().toISOString(),
    aiSummary: summaryResult.summary,
    sellerPaid: true,
    sellerAmount,
  });

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, "completed", {
    amount: dataset.pricePerQuery.toString(),
    aiSummary: summaryResult.summary,
    deliveryStatus: "delivered",
  });

  notifySeller(dataset.sellerWallet, "payment.received", {
    datasetId: dataset.id,
    datasetName: dataset.name,
    txHash,
    amount: dataset.pricePerQuery,
    buyerQuery,
  }).catch(() => {});

  return {
    success: true,
    data: dataset.data,
    ai: {
      summary: summaryResult.summary,
      answer: summaryResult.answer,
    },
    transaction: {
      hash: txHash,
      status: "completed" as const,
      deliveryStatus: "delivered" as const,
      amount: dataset.pricePerQuery,
      sellerReceived: sellerAmount,
      platformFee,
    },
  };
}

async function markDeliveryFailure(params: {
  transactionId: string;
  txHash: string;
  datasetId: string;
  buyerQuestion?: string;
  error: unknown;
}) {
  const { transactionId, txHash, datasetId, buyerQuestion, error } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new Error("Dataset not found");
  }

  const message = error instanceof Error ? error.message : String(error);
  const existing = await getTransactionByHash(txHash);
  await updateTransactionByHash(txHash, {
    status: "verified",
    deliveryStatus: "failed",
    deliveryError: message,
    deliveryAttempts: (existing?.deliveryAttempts ?? 0) + 1,
    buyerQuery,
  });

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, "delivery_failed", {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery,
    deliveryStatus: "failed",
    error: message,
  });

  return {
    success: true,
    pendingDelivery: true,
    warning: "DELIVERY_PENDING_RETRY",
    transaction: {
      hash: txHash,
      status: "delivery_failed" as const,
      deliveryStatus: "failed" as const,
      amount: dataset.pricePerQuery,
      sellerReceived: parseFloat((dataset.pricePerQuery * 0.95).toFixed(7)),
      platformFee: parseFloat((dataset.pricePerQuery * 0.05).toFixed(4)),
      deliveryError: message,
    },
  };
}

export async function retryFailedDeliveries(): Promise<void> {
  const failedTransactions = await getFailedDeliveryTransactions();

  await Promise.all(
    failedTransactions.map(async (transaction) => {
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

  void retryFailedDeliveries().catch((error) => {
    console.error("[Escrow] Initial delivery retry run failed:", error);
  });

  deliveryRetryWorker = setInterval(() => {
    void retryFailedDeliveries().catch((error) => {
      console.error("[Escrow] Delivery retry worker failed:", error);
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

// POST /api/verify/:id — verify payment on Stellar and release the dataset to the buyer
paymentsRouter.post("/verify/:id", validateBody(verifySchema), async (req: Request, res: Response) => {
  const { txHash, buyerQuestion } = req.body as z.infer<typeof verifySchema>;
  const dataset = getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  if (await txHashUsed(txHash)) {
    return res.status(400).json({ error: "Escrow already processed" });
  }

  const transactionId = `tx-${uuidv4()}`;
  const destinationAddress = process.env.ESCROW_WALLET || dataset.sellerWallet;

  try {
    transactionEventEmitter.updateTransactionStatus(
      transactionId,
      dataset.id,
      "verifying",
      {
        amount: dataset.pricePerQuery.toString(),
        buyerQuery,
      }
    );

    const verification = await verifyStellarPayment({
      txHash,
      expectedAmount: dataset.pricePerQuery,
      destinationAddress,
    });

    if (!verification.valid) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        {
          error: verification.reason || "Stellar payment verification failed",
        }
      );
      return res.status(400).json({
        error: verification.reason || "Stellar payment verification failed",
      });
    }

    await addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash,
      amount: dataset.pricePerQuery,
      status: "verified",
      deliveryStatus: "pending",
      sellerPaid: false,
      buyerQuery,
      timestamp: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      deliveryAttempts: 0,
    });

    transactionEventEmitter.receivePayment(
      transactionId,
      dataset.id,
      dataset.pricePerQuery.toString()
    );

    transactionEventEmitter.updateTransactionStatus(
      transactionId,
      dataset.id,
      "delivery_pending",
      {
        amount: dataset.pricePerQuery.toString(),
        buyerQuery,
        deliveryStatus: "pending",
      }
    );

    try {
      const response = await deliverVerifiedPayment({
        transactionId,
        txHash,
        datasetId: dataset.id,
        buyerQuestion,
      });

      transactionEventEmitter.queryDataset(
        transactionId,
        dataset.id,
        dataset.queriesServed + 1
      );

      return res.json({
        ...response,
        warning: null,
      });
    } catch (deliveryErr) {
      console.error("[Escrow] Delivery failed — queued for retry:", deliveryErr);
      const pendingResponse = await markDeliveryFailure({
        transactionId,
        txHash,
        datasetId: dataset.id,
        buyerQuestion,
        error: deliveryErr,
      });

      return res.status(202).json(pendingResponse);
    }
  } catch (err) {
    console.error("Verification error:", err);
    transactionEventEmitter.updateTransactionStatus(
      transactionId,
      dataset.id,
      "failed",
      { error: "Internal verification error" }
    );
    return res.status(500).json({ error: "Internal verification error" });
  }
});

// POST /api/verify/:id/demo — demo mode (skip Stellar check) for hackathon
paymentsRouter.post("/verify/:id/demo", validateBody(verifyDemoSchema), async (req: Request, res: Response) => {
  const { buyerQuestion } = req.body as z.infer<typeof verifyDemoSchema>;
  const dataset = getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  const transactionId = `tx-demo-${uuidv4()}`;

  // Emit verifying status
  transactionEventEmitter.updateTransactionStatus(
    transactionId,
    dataset.id,
    "verifying"
  );

  // Emit payment received
  transactionEventEmitter.receivePayment(
    transactionId,
    dataset.id,
    dataset.pricePerQuery.toString()
  );

  let summary = "";
  let answer: string | undefined;
  try {
    const result = await generateDataSummary(dataset.data, buyerQuestion);
    summary = result.summary;
    answer = result.answer;
  } catch (err) {
    console.error("Demo mode AI error:", err);
    summary =
      "Demo mode: AI summary unavailable. Set ANTHROPIC_API_KEY to enable.";
  }

  const sellerAmount = dataset.pricePerQuery * 0.95;
  const platformFee = dataset.pricePerQuery * 0.05;

  // Emit payment forwarded
  transactionEventEmitter.forwardPayment(
    transactionId,
    dataset.id,
    sellerAmount.toFixed(7),
    platformFee.toFixed(4)
  );

  updateDataset(dataset.id, {
    queriesServed: dataset.queriesServed + 1,
    totalEarned: parseFloat(
      (dataset.totalEarned + sellerAmount).toFixed(4),
    ),
  });

  addTransaction({
    id: transactionId,
    datasetId: dataset.id,
    txHash: `demo-${Date.now()}`,
    amount: dataset.pricePerQuery,
    status: "completed",
    deliveryStatus: "delivered",
    sellerPaid: true,
    sellerAmount,
    buyerQuery: buyerQuestion,
    aiSummary: summary,
    timestamp: new Date().toISOString(),
  });

  // Emit completed status
  transactionEventEmitter.updateTransactionStatus(
    transactionId,
    dataset.id,
    "completed",
    {
      amount: dataset.pricePerQuery.toString(),
      aiSummary: summary,
    }
  );

  // Emit dataset queried event
  transactionEventEmitter.queryDataset(
    transactionId,
    dataset.id,
    dataset.queriesServed + 1
  );

  return res.json({
    success: true,
    demo: true,
    data: dataset.data,
    ai: { summary, answer },
    transaction: {
      hash: `demo-${Date.now()}`,
      status: "completed",
      deliveryStatus: "delivered",
      amount: dataset.pricePerQuery,
      sellerReceived: parseFloat(sellerAmount.toFixed(4)),
      platformFee: parseFloat(platformFee.toFixed(4)),
    },
  });
});

paymentsRouter.get("/admin/unpaid-sellers", requireAdminKey, async (_req: Request, res: Response) => {
  const unpaid = await getUnpaidTransactions();
  const unpaidTransactions = await Promise.all(
    unpaid.map(async (transaction) => {
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
});
