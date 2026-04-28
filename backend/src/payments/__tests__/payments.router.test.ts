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
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { paymentsRouter } from '../payments.router';
import { getEscrow, releaseEscrow, refundEscrow } from '../../lib/contract.client';
import { generateDataSummary } from '../../ai/claude.service';
import { getDataset, txHashUsed } from '../../common/storage';
import type { Dataset } from '../../common/storage';
import type { EscrowRecord } from '../../lib/contract.client';

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

const VALID_ESCROW: EscrowRecord = {
  escrow_id: BigInt(42),
  dataset_id: 'ds-test-1',
  buyer: 'GBUYER',
  seller: SELLER_WALLET,
  amount: BigInt(10_000_000), // 1 USDC in stroops
  released: false,
  refunded: false,
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
    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: true,
      actualAmount: 1,
      memo: 'haz-test',
    });
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Executive summary',
      answer: 'Buyer answer',
    });
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist')
      .send({ escrowId: 42 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('returns 400 when escrowId is missing', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when escrowId is not a number', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 'not-a-number' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash was already used (replay attack)', async () => {
    vi.mocked(txHashUsed).mockResolvedValue(true);

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already processed');
    expect(getEscrow).not.toHaveBeenCalled();
  });

  it('returns 400 when escrow is not found on contract', async () => {
    vi.mocked(getEscrow).mockRejectedValue(new Error('Escrow not found'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found on contract');
  });

  it('returns 400 when escrow amount is too low', async () => {
    vi.mocked(getEscrow).mockResolvedValue({
      ...VALID_ESCROW,
      amount: BigInt(100), // way below 1 USDC
    });

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('too low');
  });

  it('returns 200 with data and AI summary on happy path', async () => {
    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 42, buyerQuestion: 'What changed?' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toBe('Executive summary');
    expect(res.body.ai.answer).toBe('Buyer answer');
    expect(res.body.transaction.amount).toBe(1);
    expect(res.body.transaction.sellerReceived).toBe(0.95);
    expect(res.body.transaction.platformFee).toBeCloseTo(0.05, 4);
    expect(res.body.transaction.releaseTxHash).toBe('release-tx-hash');
    expect(getEscrow).toHaveBeenCalledWith(42);
  });

  it('returns 500 and refunds when AI summary throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 42 });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('AI processing failed');
    expect(refundEscrow).toHaveBeenCalledWith(42);
  });

  it('still returns 200 when release fails after AI succeeds', async () => {
    vi.mocked(releaseEscrow).mockRejectedValue(new Error('Stellar network error'));

    const res = await request(app)
      .post('/api/verify/ds-test-1')
      .send({ escrowId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transaction.releaseTxHash).toBeNull();
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
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/verify/does-not-exist/demo')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('does not call getEscrow or releaseEscrow', async () => {
    await request(app).post('/api/verify/ds-test-1/demo').send({});

    expect(getEscrow).not.toHaveBeenCalled();
    expect(releaseEscrow).not.toHaveBeenCalled();
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
    vi.mocked(getDataset).mockResolvedValue(DATASET);
  });

  it('returns 402 Payment Required for a known dataset', async () => {
    const res = await request(app).post('/api/query/ds-test-1').send({});

    expect(res.status).toBe(402);
    expect(res.body.x402).toBe(true);
    expect(res.body.payment.amount).toBe(1);
    expect(res.body.payment.currency).toBe('USDC');
  });

  it('returns 404 for an unknown dataset', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app).post('/api/query/does-not-exist').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });
});
