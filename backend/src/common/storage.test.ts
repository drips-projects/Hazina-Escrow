import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  addTransaction,
  readStore,
  txHashUsed,
  updateDataset,
  writeStore,
  type Dataset,
  type Store,
  type Transaction,
} from './storage';

const DATA_PATH = path.join(__dirname, '../../../data/datasets.json');
const BACKUP_PATH = path.join(__dirname, '../../../data/datasets.json.storage.test.bak');

const FIXTURE_DATASET: Dataset = {
  id: 'ds-storage-test',
  name: 'Storage Fixture Dataset',
  description: 'Fixture dataset for storage tests',
  type: 'yield-data',
  pricePerQuery: 0.05,
  sellerWallet: `G${'A'.repeat(55)}`,
  data: { rows: 1 },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
};

async function seedStore(overrides?: Partial<Store>): Promise<void> {
  const base: Store = {
    datasets: [FIXTURE_DATASET],
    transactions: [],
    webhooks: [],
    payoutFailures: [],
  };
  await writeStore({
    ...base,
    ...overrides,
  });
}

describe('storage', () => {
  beforeEach(async () => {
    if (fs.existsSync(DATA_PATH)) {
      fs.copyFileSync(DATA_PATH, BACKUP_PATH);
    }
    await seedStore();
  });

  afterEach(() => {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, DATA_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
  });

  it('txHashUsed returns true only for existing hashes', async () => {
    const existingTx: Transaction = {
      id: 'tx-existing',
      datasetId: FIXTURE_DATASET.id,
      txHash: 'tx-hash-existing',
      amount: FIXTURE_DATASET.pricePerQuery,
      timestamp: new Date().toISOString(),
    };
    await seedStore({ transactions: [existingTx] });

    expect(await txHashUsed('tx-hash-existing')).toBe(true);
    expect(await txHashUsed('tx-hash-missing')).toBe(false);
  });

  it('updateDataset updates and persists fields', async () => {
    const updated = await updateDataset(FIXTURE_DATASET.id, {
      queriesServed: 3,
      totalEarned: 1.425,
    });

    expect(updated).not.toBeNull();
    expect(updated?.queriesServed).toBe(3);
    expect(updated?.totalEarned).toBe(1.425);

    const persisted = (await readStore()).datasets.find((d) => d.id === FIXTURE_DATASET.id);
    expect(persisted?.queriesServed).toBe(3);
    expect(persisted?.totalEarned).toBe(1.425);
  });

  it('updateDataset returns null for unknown dataset ids', async () => {
    const updated = await updateDataset('ds-does-not-exist', { queriesServed: 99 });
    expect(updated).toBeNull();
  });

  it('keeps all transactions under rapid write bursts', async () => {
    const writes = Array.from({ length: 25 }, (_, idx) =>
      addTransaction({
        id: `tx-${idx}`,
        datasetId: FIXTURE_DATASET.id,
        txHash: `hash-${idx}`,
        amount: 0.01,
        timestamp: new Date().toISOString(),
      }),
    );

    await Promise.all(writes);

    const txs = (await readStore()).transactions;
    expect(txs).toHaveLength(25);
    expect(new Set(txs.map((tx) => tx.txHash)).size).toBe(25);
  });
});
