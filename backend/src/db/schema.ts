import { sql } from 'drizzle-orm';

const isPostgres = process.env.DATABASE_URL?.startsWith('postgres') ?? false;

const getSchemaObjects = () => {
  if (isPostgres) {
    const { pgTable, text, integer, numeric, boolean } = require('drizzle-orm/pg-core');

    const datasets = pgTable('datasets', {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      description: text('description').notNull(),
      type: text('type').notNull(),
      pricePerQuery: numeric('price_per_query').notNull(),
      sellerWallet: text('seller_wallet').notNull(),
      data: text('data').notNull().default('{}'),
      queriesServed: integer('queries_served').notNull().default(0),
      totalEarned: numeric('total_earned').notNull().default('0'),
      createdAt: text('created_at').notNull(),
    });

    const transactions = pgTable('transactions', {
      id: text('id').primaryKey(),
      datasetId: text('dataset_id').notNull(),
      txHash: text('tx_hash').notNull().unique(),
      amount: numeric('amount').notNull(),
      buyerQuery: text('buyer_query'),
      aiSummary: text('ai_summary'),
      timestamp: text('timestamp').notNull(),
    });

    const webhooks = pgTable('webhooks', {
      id: text('id').primaryKey(),
      sellerWallet: text('seller_wallet').notNull(),
      url: text('url').notNull(),
      secret: text('secret').notNull(),
      events: text('events').array().notNull().default(sql`'{}'`),
      active: boolean('active').notNull().default(true),
      createdAt: text('created_at').notNull(),
    });

    return { datasets, transactions, webhooks };
  } else {
    const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');

    const datasets = sqliteTable('datasets', {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      description: text('description').notNull(),
      type: text('type').notNull(),
      pricePerQuery: text('price_per_query').notNull(),
      sellerWallet: text('seller_wallet').notNull(),
      data: text('data').notNull().default('{}'),
      queriesServed: integer('queries_served').notNull().default(0),
      totalEarned: text('total_earned').notNull().default('0'),
      createdAt: text('created_at').notNull(),
    });

    const transactions = sqliteTable('transactions', {
      id: text('id').primaryKey(),
      datasetId: text('dataset_id').notNull(),
      txHash: text('tx_hash').notNull().unique(),
      amount: text('amount').notNull(),
      buyerQuery: text('buyer_query'),
      aiSummary: text('ai_summary'),
      timestamp: text('timestamp').notNull(),
    });

    const webhooks = sqliteTable('webhooks', {
      id: text('id').primaryKey(),
      sellerWallet: text('seller_wallet').notNull(),
      url: text('url').notNull(),
      secret: text('secret').notNull(),
      events: text('events').notNull().default('[]'),
      active: integer('active').notNull().default(1),
      createdAt: text('created_at').notNull(),
    });

    return { datasets, transactions, webhooks };
  }
};

const { datasets, transactions, webhooks } = getSchemaObjects();

export { datasets, transactions, webhooks };
