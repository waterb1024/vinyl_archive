import express from 'express';
import methodOverride from 'method-override';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from './db.js';

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
  const q = (req.query.q || '').trim();
  let result;
  if (q) {
    const like = `%${q}%`;
    result = await db.execute({
      sql: `SELECT id, title, artist, year, genre
            FROM albums
            WHERE title LIKE ? OR artist LIKE ? OR genre LIKE ? OR label LIKE ?
            ORDER BY created_at DESC`,
      args: [like, like, like, like],
    });
  } else {
    result = await db.execute(
      `SELECT id, title, artist, year, genre FROM albums ORDER BY created_at DESC`
    );
  }
  res.render('index', { albums: result.rows, q });
});

// New form
app.get('/albums/new', (req, res) => {
  res.render('new', { errors: [], values: {} });
});

// Create
app.post('/albums', upload.single('cover'), async (req, res) => {
  const { title, artist, year, genre, label, notes } = req.body;
  const errors = [];
  if (!title?.trim()) errors.push('Title is required.');
  if (!artist?.trim()) errors.push('Artist is required.');
  if (errors.length) {
    return res.status(400).render('new', { errors, values: req.body });
  }

  const cover = req.file ? req.file.buffer : null;
  const coverMime = req.file ? req.file.mimetype : null;

  const result = await db.execute({
    sql: `INSERT INTO albums (title, artist, year, genre, label, notes, cover, cover_mime)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title.trim(),
      artist.trim(),
      year ? Number(year) : null,
      genre?.trim() || null,
      label?.trim() || null,
      notes?.trim() || null,
      cover,
      coverMime,
    ],
  });

  res.redirect(`/albums/${result.lastInsertRowid}`);
});

// Detail
app.get('/albums/:id', async (req, res) => {
  const result = await db.execute({
    sql: `SELECT id, title, artist, year, genre, label, notes, cover_mime, created_at
          FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  if (!result.rows.length) return res.status(404).render('error', { message: 'Not found' });
  res.render('show', { album: result.rows[0] });
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
  res.set('Content-Type', row.cover_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(row.cover));
});

// Edit form
app.get('/albums/:id/edit', async (req, res) => {
  const result = await db.execute({
    sql: `SELECT id, title, artist, year, genre, label, notes, cover_mime
          FROM albums WHERE id = ?`,
    args: [req.params.id],
  });
  if (!result.rows.length) return res.status(404).render('error', { message: 'Not found' });
  res.render('edit', { album: result.rows[0], errors: [] });
});

// Update
app.put('/albums/:id', upload.single('cover'), async (req, res) => {
  const { title, artist, year, genre, label, notes, remove_cover } = req.body;
  const errors = [];
  if (!title?.trim()) errors.push('Title is required.');
  if (!artist?.trim()) errors.push('Artist is required.');
  if (errors.length) {
    return res.status(400).render('edit', {
      album: { id: req.params.id, ...req.body },
      errors,
    });
  }

  if (req.file) {
    await db.execute({
      sql: `UPDATE albums
            SET title=?, artist=?, year=?, genre=?, label=?, notes=?, cover=?, cover_mime=?
            WHERE id=?`,
      args: [
        title.trim(),
        artist.trim(),
        year ? Number(year) : null,
        genre?.trim() || null,
        label?.trim() || null,
        notes?.trim() || null,
        req.file.buffer,
        req.file.mimetype,
        req.params.id,
      ],
    });
  } else if (remove_cover) {
    await db.execute({
      sql: `UPDATE albums
            SET title=?, artist=?, year=?, genre=?, label=?, notes=?, cover=NULL, cover_mime=NULL
            WHERE id=?`,
      args: [
        title.trim(),
        artist.trim(),
        year ? Number(year) : null,
        genre?.trim() || null,
        label?.trim() || null,
        notes?.trim() || null,
        req.params.id,
      ],
    });
  } else {
    await db.execute({
      sql: `UPDATE albums
            SET title=?, artist=?, year=?, genre=?, label=?, notes=?
            WHERE id=?`,
      args: [
        title.trim(),
        artist.trim(),
        year ? Number(year) : null,
        genre?.trim() || null,
        label?.trim() || null,
        notes?.trim() || null,
        req.params.id,
      ],
    });
  }

  res.redirect(`/albums/${req.params.id}`);
});

// Delete
app.delete('/albums/:id', async (req, res) => {
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
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'Image must be 5MB or smaller.'
    : 'Something went wrong.';
  res.status(500).render('error', { message });
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
