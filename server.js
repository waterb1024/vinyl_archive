import express from 'express';
import methodOverride from 'method-override';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from './db.js';

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const DISCOGS_UA = 'VinylArchive/0.1 +https://github.com/waterb1024/vinyl_archive';

async function discogsFetch(urlPath) {
  if (!DISCOGS_TOKEN) {
    const err = new Error('DISCOGS_TOKEN is not configured.');
    err.status = 503;
    throw err;
  }
  const url = `https://api.discogs.com${urlPath}`;
  const sep = urlPath.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}token=${encodeURIComponent(DISCOGS_TOKEN)}`, {
    headers: { 'User-Agent': DISCOGS_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`Discogs ${res.status}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  return res.json();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// List
app.get('/', async (req, res) => {
  maybeTriggerBatchRefresh();
  const q = (req.query.q || '').trim();
  const status = req.query.status === 'wishlist' ? 'wishlist' : 'owned';
  const sort = ['recent', 'alpha', 'roi', 'price'].includes(req.query.sort)
    ? req.query.sort
    : 'recent';
  const orderBy = {
    recent: `created_at DESC`,
    alpha: `title COLLATE NOCASE ASC`,
    roi: `(purchase_price > 0 AND last_price_krw IS NOT NULL) DESC,
          CASE WHEN purchase_price > 0 AND last_price_krw IS NOT NULL
               THEN (last_price_krw - purchase_price) * 1.0 / purchase_price
               ELSE 0 END DESC,
          created_at DESC`,
    price: `(last_price_krw IS NOT NULL) DESC, last_price_krw DESC, created_at DESC`,
  }[sort];

  const columns = `id, title, artist, year, genre, cover_version,
                   purchase_price, last_price_krw, status`;
  let result;
  if (q) {
    const like = `%${q}%`;
    result = await db.execute({
      sql: `SELECT ${columns}
            FROM albums
            WHERE status = ?
              AND (title LIKE ? OR artist LIKE ? OR genre LIKE ? OR label LIKE ?)
            ORDER BY ${orderBy}`,
      args: [status, like, like, like, like],
    });
  } else {
    result = await db.execute({
      sql: `SELECT ${columns} FROM albums WHERE status = ? ORDER BY ${orderBy}`,
      args: [status],
    });
  }
  const counts = await db.execute(
    `SELECT status, COUNT(*) AS n FROM albums GROUP BY status`
  );
  const countsByStatus = { owned: 0, wishlist: 0 };
  for (const row of counts.rows) {
    countsByStatus[row.status] = Number(row.n);
  }
  res.render('index', { albums: result.rows, q, sort, status, countsByStatus });
});

// Manual batch refresh trigger (for external cron / GitHub Actions)
app.post('/api/refresh-prices', async (req, res) => {
  const secret = process.env.REFRESH_SECRET;
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!secret || auth !== secret) return res.status(401).json({ error: 'unauthorized' });
  lastBatchRefreshAt = 0;
  maybeTriggerBatchRefresh();
  res.json({ status: 'started' });
});

// iTunes preview lookup
app.get('/api/itunes/preview', async (req, res, next) => {
  const artist = (req.query.artist || '').trim();
  const title = (req.query.title || '').trim();
  if (!artist || !title) return res.status(400).json({ error: 'artist and title required' });
  try {
    const data = await fetchItunesPreview(artist, title);
    res.json({ preview: data });
  } catch (err) {
    next(err);
  }
});

// Discogs search proxy
app.get('/api/discogs/search', async (req, res, next) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const data = await discogsFetch(
      `/database/search?type=release&format=Vinyl&per_page=10&q=${encodeURIComponent(q)}`
    );
    const results = (data.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      year: r.year || null,
      label: Array.isArray(r.label) ? r.label[0] : r.label || null,
      genre: Array.isArray(r.genre) ? r.genre.join(', ') : r.genre || null,
      thumb: r.thumb || r.cover_image || null,
    }));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// Discogs release detail
app.get('/api/discogs/release/:id', async (req, res, next) => {
  try {
    const r = await discogsFetch(`/releases/${encodeURIComponent(req.params.id)}`);
    let title = r.title || '';
    let artist = '';
    if (Array.isArray(r.artists) && r.artists.length) {
      artist = r.artists.map((a) => a.name).join(', ').replace(/\s*\(\d+\)$/, '');
    } else if (typeof r.title === 'string' && r.title.includes(' - ')) {
      [artist, title] = r.title.split(' - ', 2);
    }
    res.json({
      title: title.trim(),
      artist: artist.trim(),
      year: r.year || null,
      genre: Array.isArray(r.genres) ? r.genres.join(', ') : null,
      label: Array.isArray(r.labels) && r.labels.length ? r.labels[0].name : null,
      cover_url: r.images?.find((i) => i.type === 'primary')?.uri || r.images?.[0]?.uri || null,
      notes: r.notes || '',
    });
  } catch (err) {
    next(err);
  }
});

let fxCache = { rate: null, fetchedAt: 0 };
async function getUsdToKrw() {
  const now = Date.now();
  if (fxCache.rate && now - fxCache.fetchedAt < 24 * 3600 * 1000) return fxCache.rate;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error('fx failed');
    const data = await res.json();
    const rate = data?.rates?.KRW;
    if (typeof rate === 'number' && rate > 0) {
      fxCache = { rate, fetchedAt: now };
      return rate;
    }
  } catch (err) {
    console.error('FX fetch failed:', err.message);
  }
  return fxCache.rate;
}

async function fetchMarketplaceMaxUsd(releaseId) {
  try {
    const data = await discogsFetch(
      `/marketplace/stats/${encodeURIComponent(releaseId)}?curr_abbr=USD`
    );
    const pick = data?.highest_price ?? data?.lowest_price;
    if (!pick || typeof pick.value !== 'number') return null;
    if (pick.currency && pick.currency !== 'USD') return null;
    return pick.value;
  } catch (err) {
    console.error('Marketplace fetch failed:', err.message);
    return null;
  }
}

let lastBatchRefreshAt = 0;
let batchRefreshInFlight = null;

async function refreshAllAlbums() {
  const result = await db.execute(
    `SELECT id, discogs_release_id, last_priced_at, last_price_usd
     FROM albums WHERE discogs_release_id IS NOT NULL`
  );
  let updated = 0;
  for (const row of result.rows) {
    try {
      const before = row.last_priced_at;
      const after = await refreshPriceIfStale(row, { force: true });
      if (after.last_priced_at !== before) updated++;
    } catch (err) {
      console.error(`Batch refresh failed for album ${row.id}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`Batch refresh complete: ${updated}/${result.rows.length} updated`);
}

function maybeTriggerBatchRefresh() {
  if (batchRefreshInFlight) return;
  if (Date.now() - lastBatchRefreshAt < 23 * 3600 * 1000) return;
  lastBatchRefreshAt = Date.now();
  batchRefreshInFlight = refreshAllAlbums()
    .catch((err) => {
      console.error('Batch refresh error:', err);
      lastBatchRefreshAt = 0;
    })
    .finally(() => { batchRefreshInFlight = null; });
}

async function refreshPriceIfStale(album, { force = false } = {}) {
  if (!album.discogs_release_id) return album;
  const lastTs = album.last_priced_at ? new Date(album.last_priced_at).getTime() : 0;
  const fresh = Date.now() - lastTs < 24 * 3600 * 1000;
  if (!force && fresh && album.last_price_usd != null) return album;
  const usd = await fetchMarketplaceMaxUsd(album.discogs_release_id);
  if (usd == null) return album;
  const rate = await getUsdToKrw();
  const krw = rate ? Math.round(usd * rate) : null;
  await db.execute({
    sql: `UPDATE albums SET last_price_usd=?, last_price_krw=?, last_priced_at=datetime('now') WHERE id=?`,
    args: [usd, krw, album.id],
  });
  await db.execute({
    sql: `INSERT INTO price_history (album_id, usd, krw) VALUES (?, ?, ?)`,
    args: [album.id, usd, krw],
  });
  return { ...album, last_price_usd: usd, last_price_krw: krw, last_priced_at: new Date().toISOString() };
}

const itunesCache = new Map(); // key -> { value, expiresAt }
async function fetchItunesPreview(artist, title) {
  const key = `${artist}\n${title}`.toLowerCase();
  const cached = itunesCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`iTunes ${res.status}`);
    const data = await res.json();
    const r = data?.results?.[0];
    const value = r?.previewUrl ? {
      preview_url: r.previewUrl,
      track_name: r.trackName,
      artist_name: r.artistName,
      artwork: r.artworkUrl100,
    } : null;
    itunesCache.set(key, { value, expiresAt: Date.now() + 12 * 3600 * 1000 });
    return value;
  } catch (err) {
    console.error('iTunes lookup failed:', err.message);
    return null;
  }
}

async function downloadCover(url) {
  const res = await fetch(url, { headers: { 'User-Agent': DISCOGS_UA } });
  if (!res.ok) return null;
  const mime = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) return null;
  return { buffer: buf, mime };
}

// Stats dashboard
app.get('/stats', async (req, res, next) => {
  try {
    const result = await db.execute(
      `SELECT id, title, artist, year, genre, cover_version,
              purchase_price, last_price_krw
         FROM albums
        WHERE status = 'owned'`
    );
    const albums = result.rows;
    const wishlistCountRow = await db.execute(
      `SELECT COUNT(*) AS n FROM albums WHERE status = 'wishlist'`
    );
    const wishlistCount = Number(wishlistCountRow.rows[0]?.n || 0);
    const total = albums.length;
    let purchaseSum = 0;
    let purchaseTrackedCount = 0;
    let marketSum = 0;
    let marketTrackedCount = 0;
    let pairedPurchase = 0;
    let pairedMarket = 0;
    const genreCounts = new Map();
    const decadeCounts = new Map();
    const artistCounts = new Map();
    for (const a of albums) {
      const p = a.purchase_price ? Number(a.purchase_price) : null;
      const m = a.last_price_krw ? Number(a.last_price_krw) : null;
      if (p != null) { purchaseSum += p; purchaseTrackedCount++; }
      if (m != null) { marketSum += m; marketTrackedCount++; }
      if (p != null && m != null) { pairedPurchase += p; pairedMarket += m; }
      const genre = (a.genre || '').trim() || 'Unfiled';
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      const artist = (a.artist || '').trim() || 'Unknown';
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      if (a.year) {
        const decade = Math.floor(Number(a.year) / 10) * 10;
        if (decade) {
          decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
        }
      }
    }
    const roiPct = pairedPurchase > 0
      ? ((pairedMarket - pairedPurchase) / pairedPurchase) * 100
      : null;
    const sortedByValue = albums
      .filter((a) => a.last_price_krw != null)
      .sort((a, b) => Number(b.last_price_krw) - Number(a.last_price_krw))
      .slice(0, 5);
    const sortedByRoi = albums
      .filter((a) => a.purchase_price && a.last_price_krw)
      .map((a) => ({
        ...a,
        roiPct: ((Number(a.last_price_krw) - Number(a.purchase_price))
                / Number(a.purchase_price)) * 100,
      }))
      .sort((a, b) => b.roiPct - a.roiPct)
      .slice(0, 5);
    const genres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1]);
    const decades = [...decadeCounts.entries()]
      .sort((a, b) => a[0] - b[0]);
    const topArtists = [...artistCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const maxGenre = genres.reduce((m, [, c]) => Math.max(m, c), 0);
    const maxDecade = decades.reduce((m, [, c]) => Math.max(m, c), 0);
    const maxArtist = topArtists.reduce((m, [, c]) => Math.max(m, c), 0);
    res.render('stats', {
      total,
      purchaseSum,
      purchaseTrackedCount,
      marketSum,
      marketTrackedCount,
      pairedPurchase,
      pairedMarket,
      roiPct,
      sortedByValue,
      sortedByRoi,
      genres,
      decades,
      topArtists,
      maxGenre,
      maxDecade,
      maxArtist,
      wishlistCount,
    });
  } catch (err) {
    next(err);
  }
});

// New form
app.get('/albums/new', (req, res) => {
  res.render('new', { errors: [], values: {}, discogsEnabled: !!DISCOGS_TOKEN });
});

// Create
app.post('/albums', upload.single('cover'), async (req, res) => {
  const { title, artist, year, genre, label, notes, cover_url, purchase_price, purchase_date, discogs_release_id } = req.body;
  const status = req.body.status === 'wishlist' ? 'wishlist' : 'owned';
  const errors = [];
  if (!title?.trim()) errors.push('Title is required.');
  if (!artist?.trim()) errors.push('Artist is required.');
  if (errors.length) {
    return res.status(400).render('new', { errors, values: req.body, discogsEnabled: !!DISCOGS_TOKEN });
  }

  let cover = req.file ? req.file.buffer : null;
  let coverMime = req.file ? req.file.mimetype : null;
  if (!cover && cover_url) {
    const downloaded = await downloadCover(cover_url);
    if (downloaded) {
      cover = downloaded.buffer;
      coverMime = downloaded.mime;
    }
  }

  const result = await db.execute({
    sql: `INSERT INTO albums (title, artist, year, genre, label, notes, cover, cover_mime, purchase_price, purchase_date, discogs_release_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title.trim(),
      artist.trim(),
      year ? Number(year) : null,
      genre?.trim() || null,
      label?.trim() || null,
      notes?.trim() || null,
      cover,
      coverMime,
      status === 'owned' && purchase_price
        ? Number(String(purchase_price).replace(/[^\d]/g, ''))
        : null,
      status === 'owned' ? (purchase_date?.trim() || null) : null,
      discogs_release_id ? Number(discogs_release_id) : null,
      status,
    ],
  });

  res.redirect(`/albums/${result.lastInsertRowid}`);
});

// Convert wishlist → owned
app.post('/albums/:id/convert', async (req, res, next) => {
  try {
    const { purchase_price, purchase_date } = req.body;
    const price = purchase_price
      ? Number(String(purchase_price).replace(/[^\d]/g, ''))
      : null;
    await db.execute({
      sql: `UPDATE albums
            SET status = 'owned',
                purchase_price = ?,
                purchase_date = ?
            WHERE id = ?`,
      args: [price, purchase_date?.trim() || null, req.params.id],
    });
    res.redirect(`/albums/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Detail
app.get('/albums/:id', async (req, res) => {
  const result = await db.execute({
    sql: `SELECT id, title, artist, year, genre, label, notes, cover_mime, created_at,
                 purchase_price, purchase_date, discogs_release_id,
                 last_price_usd, last_price_krw, last_priced_at, cover_version, status
          FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  if (!result.rows.length) return res.status(404).render('error', { message: 'Not found' });
  const album = await refreshPriceIfStale(result.rows[0]);
  res.render('show', { album });
});

// Price history (monthly max)
app.get('/albums/:id/price-history', async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: `SELECT strftime('%Y-%m', recorded_at) AS month,
                   MAX(usd) AS usd,
                   MAX(krw) AS krw,
                   COUNT(*) AS n
            FROM price_history
            WHERE album_id = ?
            GROUP BY month
            ORDER BY month`,
      args: [req.params.id],
    });
    res.json({ months: result.rows });
  } catch (err) {
    next(err);
  }
});

// Cover image
app.get('/albums/:id/cover', async (req, res) => {
  const result = await db.execute({
    sql: `SELECT cover, cover_mime FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  const row = result.rows[0];
  if (!row || !row.cover) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.redirect('/placeholder.svg');
  }
  const buf = Buffer.from(row.cover);
  const etag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Type', row.cover_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('ETag', etag);
  res.send(buf);
});

// Edit form
app.get('/albums/:id/edit', async (req, res) => {
  const result = await db.execute({
    sql: `SELECT id, title, artist, year, genre, label, notes, cover_mime,
                 purchase_price, purchase_date, discogs_release_id, cover_version, status
          FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  if (!result.rows.length) return res.status(404).render('error', { message: 'Not found' });
  res.render('edit', { album: result.rows[0], errors: [], discogsEnabled: !!DISCOGS_TOKEN });
});

// Update
app.put('/albums/:id', upload.single('cover'), async (req, res) => {
  const {
    title, artist, year, genre, label, notes, remove_cover,
    purchase_price, purchase_date, discogs_release_id, cover_url,
  } = req.body;
  const status = req.body.status === 'wishlist' ? 'wishlist' : 'owned';
  const errors = [];
  if (!title?.trim()) errors.push('Title is required.');
  if (!artist?.trim()) errors.push('Artist is required.');
  if (errors.length) {
    return res.status(400).render('edit', {
      album: { id: req.params.id, ...req.body },
      errors,
      discogsEnabled: !!DISCOGS_TOKEN,
    });
  }

  const newReleaseId = discogs_release_id ? Number(discogs_release_id) : null;
  const prior = await db.execute({
    sql: `SELECT discogs_release_id FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  const priorReleaseId = prior.rows[0]?.discogs_release_id || null;
  const releaseChanged = newReleaseId !== priorReleaseId;

  const baseArgs = [
    title.trim(),
    artist.trim(),
    year ? Number(year) : null,
    genre?.trim() || null,
    label?.trim() || null,
    notes?.trim() || null,
    status === 'owned' && purchase_price
      ? Number(String(purchase_price).replace(/[^\d]/g, ''))
      : null,
    status === 'owned' ? (purchase_date?.trim() || null) : null,
    newReleaseId,
    status,
  ];

  // Cover handling: new upload > Discogs cover_url (if provided) > remove_cover flag > keep existing
  let coverBuf = null;
  let coverMime = null;
  let coverAction = 'keep';
  if (req.file) {
    coverBuf = req.file.buffer;
    coverMime = req.file.mimetype;
    coverAction = 'replace';
  } else if (cover_url) {
    const downloaded = await downloadCover(cover_url);
    if (downloaded) {
      coverBuf = downloaded.buffer;
      coverMime = downloaded.mime;
      coverAction = 'replace';
    }
  } else if (remove_cover) {
    coverAction = 'remove';
  }

  const setBase = `title=?, artist=?, year=?, genre=?, label=?, notes=?,
                   purchase_price=?, purchase_date=?, discogs_release_id=?, status=?`;
  const setPrice = releaseChanged
    ? `, last_price_usd=NULL, last_price_krw=NULL, last_priced_at=NULL`
    : '';

  if (coverAction === 'replace') {
    await db.execute({
      sql: `UPDATE albums SET ${setBase}, cover=?, cover_mime=?, cover_version=COALESCE(cover_version,1)+1 ${setPrice} WHERE id=?`,
      args: [...baseArgs, coverBuf, coverMime, req.params.id],
    });
  } else if (coverAction === 'remove') {
    await db.execute({
      sql: `UPDATE albums SET ${setBase}, cover=NULL, cover_mime=NULL, cover_version=COALESCE(cover_version,1)+1 ${setPrice} WHERE id=?`,
      args: [...baseArgs, req.params.id],
    });
  } else {
    await db.execute({
      sql: `UPDATE albums SET ${setBase} ${setPrice} WHERE id=?`,
      args: [...baseArgs, req.params.id],
    });
  }

  res.redirect(`/albums/${req.params.id}`);
});

// Delete
app.delete('/albums/:id', async (req, res) => {
  await db.execute({ sql: `DELETE FROM price_history WHERE album_id = ?`, args: [req.params.id] });
  await db.execute({ sql: `DELETE FROM albums WHERE id = ?`, args: [req.params.id] });
  res.redirect('/');
});

// 404
app.use((req, res) => {
  res.status(404).render('error', { message: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Internal error' });
  }
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'Image must be 5MB or smaller.'
    : 'Something went wrong.';
  res.status(status).render('error', { message });
});

const port = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(port, () => console.log(`vinyl-archive listening on :${port}`));
  })
  .catch((err) => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
