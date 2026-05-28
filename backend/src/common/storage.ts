import fs from 'fs';
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
  amount: number;
  buyerQuery?: string;
  aiSummary?: string;
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
    return empty;
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Store>;
  if (!parsed.webhooks) parsed.webhooks = [];
  if (!parsed.payoutFailures) parsed.payoutFailures = [];
  return parsed as Store;
}

export function readStore(): Store {
  return ensureStore();
}

export function writeStore(store: Store): void {
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export function getDataset(id: string): Dataset | undefined {
  return readStore().datasets.find((d) => d.id === id);
}

export function getAllDatasets(): Dataset[] {
  return readStore().datasets;
}

export function updateDataset(id: string, updates: Partial<Dataset>): Dataset | null {
  const store = readStore();
  const idx = store.datasets.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  store.datasets[idx] = { ...store.datasets[idx], ...updates };
  writeStore(store);
  return store.datasets[idx];
}

export function addDataset(dataset: Dataset): void {
  const store = readStore();
  store.datasets.push(dataset);
  writeStore(store);
}

export function addTransaction(tx: Transaction): void {
  const store = readStore();
  store.transactions.push(tx);
  writeStore(store);
}

export function getTransactions(datasetId?: string, limit?: number, offset?: number): Transaction[] {
  const store = readStore();
  let transactions = datasetId ? store.transactions.filter((t) => t.datasetId === datasetId) : store.transactions;
  
  if (offset !== undefined && offset > 0) {
    transactions = transactions.slice(offset);
  }
  
  if (limit !== undefined && limit > 0) {
    transactions = transactions.slice(0, limit);
  }
  
  return transactions;
}

export function getTransactionsCount(datasetId?: string): number {
  const store = readStore();
  return datasetId ? store.transactions.filter((t) => t.datasetId === datasetId).length : store.transactions.length;
}

export function txHashUsed(txHash: string): boolean {
  return readStore().transactions.some((t) => t.txHash === txHash);
}

/* ------------------------------------------------------------------ */
/*  Webhooks                                                           */
/* ------------------------------------------------------------------ */

export function getAllWebhooks(): WebhookSubscription[] {
  return readStore().webhooks;
}

export function getWebhooksForSeller(sellerWallet: string): WebhookSubscription[] {
  return readStore().webhooks.filter((w) => w.sellerWallet === sellerWallet && w.active);
}

export function getWebhookById(id: string): WebhookSubscription | undefined {
  return readStore().webhooks.find((w) => w.id === id);
}

export function addWebhook(webhook: WebhookSubscription): void {
  const store = readStore();
  store.webhooks.push(webhook);
  writeStore(store);
}

export function removeWebhook(id: string): boolean {
  const store = readStore();
  const idx = store.webhooks.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  store.webhooks.splice(idx, 1);
  writeStore(store);
  return true;
}

export function updateWebhook(id: string, updates: Partial<WebhookSubscription>): WebhookSubscription | null {
  const store = readStore();
  const idx = store.webhooks.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  store.webhooks[idx] = { ...store.webhooks[idx], ...updates };
  writeStore(store);
  return store.webhooks[idx];
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

