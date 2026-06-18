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

  const info = await db.execute(`PRAGMA table_info(albums)`);
  const existing = new Set(info.rows.map((r) => r.name));
  const additions = [
    ['purchase_price', 'INTEGER'],
    ['purchase_date', 'TEXT'],
    ['discogs_release_id', 'INTEGER'],
    ['last_price_usd', 'REAL'],
    ['last_price_krw', 'INTEGER'],
    ['last_priced_at', 'TEXT'],
    ['cover_version', 'INTEGER DEFAULT 1'],
    ['status', `TEXT NOT NULL DEFAULT 'owned'`],
  ];
  for (const [col, type] of additions) {
    if (!existing.has(col)) {
      await db.execute(`ALTER TABLE albums ADD COLUMN ${col} ${type}`);
    }
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      usd REAL,
      krw INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_price_history_album_date ON price_history(album_id, recorded_at)`
  );
}
