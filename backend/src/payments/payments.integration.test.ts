import express, { Express } from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Store, writeStore } from '../common/storage';

vi.mock('./stellar.service', () => ({
  verifyStellarPayment: vi.fn(() => Promise.resolve({ valid: true, actualAmount: 1, memo: 'haz' })),
}));

vi.mock('../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
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
import { verifyStellarPayment } from './stellar.service';
import { agentRouter } from '../agent/agent.router';
import { paymentsRouter } from './payments.router';

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
    if (fs.existsSync(DATA_PATH)) fs.copyFileSync(DATA_PATH, BACKUP_PATH);
    await writeStore(BASE_STORE);
    app = makeApp();
    process.env.ESCROW_WALLET = ESCROW_WALLET;
    process.env.ADMIN_API_KEY = 'admin-test-key';
    vi.mocked(generateDataSummary).mockResolvedValue({ summary: 'Executive summary', answer: 'Buyer answer' });
    vi.mocked(runResearchAgentDemo).mockResolvedValue({
      jobId: 'job-demo-1', query: 'best low risk strategy', budget: 500, riskTolerance: 'low',
      humanTxHash: 'demo-agent-hash', agentWallet: 'demo-wallet', purchases: [],
      totalSpent: 0.14, agentProfit: 0.86,
      report: {
        topOpportunity: { protocol: 'Aave', vault: 'USDC Stable Pool', chain: 'Ethereum', apy: 7.2, riskLevel: 'Low', whaleConfidence: 'High', sentimentScore: 'Bullish' },
        reasoning: 'Reasoning text', alternatives: ['Alt 1', 'Alt 2'], warnings: ['none'], rawAnalysis: 'Raw analysis text',
      },
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_WALLET;
    delete process.env.ADMIN_API_KEY;
    if (fs.existsSync(BACKUP_PATH)) { fs.copyFileSync(BACKUP_PATH, DATA_PATH); fs.unlinkSync(BACKUP_PATH); }
  });

  it('POST /api/query/:id returns 404 for unknown dataset', async () => {
    const r = await request(app).post('/api/query/does-not-exist').send({});
    expect(r.status).toBe(404);
  });

  it('POST /api/query/:id returns 402 for known dataset', async () => {
    const r = await request(app).post('/api/query/ds-payment-1').send({});
    expect(r.status).toBe(402);
    expect(r.body.x402).toBe(true);
    expect(r.body.payment.amount).toBe(1);
  });

  it('POST /api/verify/:id handles happy path', async () => {
    const r = await request(app).post('/api/verify/ds-payment-1').send({ txHash: 'tx-happy', buyerQuestion: 'What changed?' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.ai.summary).toBe('Executive summary');
    expect(r.body.transaction.status).toBe('completed');
    expect(r.body.transaction.deliveryStatus).toBe('delivered');
    expect(r.body.warning).toBeNull();
    expect(verifyStellarPayment).toHaveBeenCalledWith({
      txHash: 'tx-happy',
      expectedAmount: 1,
      destinationAddress: ESCROW_WALLET,
    });
  });

  it('POST /api/verify/:id rejects replayed transaction hash', async () => {
    await writeStore({ ...BASE_STORE, transactions: [{ id: 'tx-1', datasetId: 'ds-payment-1', txHash: 'tx-used', amount: 1, sellerPaid: true, timestamp: new Date().toISOString() }] });
    const r = await request(app).post('/api/verify/ds-payment-1').send({ txHash: 'tx-used' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('already processed');
  });

  it('POST /api/verify/:id rejects wrong amount', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({ valid: false, reason: 'Amount mismatch' });
    const r = await request(app).post('/api/verify/ds-payment-1').send({ txHash: 'tx-wrong-amount' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Amount mismatch');
  });

  it('POST /api/verify/:id rejects expired transaction', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({ valid: false, reason: 'Transaction expired' });
    const r = await request(app).post('/api/verify/ds-payment-1').send({ txHash: 'tx-expired' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('expired');
  });

  it('POST /api/verify/:id records failed seller payouts for reconciliation', async () => {
    vi.mocked(generateDataSummary).mockRejectedValueOnce(new Error('Claude unavailable'));
    const r = await request(app).post('/api/verify/ds-payment-1').send({ txHash: 'tx-pending' });
    expect(r.status).toBe(202);
    expect(r.body.pendingDelivery).toBe(true);
    expect(r.body.warning).toBe('DELIVERY_PENDING_RETRY');
    expect(r.body.transaction.deliveryStatus).toBe('failed');
  });

  it('GET /api/admin/unpaid-sellers returns failed seller payouts', async () => {
    await writeStore({ ...BASE_STORE, transactions: [{ id: 'tx-unpaid-1', datasetId: 'ds-payment-1', txHash: 'escrow-99', amount: 1, sellerPaid: false, sellerAmount: 0.95, timestamp: new Date().toISOString() }] });
    const r = await request(app).get('/api/admin/unpaid-sellers').set('Authorization', 'Bearer admin-test-key');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.unpaidTransactions[0]).toMatchObject({ txHash: 'escrow-99', sellerPaid: false, datasetName: 'USDC Yield Dataset', sellerWallet: SELLER_WALLET });
  });

  it('POST /api/agent/research/demo returns a valid report shape', async () => {
    const r = await request(app).post('/api/agent/research/demo').send({ query: 'best low risk strategy' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.demo).toBe(true);
    expect(r.body.report.topOpportunity.protocol).toBeDefined();
  });
});
