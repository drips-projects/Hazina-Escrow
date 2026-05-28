import { promises as fs, existsSync } from 'fs';
import path from 'path';

const DATA_PATH = path.join(__dirname, '../../../data/datasets.json');

export interface Dataset {
  id: string;
  name: string;
  description: string;
  type: string;
  pricePerQuery: number;
  sellerWallet: string;
  data: Record<string, unknown>;
  queriesServed: number;
  totalEarned: number;
  createdAt: string;
}

export interface Transaction {
  id: string;
  datasetId: string;
  txHash: string;
  memo?: string;
  amount: number;
  status?: 'pending' | 'verifying' | 'verified' | 'completed' | 'failed' | 'refunded' | 'delivery_failed';
  deliveryStatus?: 'pending' | 'delivered' | 'failed';
  sellerPaid?: boolean;
  sellerAmount?: number;
  sellerTxHash?: string;
  buyerQuery?: string;
  aiSummary?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  verifiedAt?: string;
  deliveredAt?: string;
  timestamp: string;
}

export type WebhookEvent =
  | 'payment.received'
  | 'payment.forwarded'
  | 'dataset.queried'
  | 'dataset.created'
  | 'ping';

export interface WebhookSubscription {
  id: string;
  sellerWallet: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
}

export interface Store {
  datasets: Dataset[];
  transactions: Transaction[];
  webhooks: WebhookSubscription[];
  payoutFailures: PayoutFailure[];
}

export type PayoutFailureStatus = 'pending_retry' | 'manual_review_needed' | 'paid';

export interface PayoutFailure {
  id: string;
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  intendedAmount: number;
  sellerTxHash?: string;
  status: PayoutFailureStatus;
  retryCount: number;
  nextRetryAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

function ensureStore(): Store {
  if (!fs.existsSync(DATA_PATH)) {
    const empty: Store = { datasets: [], transactions: [], webhooks: [], payoutFailures: [] };
    fs.writeFileSync(DATA_PATH, JSON.stringify(empty, null, 2), 'utf-8');
// Serialize all mutations to prevent concurrent read-modify-write data loss
let mutationQueue: Promise<void> = Promise.resolve();

// In-memory set to block replay of hashes that are mid-flight (not yet persisted)
const pendingTxHashes = new Set<string>();

async function readRaw(): Promise<Store> {
  if (!existsSync(DATA_PATH)) {
    const empty: Store = { datasets: [], transactions: [], webhooks: [] };
    await fs.writeFile(DATA_PATH, JSON.stringify(empty, null, 2), 'utf-8');
    return empty;
  }
  const raw = await fs.readFile(DATA_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Store>;
  if (!parsed.webhooks) parsed.webhooks = [];
  if (!parsed.payoutFailures) parsed.payoutFailures = [];
  return parsed as Store;
}

export async function readStore(): Promise<Store> {
  return readRaw();
}

export async function writeStore(store: Store): Promise<void> {
  // Enqueue so concurrent external writes don't interleave
  mutationQueue = mutationQueue.then(() =>
    fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), 'utf-8'),
  );
  return mutationQueue;
}

// Runs fn inside the serialized queue. fn receives the current store and must
// return the (possibly mutated) store to persist, plus an optional result.
function enqueue<T>(fn: (store: Store) => Promise<[Store, T]>): Promise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      const store = await readRaw();
      const [updated, value] = await fn(store);
      await fs.writeFile(DATA_PATH, JSON.stringify(updated, null, 2), 'utf-8');
      resolve(value);
    } catch (err) {
      reject(err);
    }
  });
  return result;
}

export async function getDataset(id: string): Promise<Dataset | undefined> {
  return (await readStore()).datasets.find(d => d.id === id);
}

export async function getAllDatasets(): Promise<Dataset[]> {
  return (await readStore()).datasets;
}

export async function updateDataset(
  id: string,
  updates: Partial<Dataset>,
): Promise<Dataset | null> {
  return enqueue(async store => {
    const idx = store.datasets.findIndex(d => d.id === id);
    if (idx === -1) return [store, null];
    store.datasets[idx] = { ...store.datasets[idx], ...updates };
    return [store, store.datasets[idx]];
  });
}

export async function addDataset(dataset: Dataset): Promise<void> {
  return enqueue(async store => {
    store.datasets.push(dataset);
    return [store, undefined];
  });
}

export async function addTransaction(tx: Transaction): Promise<void> {
  if (tx.txHash) pendingTxHashes.add(tx.txHash);
  return enqueue(async store => {
    store.transactions.push(tx);
    return [store, undefined];
  }).finally(() => {
    if (tx.txHash) pendingTxHashes.delete(tx.txHash);
  });
}

export async function getTransactionByHash(txHash: string): Promise<Transaction | undefined> {
  return (await readStore()).transactions.find(tx => tx.txHash === txHash);
}

export async function getTransactionByMemo(memo: string): Promise<Transaction | undefined> {
  return (await readStore()).transactions.find(tx => tx.memo === memo);
}

export async function updateTransactionByHash(
  txHash: string,
  updates: Partial<Transaction>,
): Promise<Transaction | null> {
  return enqueue(async store => {
    const idx = store.transactions.findIndex(tx => tx.txHash === txHash);
    if (idx === -1) return [store, null];
    store.transactions[idx] = { ...store.transactions[idx], ...updates };
    return [store, store.transactions[idx]];
  });
}

export async function updateTransactionByMemo(
  memo: string,
  updates: Partial<Transaction>,
): Promise<Transaction | null> {
  return enqueue(async store => {
    const idx = store.transactions.findIndex(tx => tx.memo === memo);
    if (idx === -1) return [store, null];
    store.transactions[idx] = { ...store.transactions[idx], ...updates };
    return [store, store.transactions[idx]];
  });
}

export async function getTransactions(
  datasetId?: string,
  limit?: number,
  offset?: number,
): Promise<Transaction[]> {
  const store = await readStore();
  let transactions = datasetId
    ? store.transactions.filter(t => t.datasetId === datasetId)
    : store.transactions;

  if (offset !== undefined && offset > 0) {
    transactions = transactions.slice(offset);
  }

  if (limit !== undefined && limit > 0) {
    transactions = transactions.slice(0, limit);
  }

  return transactions;
}

export async function getTransactionsCount(datasetId?: string): Promise<number> {
  const store = await readStore();
  return datasetId
    ? store.transactions.filter(t => t.datasetId === datasetId).length
    : store.transactions.length;
}

export async function getFailedDeliveryTransactions(): Promise<Transaction[]> {
  const store = await readStore();
  return store.transactions.filter(tx => tx.deliveryStatus === 'failed');
}

export async function txHashUsed(txHash: string): Promise<boolean> {
  if (!txHash) return false;
  if (pendingTxHashes.has(txHash)) return true;
  return (await readStore()).transactions.some(t => t.txHash === txHash);
}

/* ------------------------------------------------------------------ */
/*  Webhooks                                                           */
/* ------------------------------------------------------------------ */

export async function getAllWebhooks(): Promise<WebhookSubscription[]> {
  return (await readStore()).webhooks;
}

export async function getWebhooksForSeller(sellerWallet: string): Promise<WebhookSubscription[]> {
  return (await readStore()).webhooks.filter(w => w.sellerWallet === sellerWallet && w.active);
}

export async function getWebhookById(id: string): Promise<WebhookSubscription | undefined> {
  return (await readStore()).webhooks.find(w => w.id === id);
}

export async function addWebhook(webhook: WebhookSubscription): Promise<void> {
  return enqueue(async store => {
    store.webhooks.push(webhook);
    return [store, undefined];
  });
}

export async function removeWebhook(id: string): Promise<boolean> {
  return enqueue(async store => {
    const idx = store.webhooks.findIndex(w => w.id === id);
    if (idx === -1) return [store, false];
    store.webhooks.splice(idx, 1);
    return [store, true];
  });
}

export async function updateWebhook(
  id: string,
  updates: Partial<WebhookSubscription>,
): Promise<WebhookSubscription | null> {
  return enqueue(async store => {
    const idx = store.webhooks.findIndex(w => w.id === id);
    if (idx === -1) return [store, null];
    store.webhooks[idx] = { ...store.webhooks[idx], ...updates };
    return [store, store.webhooks[idx]];
  });
}

export function addPayoutFailure(payoutFailure: PayoutFailure): void {
  const store = readStore();
  store.payoutFailures.push(payoutFailure);
  writeStore(store);
}

export function getPayoutFailureByBuyerTxHash(buyerTxHash: string): PayoutFailure | undefined {
  return readStore().payoutFailures.find((f) => f.buyerTxHash === buyerTxHash);
}

export function updatePayoutFailure(
  id: string,
  updates: Partial<PayoutFailure>,
): PayoutFailure | null {
  const store = readStore();
  const idx = store.payoutFailures.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  store.payoutFailures[idx] = { ...store.payoutFailures[idx], ...updates };
  writeStore(store);
  return store.payoutFailures[idx];
}

export function getPayoutFailuresByStatus(status: PayoutFailureStatus): PayoutFailure[] {
  return readStore().payoutFailures.filter((f) => f.status === status);
}

export function getPendingPayoutFailures(nowIso: string): PayoutFailure[] {
  const now = new Date(nowIso).getTime();
  return readStore().payoutFailures.filter(
    (f) => f.status === 'pending_retry' && new Date(f.nextRetryAt).getTime() <= now,
  );
}

export async function getUnpaidTransactions(): Promise<Transaction[]> {
  const store = await readStore();
  return store.transactions.filter(t => t.sellerPaid === false);
}
