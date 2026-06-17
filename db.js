import { createClient } from '@libsql/client';
import 'dotenv/config';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('TURSO_DATABASE_URL is not set. Set it in .env or your host environment.');
  process.exit(1);
}

export const db = createClient({ url, authToken });

export async function initSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      year INTEGER,
      genre TEXT,
      label TEXT,
      notes TEXT,
      cover BLOB,
      cover_mime TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
