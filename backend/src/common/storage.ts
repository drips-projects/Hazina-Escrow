import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
import db from '../db/client';
import { datasets, transactions, webhooks } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';

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
  sellerPaid: boolean;
  sellerAmount?: number;
  sellerTxHash?: string;
  sellerPayoutError?: string;
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
}

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
  const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
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
  return (await readStore()).datasets.find((d) => d.id === id);
}

export async function getAllDatasets(): Promise<Dataset[]> {
  return (await readStore()).datasets;
}

export async function updateDataset(id: string, updates: Partial<Dataset>): Promise<Dataset | null> {
  return enqueue(async (store) => {
    const idx = store.datasets.findIndex((d) => d.id === id);
    if (idx === -1) return [store, null];
    store.datasets[idx] = { ...store.datasets[idx], ...updates };
    return [store, store.datasets[idx]];
  });
}

export async function addDataset(dataset: Dataset): Promise<void> {
  return enqueue(async (store) => {
    store.datasets.push(dataset);
    return [store, undefined];
  });
}

export async function addTransaction(tx: Transaction): Promise<void> {
  pendingTxHashes.add(tx.txHash);
  return enqueue(async (store) => {
    store.transactions.push(tx);
    return [store, undefined];
  }).finally(() => {
    pendingTxHashes.delete(tx.txHash);
  });
}

export async function getTransactions(datasetId?: string, limit?: number, offset?: number): Promise<Transaction[]> {
  const store = await readStore();
  let transactions = datasetId ? store.transactions.filter((t) => t.datasetId === datasetId) : store.transactions;

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
  return datasetId ? store.transactions.filter((t) => t.datasetId === datasetId).length : store.transactions.length;
}

export async function txHashUsed(txHash: string): Promise<boolean> {
  if (pendingTxHashes.has(txHash)) return true;
  return (await readStore()).transactions.some((t) => t.txHash === txHash);
export async function getDataset(id: string): Promise<Dataset | undefined> {
  const result = await db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
  if (!result.length) return undefined;

  const row = result[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    pricePerQuery: Number.parseFloat(row.pricePerQuery as string),
    sellerWallet: row.sellerWallet,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    queriesServed: row.queriesServed,
    totalEarned: Number.parseFloat(row.totalEarned as string),
    createdAt: row.createdAt,
  };
}

export async function getAllDatasets(): Promise<Dataset[]> {
  const results = await db
    .select()
    .from(datasets)
    .orderBy(sql`created_at DESC`);

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    pricePerQuery: Number.parseFloat(row.pricePerQuery as string),
    sellerWallet: row.sellerWallet,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    queriesServed: row.queriesServed,
    totalEarned: Number.parseFloat(row.totalEarned as string),
    createdAt: row.createdAt,
  }));
}

export async function updateDataset(id: string, updates: Partial<Dataset>): Promise<Dataset | null> {
  if (Object.keys(updates).length === 0) {
    return (await getDataset(id)) ?? null;
  }

  const updateData: Record<string, any> = {};

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.type !== undefined) updateData.type = updates.type;
  if (updates.pricePerQuery !== undefined)
    updateData.pricePerQuery = updates.pricePerQuery.toString();
  if (updates.sellerWallet !== undefined) updateData.sellerWallet = updates.sellerWallet;
  if (updates.data !== undefined) updateData.data = JSON.stringify(updates.data);
  if (updates.queriesServed !== undefined) updateData.queriesServed = updates.queriesServed;
  if (updates.totalEarned !== undefined)
    updateData.totalEarned = updates.totalEarned.toString();
  if (updates.createdAt !== undefined) updateData.createdAt = updates.createdAt;

  const result = await db
    .update(datasets)
    .set(updateData)
    .where(eq(datasets.id, id))
    .returning();

  if (!result.length) return null;

  const row = result[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    pricePerQuery: Number.parseFloat(row.pricePerQuery as string),
    sellerWallet: row.sellerWallet,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    queriesServed: row.queriesServed,
    totalEarned: Number.parseFloat(row.totalEarned as string),
    createdAt: row.createdAt,
  };
}

export async function addDataset(dataset: Dataset): Promise<void> {
  await db.insert(datasets).values({
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    type: dataset.type,
    pricePerQuery: dataset.pricePerQuery.toString(),
    sellerWallet: dataset.sellerWallet,
    data: JSON.stringify(dataset.data),
    queriesServed: dataset.queriesServed,
    totalEarned: dataset.totalEarned.toString(),
    createdAt: dataset.createdAt,
  });
}

/* ------------------------------------------------------------------ */
/*  Transactions                                                       */
/* ------------------------------------------------------------------ */

export async function addTransaction(tx: Transaction): Promise<void> {
  await db.insert(transactions).values({
    id: tx.id,
    datasetId: tx.datasetId,
    txHash: tx.txHash,
    amount: tx.amount.toString(),
    buyerQuery: tx.buyerQuery ?? null,
    aiSummary: tx.aiSummary ?? null,
    timestamp: tx.timestamp,
  });
}

export async function getTransactions(
  datasetId?: string,
  limit?: number,
  offset?: number,
): Promise<Transaction[]> {
  let query = db.select().from(transactions);

  if (datasetId) {
    query = query.where(eq(transactions.datasetId, datasetId));
  }

  query = query.orderBy(sql`timestamp DESC`);

  if (limit !== undefined && limit > 0) {
    query = query.limit(limit);
  }

  if (offset !== undefined && offset > 0) {
    query = query.offset(offset);
  }

  const results = await query;

  return results.map((row) => ({
    id: row.id,
    datasetId: row.datasetId,
    txHash: row.txHash,
    amount: Number.parseFloat(row.amount as string),
    buyerQuery: row.buyerQuery ?? undefined,
    aiSummary: row.aiSummary ?? undefined,
    timestamp: row.timestamp,
  }));
}

export async function getTransactionsCount(datasetId?: string): Promise<number> {
  let query = db.select({ count: sql<number>`count(*)` }).from(transactions);

  if (datasetId) {
    query = query.where(eq(transactions.datasetId, datasetId));
  }

  const result = await query;
  return result[0]?.count ?? 0;
}

export async function txHashUsed(txHash: string): Promise<boolean> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.txHash, txHash));

  return (result[0]?.count ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/*  Webhooks                                                           */
/* ------------------------------------------------------------------ */

export async function getAllWebhooks(): Promise<WebhookSubscription[]> {
  const results = await db.select().from(webhooks);

  return results.map((row) => {
    let events: WebhookEvent[] = [];
    if (typeof row.events === 'string') {
      try {
        events = JSON.parse(row.events);
      } catch {
        events = [];
      }
    } else if (Array.isArray(row.events)) {
      events = row.events;
    }

    return {
      id: row.id,
      sellerWallet: row.sellerWallet,
      url: row.url,
      secret: row.secret,
      events,
      active: typeof row.active === 'number' ? row.active === 1 : row.active,
      createdAt: row.createdAt,
    };
  });
}

export async function getWebhooksForSeller(sellerWallet: string): Promise<WebhookSubscription[]> {
  const isPostgres = (process.env.DATABASE_URL || '').startsWith('postgres');

  let results;
  if (isPostgres) {
    results = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.sellerWallet, sellerWallet), eq(webhooks.active, true as any)));
  } else {
    results = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.sellerWallet, sellerWallet), eq(webhooks.active, 1 as any)));
  }

  return results.map((row) => {
    let events: WebhookEvent[] = [];
    if (typeof row.events === 'string') {
      try {
        events = JSON.parse(row.events);
      } catch {
        events = [];
      }
    } else if (Array.isArray(row.events)) {
      events = row.events;
    }

    return {
      id: row.id,
      sellerWallet: row.sellerWallet,
      url: row.url,
      secret: row.secret,
      events,
      active: typeof row.active === 'number' ? row.active === 1 : row.active,
      createdAt: row.createdAt,
    };
  });
}

export async function getWebhookById(id: string): Promise<WebhookSubscription | undefined> {
  const result = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);

  if (!result.length) return undefined;

  const row = result[0];
  let events: WebhookEvent[] = [];
  if (typeof row.events === 'string') {
    try {
      events = JSON.parse(row.events);
    } catch {
      events = [];
    }
  } else if (Array.isArray(row.events)) {
    events = row.events;
  }

  return {
    id: row.id,
    sellerWallet: row.sellerWallet,
    url: row.url,
    secret: row.secret,
    events,
    active: typeof row.active === 'number' ? row.active === 1 : row.active,
    createdAt: row.createdAt,
  };
}

export async function addWebhook(webhook: WebhookSubscription): Promise<void> {
  await db.insert(webhooks).values({
    id: webhook.id,
    sellerWallet: webhook.sellerWallet,
    url: webhook.url,
    secret: webhook.secret,
    events: JSON.stringify(webhook.events) as any,
    active: (1 as any),
    createdAt: webhook.createdAt,
  });
}

export async function removeWebhook(id: string): Promise<boolean> {
  const result = await db.delete(webhooks).where(eq(webhooks.id, id));
  const rowCount = result.rowCount ?? (result as any).count ?? 0;
  return rowCount > 0; // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
}

export async function updateWebhook(
  id: string,
  updates: Partial<WebhookSubscription>,
): Promise<WebhookSubscription | null> {
  if (Object.keys(updates).length === 0) {
    return (await getWebhookById(id)) ?? null;
  }

export async function getAllWebhooks(): Promise<WebhookSubscription[]> {
  return (await readStore()).webhooks;
}

export async function getWebhooksForSeller(sellerWallet: string): Promise<WebhookSubscription[]> {
  return (await readStore()).webhooks.filter((w) => w.sellerWallet === sellerWallet && w.active);
}

export async function getWebhookById(id: string): Promise<WebhookSubscription | undefined> {
  return (await readStore()).webhooks.find((w) => w.id === id);
}

export async function addWebhook(webhook: WebhookSubscription): Promise<void> {
  return enqueue(async (store) => {
    store.webhooks.push(webhook);
    return [store, undefined];
  });
}

export async function removeWebhook(id: string): Promise<boolean> {
  return enqueue(async (store) => {
    const idx = store.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return [store, false];
    store.webhooks.splice(idx, 1);
    return [store, true];
  });
}

export async function updateWebhook(id: string, updates: Partial<WebhookSubscription>): Promise<WebhookSubscription | null> {
  return enqueue(async (store) => {
    const idx = store.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return [store, null];
    store.webhooks[idx] = { ...store.webhooks[idx], ...updates };
    return [store, store.webhooks[idx]];
  });
  const setClauses = fields.map((f, i) => `"${toSnake(f)}" = $${i + 2}`).join(', ');
  const values = fields.map((f) => updates[f]);
  const updateData: Record<string, any> = {};

  if (updates.sellerWallet !== undefined) updateData.sellerWallet = updates.sellerWallet;
  if (updates.url !== undefined) updateData.url = updates.url;
  if (updates.secret !== undefined) updateData.secret = updates.secret;
  if (updates.events !== undefined) updateData.events = JSON.stringify(updates.events);
  if (updates.active !== undefined) updateData.active = updates.active ? 1 : 0;
  if (updates.createdAt !== undefined) updateData.createdAt = updates.createdAt;

  const result = await db.update(webhooks).set(updateData).where(eq(webhooks.id, id)).returning();

  if (!result.length) return null;

  const row = result[0];
  let events: WebhookEvent[] = [];
  if (typeof row.events === 'string') {
    try {
      events = JSON.parse(row.events);
    } catch {
      events = [];
    }
  } else if (Array.isArray(row.events)) {
    events = row.events;
  }

  return {
    id: row.id,
    sellerWallet: row.sellerWallet,
    url: row.url,
    secret: row.secret,
    events,
    active: typeof row.active === 'number' ? row.active === 1 : row.active,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/*  Schema bootstrap (run once on startup)                            */
/* ------------------------------------------------------------------ */

export async function ensureSchema(): Promise<void> {
  // Drizzle handles migrations, this is a no-op
  // but kept for backward compatibility
}
