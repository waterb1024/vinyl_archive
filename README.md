# Vinyl Archive

A quiet, minimalist catalogue for a personal vinyl collection.
Node.js + Express + EJS + Turso (libSQL), deployable on Render.

## Features

- Browse a grid of records with album covers
- Add / edit / delete albums (title, artist, year, genre, label, notes, cover)
- Album cover upload (stored as BLOB in Turso, max 5 MB)
- Search by title / artist / genre / label
- Mobile-friendly minimalist design

## Local Setup

```bash
npm install
cp .env.example .env
# fill TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
npm run dev
```

Open <http://localhost:3000>.

The `albums` table is created automatically on first start.

## Turso Setup

1. Install the Turso CLI and sign in:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```
2. Create a DB:
   ```bash
   turso db create vinyl-archive
   turso db show vinyl-archive --url
   turso db tokens create vinyl-archive
   ```
3. Put the URL and token into `.env` (and into Render env vars).

## Deploy on Render

This repo includes `render.yaml`. On Render:

1. **New +** → **Blueprint** → connect this repo.
2. Render reads `render.yaml` and creates a free Web Service.
3. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the service's
   environment.
4. Deploy. Render runs `npm install` then `npm start` and exposes the
   port from `process.env.PORT`.

Notes:
- The free Render plan sleeps after inactivity; the first request after
  a sleep may take ~30s.
- Images are stored inside Turso (not on the Render filesystem), so the
  ephemeral disk on the free plan is not a problem.

## Notes on Auth

This version has **no authentication** — anyone with the URL can add,
edit, or delete records. If you deploy publicly, consider:

- Setting up Basic Auth in front of the write routes
- Putting the site behind Cloudflare Access
- Or only sharing the URL with trusted people

## Tech

- Express 4
- EJS templates
- `@libsql/client` for Turso
- `multer` (memory storage) for uploads
- Vanilla CSS, Cormorant Garamond + Inter fonts
