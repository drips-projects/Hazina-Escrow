import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../../lib/contract.client', () => ({
  getEscrow: vi.fn(),
  releaseEscrow: vi.fn(),
  refundEscrow: vi.fn(),
  usdcToStroops: (usdc: number) => BigInt(Math.round(usdc * 10_000_000)),
}));

vi.mock('../stellar.service', () => ({
  verifyStellarPayment: vi.fn(),
}));

vi.mock('../../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
}));

vi.mock('../../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../common/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/storage')>();
  return {
    ...actual,
    getDataset: vi.fn(),
    txHashUsed: vi.fn(() => Promise.resolve(false)),
    addTransaction: vi.fn(() => Promise.resolve()),
    updateDataset: vi.fn(() => Promise.resolve()),
    updateTransactionByHash: vi.fn(() => Promise.resolve(null)),
    getUnpaidTransactions: vi.fn(() => Promise.resolve([])),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { paymentsRouter } from '../payments.router';
import { generateDataSummary } from '../../ai/claude.service';
import { getDataset, txHashUsed } from '../../common/storage';
import type { Dataset } from '../../common/storage';
import { verifyStellarPayment } from '../stellar.service';

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
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(txHashUsed).mockResolvedValue(false);
    vi.mocked(verifyStellarPayment).mockResolvedValue({ valid: true, actualAmount: 1, memo: 'haz' });
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Executive summary',
      answer: 'Buyer answer',
    });
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist')
      .send({ txHash: 'tx-missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('returns 400 when txHash is missing', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash is empty', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash was already used (replay attack)', async () => {
    vi.mocked(txHashUsed).mockResolvedValue(true);

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-used' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already processed');
  });

  it('returns 400 when Stellar verification fails', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValue({ valid: false, reason: 'Amount mismatch' });

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Amount mismatch');
  });

  it('returns 200 with data and AI summary on happy path', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-happy', buyerQuestion: 'What changed?' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toBe('Executive summary');
    expect(res.body.ai.answer).toBe('Buyer answer');
    expect(res.body.transaction.amount).toBe(1);
    expect(res.body.transaction.status).toBe('completed');
    expect(res.body.transaction.deliveryStatus).toBe('delivered');
    expect(verifyStellarPayment).toHaveBeenCalledWith({
      txHash: 'tx-happy',
      expectedAmount: 1,
      destinationAddress: SELLER_WALLET,
    });
  });

  it('returns 202 and records delivery failure when AI summary throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ txHash: 'tx-pending' });

    expect(res.status).toBe(202);
    expect(res.body.pendingDelivery).toBe(true);
    expect(res.body.warning).toBe('DELIVERY_PENDING_RETRY');
    expect(res.body.transaction.status).toBe('delivery_failed');
    expect(res.body.transaction.deliveryStatus).toBe('failed');
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
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Demo summary',
      answer: undefined,
    });
  });

  it('returns 200 with demo data', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1/demo')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.demo).toBe(true);
    expect(res.body.ai.summary).toBe('Demo summary');
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist/demo')
      .send({});

    expect(res.status).toBe(404);
  });

  it('returns 200 with fallback summary when AI throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app)
      .post('/api/verify/ds-test-1/demo')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ai.summary).toContain('Demo mode');
  });
});
