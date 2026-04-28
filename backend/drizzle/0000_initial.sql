CREATE TABLE IF NOT EXISTS "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"price_per_query" numeric NOT NULL,
	"seller_wallet" text NOT NULL,
	"data" text NOT NULL DEFAULT '{}',
	"queries_served" integer NOT NULL DEFAULT 0,
	"total_earned" numeric NOT NULL DEFAULT '0',
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"amount" numeric NOT NULL,
	"buyer_query" text,
	"ai_summary" text,
	"timestamp" text NOT NULL,
	UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_wallet" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text NOT NULL DEFAULT '[]',
	"active" integer NOT NULL DEFAULT 1,
	"created_at" text NOT NULL
);
