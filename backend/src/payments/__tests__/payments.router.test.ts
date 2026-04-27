import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../stellar.service', () => ({
  verifyStellarPayment: vi.fn(),
}));

vi.mock('../../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
}));

vi.mock('../../agent/agent.wallet', () => ({
  sendUsdcPayment: vi.fn(),
}));

vi.mock('../../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../common/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/storage')>();
  return {
    ...actual,
    getDataset: vi.fn(),
    txHashUsed: vi.fn(() => false),
    addTransaction: vi.fn(),
    updateDataset: vi.fn(),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { paymentsRouter } from '../payments.router';
import { verifyStellarPayment } from '../stellar.service';
import { generateDataSummary } from '../../ai/claude.service';
import { sendUsdcPayment } from '../../agent/agent.wallet';
import { getDataset, txHashUsed } from '../../common/storage';
import type { Dataset } from '../../common/storage';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_WALLET = `G${'A'.repeat(55)}`;

const DATASET: Dataset = {
  id: 'ds-test-1',
  name: 'Test Dataset',
  description: 'A test dataset',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER_WALLET,
  data: { rows: [1, 2, 3] },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', paymentsRouter);
  return app;
}

// ── Tests: POST /api/verify/:id ──────────────────────────────────────────────

describe('POST /api/verify/:id', () => {
  let app: Express;

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockReturnValue(DATASET);
    vi.mocked(txHashUsed).mockReturnValue(false);
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
      txHash: 'seller-tx-hash',
      from: 'GESCROW',
      to: SELLER_WALLET,
      amount: '0.9500000',
    });
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockReturnValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist')
      .send({ txHash: 'tx-abc123' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('returns 400 when txHash is missing', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash is an empty string', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash was already used (replay attack)', async () => {
    vi.mocked(txHashUsed).mockReturnValue(true);

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-replayed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already used');
    expect(verifyStellarPayment).not.toHaveBeenCalled();
  });

  it('returns 400 when Stellar payment verification fails', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: false,
      reason: 'Amount mismatch: expected 1 USDC, received 0.5 USDC',
      actualAmount: 0.5,
    });

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-wrong-amount' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Amount mismatch');
  });

  it('returns 400 when transaction is expired', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: false,
      reason: 'Transaction expired (older than 5 minutes)',
    });

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-expired' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('expired');
  });

  it('returns 200 with data and AI summary on happy path', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-valid', buyerQuestion: 'What changed?' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toBe('Executive summary');
    expect(res.body.ai.answer).toBe('Buyer answer');
    expect(res.body.transaction.amount).toBe(1);
    expect(res.body.transaction.sellerReceived).toBe(0.95);
    expect(res.body.transaction.platformFee).toBeCloseTo(0.05, 4);
    expect(verifyStellarPayment).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: 'tx-valid', expectedAmount: 1 }),
    );
  });

  it('delivers data even when AI summary throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-ai-fail' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toContain('AI summary temporarily unavailable');
  });

  it('delivers data even when seller payment forwarding fails', async () => {
    vi.mocked(sendUsdcPayment).mockRejectedValue(new Error('Stellar network error'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-seller-fail' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transaction.sellerTxHash).toBeNull();
  });
});

// ── Tests: POST /api/verify/:id/demo ────────────────────────────────────────

describe('POST /api/verify/:id/demo', () => {
  let app: Express;

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockReturnValue(DATASET);
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Demo summary',
      answer: undefined,
    });
  });

  it('returns 200 with demo: true for a known dataset', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1/demo')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.demo).toBe(true);
    expect(res.body.ai.summary).toBe('Demo summary');
  });

  it('returns 404 for an unknown dataset', async () => {
    vi.mocked(getDataset).mockReturnValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist/demo')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('does not call verifyStellarPayment or sendUsdcPayment', async () => {
    await request(app).post('/api/verify/ds-test-1/demo').send({});

    expect(verifyStellarPayment).not.toHaveBeenCalled();
    expect(sendUsdcPayment).not.toHaveBeenCalled();
  });

  it('includes correct fee split in the response', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1/demo')
      .send({});

    expect(res.body.transaction.sellerReceived).toBeCloseTo(0.95, 4);
    expect(res.body.transaction.platformFee).toBeCloseTo(0.05, 4);
  });

  it('returns 200 with fallback summary when AI throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app)
      .post('/api/verify/ds-test-1/demo')
      .send({});

    // Demo route handles AI failures gracefully — buyer still gets a response
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toContain('unavailable');
  });
});

// ── Tests: POST /api/query/:id ───────────────────────────────────────────────

describe('POST /api/query/:id', () => {
  let app: Express;

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockReturnValue(DATASET);
  });

  it('returns 402 Payment Required for a known dataset', async () => {
    const res = await request(app).post('/api/query/ds-test-1').send({});

    expect(res.status).toBe(402);
    expect(res.body.x402).toBe(true);
    expect(res.body.payment.amount).toBe(1);
    expect(res.body.payment.currency).toBe('USDC');
  });

  it('returns 404 for an unknown dataset', async () => {
    vi.mocked(getDataset).mockReturnValue(undefined);

    const res = await request(app).post('/api/query/does-not-exist').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });
});
