import { createClient } from '@libsql/client';
import 'dotenv/config';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('TURSO_DATABASE_URL is not set. Set it in .env or your host environment.');
  process.exit(1);
}

const rawClient = createClient({ url, authToken });

function isTransient(err) {
  const status = err?.cause?.status ?? err?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  const code = err?.code || '';
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_SOCKET';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  const delays = [500, 1500, 4000, 8000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length || !isTransient(err)) throw err;
      console.warn(`[db] transient error on ${label} (attempt ${attempt + 1}): ${err.message}`);
      await sleep(delays[attempt]);
    }
  }
  throw lastErr;
}

export const db = new Proxy(rawClient, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (prop === 'execute' || prop === 'batch') {
      return (...args) => withRetry(() => value.apply(target, args), String(prop));
    }
    return value.bind(target);
  },
});

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
    ['target_price_krw', 'INTEGER'],
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
