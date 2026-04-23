console.log('[journal] Starting up, Node', process.version, 'cwd:', process.cwd());

import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import * as dbmod from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const ENTRIES_DIR = process.env.ENTRIES_DIR
  ? path.resolve(process.env.ENTRIES_DIR)
  : path.resolve(__dirname, '..', 'entries');
const WRITER_PASSWORD = process.env.WRITER_PASSWORD;
const READER_PASSWORD = process.env.READER_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

console.log('[journal] Env vars present:', {
  WRITER_PASSWORD: !!WRITER_PASSWORD,
  READER_PASSWORD: !!READER_PASSWORD,
  SESSION_SECRET: !!SESSION_SECRET,
  PORT,
  ENTRIES_DIR,
  NODE_ENV: process.env.NODE_ENV,
});

const missing = [];
if (!WRITER_PASSWORD) missing.push('WRITER_PASSWORD');
if (!READER_PASSWORD) missing.push('READER_PASSWORD');
if (!SESSION_SECRET) missing.push('SESSION_SECRET');
if (missing.length) {
  console.error('[journal] Missing required env vars:', missing.join(', '));
  console.error('[journal] Set them in hPanel → your site → Advanced → Node.js (or Environment variables) and redeploy.');
  process.exit(1);
}

try {
  await fs.mkdir(ENTRIES_DIR, { recursive: true });
  console.log('[journal] Entries directory ready:', ENTRIES_DIR);
} catch (err) {
  console.error('[journal] Failed to create entries dir', ENTRIES_DIR, err);
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(ENTRIES_DIR, '..', 'journal.db');
try {
  dbmod.openDb(DB_PATH);
  await dbmod.rebuildFromFiles(ENTRIES_DIR);
  console.log('[journal] DB ready at', DB_PATH);
} catch (err) {
  console.error('[journal] Failed to initialize DB at', DB_PATH, err);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 60,
  },
}));

app.use('/static', express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === WRITER_PASSWORD) {
    req.session.role = 'writer';
    return res.json({ role: 'writer' });
  }
  if (password === READER_PASSWORD) {
    req.session.role = 'reader';
    return res.json({ role: 'reader' });
  }
  return res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ role: req.session.role || null });
});

function requireAuth(req, res, next) {
  if (!req.session.role) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireWriter(req, res, next) {
  if (req.session.role !== 'writer') return res.status(403).json({ error: 'Writer only' });
  next();
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function safeFilename(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

function entryPaths(date) {
  const year = date.slice(0, 4);
  const dir = path.join(ENTRIES_DIR, year);
  return {
    dir,
    htmlFile: path.join(dir, `${date}.html`),
    photosDir: path.join(dir, date),
  };
}

app.get('/api/entries', requireAuth, async (req, res) => {
  const years = (await fs.readdir(ENTRIES_DIR, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map(d => d.name);
  const all = [];
  for (const year of years) {
    const files = await fs.readdir(path.join(ENTRIES_DIR, year)).catch(() => []);
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.html$/);
      if (!m) continue;
      const stat = await fs.stat(path.join(ENTRIES_DIR, year, f));
      all.push({ date: m[1], updatedAt: stat.mtime.toISOString() });
    }
  }
  all.sort((a, b) => b.date.localeCompare(a.date));
  res.json(all);
});

async function writeCommentsSidecar(date) {
  const comments = dbmod.listComments(date);
  const { dir } = entryPaths(date);
  const sidecar = path.join(dir, `${date}.comments.json`);
  if (!comments.length) {
    await fs.unlink(sidecar).catch(() => {});
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(sidecar, JSON.stringify(comments, null, 2), 'utf8');
}

app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(dbmod.searchEntries(q));
});

app.get('/api/on-this-day', requireAuth, (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!validDate(ref)) return res.status(400).json({ error: 'Invalid ref date' });
  res.json(dbmod.onThisDay(ref));
});

app.get('/api/random', requireAuth, (req, res) => {
  const all = dbmod.getDb().prepare(
    'SELECT date, html FROM entries WHERE length(plain) > 0'
  ).all();
  if (!all.length) return res.json(null);
  res.json(all[Math.floor(Math.random() * all.length)]);
});

app.get('/api/tags', requireAuth, (req, res) => {
  const rows = dbmod.getDb().prepare(
    "SELECT date, plain FROM entries WHERE plain LIKE '%#%'"
  ).all();
  const tagCounts = new Map();
  for (const { date, plain } of rows) {
    const tags = plain.match(/#[A-Za-z0-9_]+/g) || [];
    for (const t of new Set(tags.map(t => t.toLowerCase()))) {
      if (!tagCounts.has(t)) tagCounts.set(t, []);
      tagCounts.get(t).push(date);
    }
  }
  res.json([...tagCounts.entries()]
    .map(([tag, dates]) => ({ tag, count: dates.length, dates }))
    .sort((a, b) => b.count - a.count));
});

app.get('/api/calendar', requireAuth, (req, res) => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  res.json({ year, entries: dbmod.calendar(year) });
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(dbmod.stats());
});

app.get('/api/comments/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  res.json(dbmod.listComments(date));
});

app.post('/api/comments/:date', requireAuth, async (req, res) => {
  const { date } = req.params;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Body too long' });
  const c = dbmod.addComment({ entryDate: date, author: req.session.role, body });
  await writeCommentsSidecar(date);
  res.json(c);
});

app.delete('/api/comments/:id', requireWriter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = dbmod.getDb().prepare('SELECT entry_date FROM comments WHERE id = ?').get(id);
  dbmod.deleteComment(id);
  if (row) await writeCommentsSidecar(row.entry_date);
  res.json({ ok: true });
});

app.get('/print', requireAuth, async (_req, res) => {
  const entries = dbmod.getDb()
    .prepare('SELECT date, html FROM entries ORDER BY date')
    .all();
  const body = entries.map(e => {
    const d = new Date(e.date + 'T00:00');
    const formatted = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `<article><h2>${formatted}</h2><div class="body ql-editor">${e.html || '<p><em>(empty)</em></p>'}</div></article>`;
  }).join('\n');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Journal — Print</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css">
<style>
  body { font: 12pt/1.5 Georgia, serif; max-width: 7in; margin: 0.5in auto; color: #222; }
  article { page-break-inside: avoid; margin-bottom: 2rem; }
  article + article { border-top: 1px solid #ccc; padding-top: 1.5rem; }
  h2 { color: #8b6f47; font-size: 1.1rem; margin: 0 0 0.5rem; }
  img, iframe { max-width: 100%; page-break-inside: avoid; }
  .print-btn { position: fixed; top: 1rem; right: 1rem; padding: 0.5rem 1rem; background: #8b6f47; color: white; border: 0; border-radius: 4px; cursor: pointer; font: inherit; }
  @media print { .print-btn { display: none; } body { margin: 0; } }
</style></head>
<body><button class="print-btn" onclick="window.print()">Print / Save as PDF</button>${body}</body></html>`);
});

app.get('/api/entries/:date', requireAuth, async (req, res) => {
  const { date } = req.params;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const { htmlFile, photosDir } = entryPaths(date);
  const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
  const photos = (await fs.readdir(photosDir).catch(() => [])).sort();
  res.json({ date, html, photos });
});

app.put('/api/entries/:date', requireWriter, async (req, res) => {
  const { date } = req.params;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
  const { dir, htmlFile, photosDir } = entryPaths(date);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(htmlFile, html, 'utf8');
  const updatedAt = new Date().toISOString();
  const photos = await fs.readdir(photosDir).catch(() => []);
  dbmod.indexEntry({ date, html, updatedAt, photoCount: photos.length });
  res.json({ ok: true, updatedAt });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const { date } = req.params;
      if (!validDate(date)) return cb(new Error('Invalid date'));
      const { photosDir } = entryPaths(date);
      try {
        await fs.mkdir(photosDir, { recursive: true });
        cb(null, photosDir);
      } catch (err) { cb(err); }
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      const safeExt = /^\.(jpg|jpeg|png|gif|webp|heic|heif)$/.test(ext) ? ext : '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  },
});

async function refreshPhotoCount(date) {
  const { photosDir, htmlFile } = entryPaths(date);
  const photos = await fs.readdir(photosDir).catch(() => []);
  const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
  const stat = await fs.stat(htmlFile).catch(() => ({ mtime: new Date() }));
  dbmod.indexEntry({
    date,
    html,
    updatedAt: stat.mtime.toISOString(),
    photoCount: photos.length,
  });
}

app.post('/api/entries/:date/photos', requireWriter, upload.array('photo', 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No file' });
  await refreshPhotoCount(req.params.date);
  res.json({
    files: files.map(f => ({
      filename: f.filename,
      url: `/photos/${req.params.date}/${f.filename}`,
    })),
  });
});

app.delete('/api/entries/:date/photos/:filename', requireWriter, async (req, res) => {
  const { date, filename } = req.params;
  if (!validDate(date) || !safeFilename(filename)) return res.status(400).json({ error: 'Invalid' });
  const { photosDir } = entryPaths(date);
  await fs.unlink(path.join(photosDir, filename)).catch(() => {});
  await refreshPhotoCount(date);
  res.json({ ok: true });
});

app.get('/photos/:date/:filename', requireAuth, (req, res) => {
  const { date, filename } = req.params;
  if (!validDate(date) || !safeFilename(filename)) return res.status(400).end();
  const { photosDir } = entryPaths(date);
  res.sendFile(path.join(photosDir, filename), { maxAge: '1d' });
});

app.get('/api/backup', requireWriter, async (req, res) => {
  const archiver = (await import('archiver')).default;
  res.attachment(`journal-backup-${new Date().toISOString().slice(0, 10)}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error(err); res.end(); });
  archive.pipe(res);
  archive.directory(ENTRIES_DIR, 'entries');
  await archive.finalize();
});

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => {
  if (!req.session.role) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[journal] Listening on 0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('[journal] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[journal] Unhandled rejection:', err);
});
