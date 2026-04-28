import { drizzle } from 'drizzle-orm/node-postgres';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { Pool } from 'pg';
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL || 'file:./sqlite.db';

const isPostgres = databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');

const db = (() => {
  if (isPostgres) {
    // PostgreSQL
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    return drizzle(pool, { schema });
  } else {
    // SQLite
    const sqliteDbPath = databaseUrl.replace(/^file:/, './');
    const sqlite = new Database(sqliteDbPath);
    sqlite.pragma('journal_mode = WAL');
    return drizzleSqlite(sqlite, { schema });
  }
})();

export default db;
