/* eslint-disable prefer-node-protocol,sonarjs/cognitive-complexity */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import db from './client';
import { datasets, transactions } from './schema';
import { eq } from 'drizzle-orm';

interface DatasetFromJSON {
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

interface TransactionFromJSON {
  id: string;
  datasetId: string;
  txHash: string;
  amount: number;
  buyerQuery?: string;
  aiSummary?: string;
  timestamp: string;
}

async function seedDatasets(jsonData: any): Promise<void> {
  if (!jsonData.datasets || !Array.isArray(jsonData.datasets)) {
    return;
  }

  for (const dataset of jsonData.datasets as DatasetFromJSON[]) {
    const existing = await db
      .select()
      .from(datasets)
      .where(eq(datasets.id, dataset.id))
      .limit(1);

    if (existing.length > 0) {
      console.log(`⊘ Dataset already exists: ${dataset.id}`);
      continue;
    }

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
    console.log(`✓ Inserted dataset: ${dataset.id}`);
  }
}

async function seedTransactions(jsonData: any): Promise<void> {
  if (!jsonData.transactions || !Array.isArray(jsonData.transactions)) {
    return;
  }

  for (const tx of jsonData.transactions as TransactionFromJSON[]) {
    const existing = await db
      .select()
      .from(transactions)
      .where(eq(transactions.txHash, tx.txHash))
      .limit(1);

    if (existing.length > 0) {
      console.log(`⊘ Transaction already exists: ${tx.txHash}`);
      continue;
    }

    await db.insert(transactions).values({
      id: tx.id,
      datasetId: tx.datasetId,
      txHash: tx.txHash,
      amount: tx.amount.toString(),
      buyerQuery: tx.buyerQuery || null,
      aiSummary: tx.aiSummary || null,
      timestamp: tx.timestamp,
    });
    console.log(`✓ Inserted transaction: ${tx.txHash}`);
  }
}

async function seed(): Promise<void> {
  try {
    const dataPath = resolve(__dirname, '../../data/datasets.json');
    const fileContent = readFileSync(dataPath, 'utf-8');
    const jsonData = JSON.parse(fileContent);

    console.log('Seeding database...');

    await seedDatasets(jsonData);
    await seedTransactions(jsonData);

    console.log('Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
