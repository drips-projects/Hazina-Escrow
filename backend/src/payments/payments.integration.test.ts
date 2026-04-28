import express, { Express } from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Store, writeStore } from '../common/storage';

vi.mock('./stellar.service', () => ({
  verifyStellarPayment: vi.fn(),
}));

vi.mock('../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
}));

vi.mock('../agent/agent.wallet', () => ({
  sendUsdcPayment: vi.fn(),
}));

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../agent/agent.service', () => ({
  runResearchAgent: vi.fn(),
  runResearchAgentDemo: vi.fn(),
}));

import { runResearchAgentDemo } from '../agent/agent.service';
import { generateDataSummary } from '../ai/claude.service';
import { sendUsdcPayment } from '../agent/agent.wallet';
import { agentRouter } from '../agent/agent.router';
import { paymentsRouter } from './payments.router';
import { verifyStellarPayment } from './stellar.service';

const DATA_PATH = path.join(__dirname, '../../../data/datasets.json');
const BACKUP_PATH = path.join(__dirname, '../../../data/datasets.json.payments.integration.bak');

const SELLER_WALLET = `G${'A'.repeat(55)}`;
const ESCROW_WALLET = `G${'B'.repeat(55)}`;

const BASE_STORE: Store = {
  datasets: [
    {
      id: 'ds-payment-1',
      name: 'USDC Yield Dataset',
      description: 'Yield opportunities',
      type: 'yield-data',
      pricePerQuery: 1,
      sellerWallet: SELLER_WALLET,
      data: { rows: [1, 2, 3] },
      queriesServed: 0,
      totalEarned: 0,
      createdAt: new Date().toISOString(),
    },
  ],
  transactions: [],
  webhooks: [],
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', paymentsRouter);
  app.use('/api/agent', agentRouter);
  return app;
}

const describeSocket = process.env.ALLOW_SOCKET_TESTS === '1' ? describe : describe.skip;

describeSocket('payments and agent integration routes', () => {
  let app: Express;

  beforeEach(async () => {
    if (fs.existsSync(DATA_PATH)) {
      fs.copyFileSync(DATA_PATH, BACKUP_PATH);
    }
    await writeStore(BASE_STORE);

    app = makeApp();
    process.env.ESCROW_WALLET = ESCROW_WALLET;
    process.env.ADMIN_API_KEY = 'admin-test-key';

    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: true,
      actualAmount: 1,
      memo: 'haz-test',
    });
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Executive summary',
      answer: 'Buyer answer',
    });
    vi.mocked(sendUsdcPayment).mockResolvedValue({
      txHash: 'seller-forwarded-tx',
      from: ESCROW_WALLET,
      to: SELLER_WALLET,
      amount: '0.9500000',
    });
    vi.mocked(runResearchAgentDemo).mockResolvedValue({
      jobId: 'job-demo-1',
      query: 'best low risk strategy',
      budget: 500,
      riskTolerance: 'low',
      humanTxHash: 'demo-agent-hash',
      agentWallet: 'demo-wallet',
      purchases: [],
      totalSpent: 0.14,
      agentProfit: 0.86,
      report: {
        topOpportunity: {
          protocol: 'Aave',
          vault: 'USDC Stable Pool',
          chain: 'Ethereum',
          apy: 7.2,
          riskLevel: 'Low',
          whaleConfidence: 'High',
          sentimentScore: 'Bullish',
        },
        reasoning: 'Reasoning text',
        alternatives: ['Alt 1', 'Alt 2'],
        warnings: ['none'],
        rawAnalysis: 'Raw analysis text',
      },
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_WALLET;
    delete process.env.ADMIN_API_KEY;

    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, DATA_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
  });

  it('POST /api/query/:id returns 404 for unknown dataset', async () => {
    const response = await request(app).post('/api/query/does-not-exist').send({});
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Dataset not found');
  });

  it('POST /api/query/:id returns 402 for known dataset', async () => {
    const response = await request(app).post('/api/query/ds-payment-1').send({});
    expect(response.status).toBe(402);
    expect(response.body.x402).toBe(true);
    expect(response.body.payment.amount).toBe(1);
  });

  it('POST /api/verify/:id handles happy path', async () => {
    const response = await request(app).post('/api/verify/ds-payment-1').send({
      txHash: 'tx-happy-path',
      buyerQuestion: 'What changed?',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.ai.summary).toBe('Executive summary');
    expect(response.body.ai.answer).toBe('Buyer answer');
    expect(response.body.transaction.sellerReceived).toBe(0.95);
    expect(response.body.transaction.sellerPaid).toBe(true);
    expect(response.body.warning).toBeNull();

    expect(verifyStellarPayment).toHaveBeenCalledWith({
      txHash: 'tx-happy-path',
      expectedAmount: 1,
      destinationAddress: ESCROW_WALLET,
    });
    expect(sendUsdcPayment).toHaveBeenCalledTimes(1);
  });

  it('POST /api/verify/:id rejects replayed transaction hash', async () => {
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-replay',
          datasetId: 'ds-payment-1',
          txHash: 'tx-replayed',
          amount: 1,
          sellerPaid: true,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const response = await request(app).post('/api/verify/ds-payment-1').send({
      txHash: 'tx-replayed',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('already used');
    expect(verifyStellarPayment).not.toHaveBeenCalled();
  });

  it('POST /api/verify/:id rejects wrong amount', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({
      valid: false,
      reason: 'Amount mismatch: expected 1 USDC, received 0.7 USDC',
      actualAmount: 0.7,
    });

    const response = await request(app).post('/api/verify/ds-payment-1').send({
      txHash: 'tx-wrong-amount',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Amount mismatch');
  });

  it('POST /api/verify/:id rejects expired transaction', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({
      valid: false,
      reason: 'Transaction expired (older than 5 minutes)',
    });

    const response = await request(app).post('/api/verify/ds-payment-1').send({
      txHash: 'tx-expired',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('expired');
  });

  it('POST /api/verify/:id records failed seller payouts for reconciliation', async () => {
    vi.mocked(sendUsdcPayment).mockRejectedValueOnce(new Error('Agent wallet balance too low'));

    const response = await request(app).post('/api/verify/ds-payment-1').send({
      txHash: 'tx-payout-failed',
      buyerQuestion: 'What changed?',
    });

    expect(response.status).toBe(200);
    expect(response.body.warning).toBe('SELLER_PAYOUT_PENDING');
    expect(response.body.transaction.sellerPaid).toBe(false);
    expect(response.body.transaction.sellerReceived).toBe(0);
    expect(response.body.transaction.sellerTxHash).toBeNull();

    const store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')) as Store;
    expect(store.datasets[0]?.totalEarned).toBe(0);
    expect(store.transactions).toEqual([
      expect.objectContaining({
        txHash: 'tx-payout-failed',
        sellerPaid: false,
        sellerAmount: 0.95,
        sellerPayoutError: 'Agent wallet balance too low',
      }),
    ]);
  });

  it('GET /api/admin/unpaid-sellers returns failed seller payouts', async () => {
    writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-unpaid-1',
          datasetId: 'ds-payment-1',
          txHash: 'tx-unpaid-1',
          amount: 1,
          sellerPaid: false,
          sellerAmount: 0.95,
          sellerPayoutError: 'network timeout',
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const response = await request(app)
      .get('/api/admin/unpaid-sellers')
      .set('Authorization', 'Bearer admin-test-key');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.unpaidTransactions).toEqual([
      expect.objectContaining({
        txHash: 'tx-unpaid-1',
        sellerPaid: false,
        sellerPayoutError: 'network timeout',
        datasetName: 'USDC Yield Dataset',
        sellerWallet: SELLER_WALLET,
      }),
    ]);
  });

  it('POST /api/agent/research/demo returns a valid report shape', async () => {
    const response = await request(app).post('/api/agent/research/demo').send({
      query: 'best low risk strategy',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.demo).toBe(true);
    expect(response.body.report).toMatchObject({
      topOpportunity: {
        protocol: expect.any(String),
        vault: expect.any(String),
        chain: expect.any(String),
        apy: expect.any(Number),
        riskLevel: expect.any(String),
        whaleConfidence: expect.any(String),
        sentimentScore: expect.any(String),
      },
      reasoning: expect.any(String),
      alternatives: expect.any(Array),
      warnings: expect.any(Array),
      rawAnalysis: expect.any(String),
    });
  });
});
