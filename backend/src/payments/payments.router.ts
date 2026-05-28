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
import { verifyStellarPayment } from "./stellar.service";
import { generateDataSummary } from "../ai/claude.service";
import { sendUsdcPayment } from "../agent/agent.wallet";
import { notifySeller } from "../webhooks/webhook.service";
import { sanitizeUserText } from "../common/sanitize";
import { requireAdminKey } from "../common/auth.middleware";
import {
  getManualReviewPayouts,
  recordPayoutFailure,
  runDuePayoutRetries,
  scheduleRetrySweep,
} from "./payout-retry.service";

export const paymentsRouter = Router();
scheduleRetrySweep(1_000);

const verifySchema = z.object({
  txHash: z.string().trim().min(1, "txHash is required").max(200),
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

// POST /api/verify/:id — verify payment and release data
paymentsRouter.post("/verify/:id", validateBody(verifySchema), async (req: Request, res: Response) => {
  const { txHash, buyerQuestion } = req.body as z.infer<typeof verifySchema>;
  const dataset = getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

  // Check replay
  if (txHashUsed(txHash)) {
    return res.status(400).json({ error: "Transaction hash already used" });
  }

  try {
    // Verify on Stellar testnet
    const verification = await verifyStellarPayment({
      txHash,
      expectedAmount: dataset.pricePerQuery,
      destinationAddress: process.env.ESCROW_WALLET || dataset.sellerWallet,
    });

    if (!verification.valid) {
      return res
        .status(400)
        .json({ error: verification.reason || "Payment verification failed" });
    }

    // Generate AI summary
    let summary = "";
    let answer: string | undefined;
    try {
      const result = await generateDataSummary(dataset.data, buyerQuestion);
      summary = result.summary;
      answer = result.answer;
    } catch (aiErr) {
      console.warn("AI summary failed, proceeding without:", aiErr);
      summary =
        "Data delivered successfully. AI summary temporarily unavailable.";
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

    // Update dataset stats
    updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
    });

    // Log transaction
    addTransaction({
      id: `tx-${uuidv4()}`,
      datasetId: dataset.id,
      txHash,
      amount: dataset.pricePerQuery,
      buyerQuery: buyerQuestion,
      aiSummary: summary,
      timestamp: new Date().toISOString(),
    });

    // Notify seller via webhooks
    notifySeller(dataset.sellerWallet, "payment.received", {
      datasetId: dataset.id,
      datasetName: dataset.name,
      buyerTxHash: txHash,
      amount: dataset.pricePerQuery,
      buyerQuery: buyerQuestion,
    }).catch(() => {});

    if (sellerTxHash) {
      notifySeller(dataset.sellerWallet, "payment.forwarded", {
        datasetId: dataset.id,
        datasetName: dataset.name,
        sellerTxHash,
        amount: sellerAmount,
      }).catch(() => {});
    }

    return res.json({
      success: true,
      data: dataset.data,
      ai: { summary, answer },
      transaction: {
        hash: txHash,
        amount: dataset.pricePerQuery,
        sellerReceived: sellerAmount,
        platformFee: parseFloat((dataset.pricePerQuery * 0.05).toFixed(4)),
        sellerTxHash: sellerTxHash ?? null,
      },
    });
  } catch (err) {
    console.error("Verification error:", err);
    return res.status(500).json({ error: "Internal verification error" });
  }
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
  const dataset = getDataset(req.params.id);

  if (!dataset) return res.status(404).json({ error: "Dataset not found" });

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

  updateDataset(dataset.id, {
    queriesServed: dataset.queriesServed + 1,
    totalEarned: parseFloat(
      (dataset.totalEarned + dataset.pricePerQuery * 0.95).toFixed(4),
    ),
  });

  addTransaction({
    id: `tx-demo-${uuidv4()}`,
    datasetId: dataset.id,
    txHash: `demo-${Date.now()}`,
    amount: dataset.pricePerQuery,
    buyerQuery: buyerQuestion,
    aiSummary: summary,
    timestamp: new Date().toISOString(),
  });

  return res.json({
    success: true,
    demo: true,
    data: dataset.data,
    ai: { summary, answer },
    transaction: {
      hash: `demo-${Date.now()}`,
      amount: dataset.pricePerQuery,
      sellerReceived: parseFloat((dataset.pricePerQuery * 0.95).toFixed(4)),
      platformFee: parseFloat((dataset.pricePerQuery * 0.05).toFixed(4)),
    },
  });
});
