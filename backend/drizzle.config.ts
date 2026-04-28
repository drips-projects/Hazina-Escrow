import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'file:./sqlite.db';

const isPostgres =
  databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: isPostgres ? 'postgresql' : 'sqlite',
  dbCredentials: isPostgres
    ? {
        url: databaseUrl,
      }
    : {
        url: databaseUrl,
      },
});
