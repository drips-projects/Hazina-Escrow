import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  getDataset,
  updateDataset,
  addTransaction,
  txHashUsed,
} from "../common/storage";
import { validateBody } from "../common/validate";
import { generateDataSummary } from "../ai/claude.service";
import { notifySeller } from "../webhooks/webhook.service";
import { getEscrow, releaseEscrow, refundEscrow, usdcToStroops } from "../lib/contract.client";
import { sanitizeUserText } from "../common/sanitize";
import { transactionEventEmitter } from "../websocket/transaction-events";
import { requireAdminKey } from "../common/auth.middleware";

export const paymentsRouter = Router();

const verifySchema = z.object({
  escrowId: z.number().int().nonnegative(),
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
 *               - escrowId
 *             properties:
 *               escrowId:
 *                 type: integer
 *                 description: The escrow_id returned by lock() on the Soroban contract
 *               buyerQuestion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Data released successfully
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

// POST /api/verify/:id — verify on-chain escrow lock and release funds via Soroban contract
paymentsRouter.post("/verify/:id", validateBody(verifySchema), async (req: Request, res: Response) => {
  const { escrowId, buyerQuestion } = req.body as z.infer<typeof verifySchema>;
  const dataset = getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  const escrowKey = `escrow-${escrowId}`;
  if (txHashUsed(escrowKey)) {
    return res.status(400).json({ error: "Escrow already processed" });
  }

  const transactionId = `tx-${uuidv4()}`;

  try {
    // Emit verifying status
    transactionEventEmitter.updateTransactionStatus(
      transactionId,
      dataset.id,
      "verifying"
    );

    // Verify the lock exists on the Soroban contract
    let escrow;
    try {
      escrow = await getEscrow(escrowId);
    } catch (err) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        {
          error: `Escrow #${escrowId} not found on contract`,
        }
      );
      return res.status(400).json({
        error: `Escrow #${escrowId} not found on contract: ${err instanceof Error ? err.message : err}`,
      });
    }

    if (escrow.released) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        { error: "Escrow already released" }
      );
      return res.status(400).json({ error: "Escrow already released" });
    }
    if (escrow.refunded) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        { error: "Escrow already refunded" }
      );
      return res.status(400).json({ error: "Escrow already refunded" });
    }
    if (escrow.dataset_id !== dataset.id) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        { error: `Escrow dataset mismatch` }
      );
      return res.status(400).json({
        error: `Escrow dataset mismatch: expected ${dataset.id}, got ${escrow.dataset_id}`,
      });
    }

    const expectedStroops = usdcToStroops(dataset.pricePerQuery);
    const tolerance = usdcToStroops(0.001);
    if (escrow.amount < expectedStroops - tolerance) {
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "failed",
        { error: `Escrow amount too low` }
      );
      return res.status(400).json({
        error: `Escrow amount too low: expected ${expectedStroops} stroops, got ${escrow.amount}`,
      });
    }

    // Emit payment received
    transactionEventEmitter.receivePayment(
      transactionId,
      dataset.id,
      dataset.pricePerQuery.toString()
    );

    // Generate AI summary — refund and abort if this fails
    let summary = "";
    let answer: string | undefined;
    try {
      const result = await generateDataSummary(dataset.data, buyerQuestion);
      summary = result.summary;
      answer = result.answer;
    } catch (aiErr) {
      console.error("[Escrow] AI step failed — refunding buyer:", aiErr);
      transactionEventEmitter.updateTransactionStatus(
        transactionId,
        dataset.id,
        "refunded",
        { error: "AI processing failed" }
      );
      try {
        const refundTxHash = await refundEscrow(escrowId);
        console.log(`[Escrow] Refunded escrow #${escrowId} → ${refundTxHash}`);
      } catch (refundErr) {
        console.error("[Escrow] Refund also failed:", refundErr);
      }
      return res.status(500).json({ error: "AI processing failed — escrow refunded" });
    }

    // Release funds on-chain: contract pays 95% to seller, 5% to admin
    let releaseTxHash: string | undefined;
    const sellerAmount = parseFloat((dataset.pricePerQuery * 0.95).toFixed(7));
    try {
      releaseTxHash = await releaseEscrow(escrowId);
      console.log(`[Escrow] Released escrow #${escrowId} → ${releaseTxHash}`);

      // Emit payment forwarded
      transactionEventEmitter.forwardPayment(
        transactionId,
        dataset.id,
        sellerAmount.toString(),
        (dataset.pricePerQuery * 0.05).toFixed(4)
      );
    } catch (releaseErr) {
      console.error("[Escrow] Release failed:", releaseErr);
    }

    // Update dataset stats
    updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
    });

    // Log transaction (escrowKey used as txHash for replay protection)
    addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash: escrowKey,
      amount: dataset.pricePerQuery,
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

    // Notify seller via webhooks
    notifySeller(dataset.sellerWallet, "payment.received", {
      datasetId: dataset.id,
      datasetName: dataset.name,
      escrowId,
      amount: dataset.pricePerQuery,
      buyerQuery: buyerQuestion,
    }).catch(() => {});

    if (releaseTxHash) {
      notifySeller(dataset.sellerWallet, "payment.forwarded", {
        datasetId: dataset.id,
        datasetName: dataset.name,
        releaseTxHash,
        amount: sellerAmount,
      }).catch(() => {});
    }

    return res.json({
      success: true,
      data: dataset.data,
      ai: { summary, answer },
      transaction: {
        escrowId,
        amount: dataset.pricePerQuery,
        sellerReceived: sellerAmount,
        platformFee: parseFloat((dataset.pricePerQuery * 0.05).toFixed(4)),
        releaseTxHash: releaseTxHash ?? null,
      },
    });
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
      amount: dataset.pricePerQuery,
      sellerReceived: parseFloat(sellerAmount.toFixed(4)),
      platformFee: parseFloat(platformFee.toFixed(4)),
    },
  });
});
