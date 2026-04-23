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

const WRITER_NAME_FILE = path.join(ENTRIES_DIR, 'writer-name.json');
const DEFAULT_WRITER_NAME = 'NanDong';
async function getWriterName() {
  try {
    const raw = await fs.readFile(WRITER_NAME_FILE, 'utf8');
    const name = JSON.parse(raw).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {}
  return DEFAULT_WRITER_NAME;
}
async function setWriterName(name) {
  if (name) await fs.writeFile(WRITER_NAME_FILE, JSON.stringify({ name }, null, 2), 'utf8');
  else await fs.unlink(WRITER_NAME_FILE).catch(() => {});
}

try {
  dbmod.openDb();
  await dbmod.rebuildFromFiles(ENTRIES_DIR);
  console.log('[journal] In-memory index built from', ENTRIES_DIR);
} catch (err) {
  console.error('[journal] Failed to build index', err);
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
  res.json({
    role: req.session.role || null,
    nickname: req.session.nickname || null,
  });
});

app.patch('/api/me', (req, res, next) => {
  if (!req.session.role) return res.status(401).json({ error: 'Not logged in' });
  next();
}, (req, res) => {
  let nickname = String((req.body || {}).nickname || '').trim();
  nickname = nickname.replace(/[<>]/g, '').slice(0, 40);
  req.session.nickname = nickname || null;
  res.json({ role: req.session.role, nickname: req.session.nickname });
});

app.get('/api/author', async (_req, res) => {
  res.json({ name: await getWriterName() });
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

function validId(s) {
  if (!/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(s)) return false;
  return validDate(s.slice(0, 10));
}

function safeFilename(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

function entryPaths(id) {
  const year = id.slice(0, 4);
  const dir = path.join(ENTRIES_DIR, year);
  return {
    dir,
    htmlFile: path.join(dir, `${id}.html`),
    metaFile: path.join(dir, `${id}.meta.json`),
    commentsFile: path.join(dir, `${id}.comments.json`),
    photosDir: path.join(dir, id),
  };
}

function newEntryId(forDate, clientTime) {
  const p = (n) => String(n).padStart(2, '0');
  let time;
  if (typeof clientTime === 'string' && /^\d{6}$/.test(clientTime)) {
    time = clientTime;
  } else {
    const now = new Date();
    time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  }
  return `${forDate}-${time}`;
}

async function writeMeta(id, fields) {
  const { dir, metaFile } = entryPaths(id);
  await fs.mkdir(dir, { recursive: true });
  // Merge with existing meta so we don't wipe unrelated fields.
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(metaFile, 'utf8')); } catch {}
  const merged = {
    published: existing.published !== false,
    publishedAt: existing.publishedAt || null,
    trashed: existing.trashed === true,
    trashedAt: existing.trashedAt || null,
    ...fields,
  };
  await fs.writeFile(metaFile, JSON.stringify(merged, null, 2), 'utf8');
}

function isReader(req) { return req.session.role === 'reader'; }

app.get('/api/entries', requireAuth, (req, res) => {
  const all = dbmod.getAllEntries({ publishedOnly: isReader(req) });
  res.json(all.map(({ id, date, updatedAt, published, publishedAt, plain }) => ({
    id, date, updatedAt, published, publishedAt,
    wordCount: plain ? (plain.match(/\S+/g) || []).length : 0,
  })));
});

app.get('/api/entries-for-date', requireAuth, (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const list = dbmod.getEntriesForDate(date, { publishedOnly: isReader(req) });
  res.json(list.map(({ id, updatedAt, published, publishedAt, plain }) => ({
    id, updatedAt, published, publishedAt,
    wordCount: plain ? (plain.match(/\S+/g) || []).length : 0,
  })));
});

app.post('/api/entries', requireWriter, async (req, res) => {
  const date = String((req.body || {}).date || '').trim();
  const clientTime = String((req.body || {}).time || '').trim();
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });
  let id = newEntryId(date, clientTime);
  let attempts = 0;
  while (dbmod.getEntry(id) && attempts < 60) {
    const [d, t] = [id.slice(0, 10), id.slice(11)];
    const secs = Number(t.slice(4)) + 1;
    const bumped = t.slice(0, 4) + String(secs % 60).padStart(2, '0');
    id = `${d}-${bumped}`;
    attempts++;
  }
  const { dir, htmlFile } = entryPaths(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(htmlFile, '', 'utf8');
  await writeMeta(id, { published: false, publishedAt: null });
  dbmod.indexEntry({ id, html: '', updatedAt: new Date().toISOString(), photoCount: 0, published: false, publishedAt: null });
  res.json({ id });
});

async function writeCommentsSidecar(entryId) {
  const comments = dbmod.listComments(entryId);
  const { dir, commentsFile } = entryPaths(entryId);
  if (!comments.length) {
    await fs.unlink(commentsFile).catch(() => {});
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2), 'utf8');
}

app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(dbmod.searchEntries(q, { publishedOnly: isReader(req) }));
});

app.get('/api/on-this-day', requireAuth, (req, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!validDate(ref)) return res.status(400).json({ error: 'Invalid ref date' });
  res.json(dbmod.onThisDay(ref, { publishedOnly: isReader(req) }));
});

app.get('/api/random', requireAuth, (req, res) => {
  res.json(dbmod.randomEntry({ publishedOnly: isReader(req) }));
});

app.get('/api/tags', requireAuth, (req, res) => {
  const rows = dbmod.getEntriesForHashtagScan();
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
  res.json({ year, entries: dbmod.calendar(year, { publishedOnly: isReader(req) }) });
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(dbmod.stats({ publishedOnly: isReader(req) }));
});

app.get('/api/comments/:entryId', requireAuth, (req, res) => {
  const { entryId } = req.params;
  if (!validId(entryId)) return res.status(400).json({ error: 'Invalid entry id' });
  if (isReader(req)) {
    const indexed = dbmod.getEntry(entryId);
    if (!indexed || !indexed.published) return res.status(404).json({ error: 'Not found' });
  }
  res.json(dbmod.listComments(entryId));
});

app.post('/api/comments/:entryId', requireAuth, async (req, res) => {
  const { entryId } = req.params;
  if (!validId(entryId)) return res.status(400).json({ error: 'Invalid entry id' });
  if (isReader(req)) {
    const indexed = dbmod.getEntry(entryId);
    if (!indexed || !indexed.published) return res.status(404).json({ error: 'Not found' });
  }
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Body too long' });
  let parentId = null;
  if ((req.body || {}).parentId != null) {
    const pid = Number(req.body.parentId);
    if (!Number.isInteger(pid)) return res.status(400).json({ error: 'Invalid parentId' });
    const parent = dbmod.getComment(pid);
    if (!parent || parent.entry_id !== entryId) return res.status(400).json({ error: 'Parent not found' });
    parentId = pid;
  }
  const author = req.session.nickname || req.session.role;
  const c = dbmod.addComment({ entryId, author, body, parentId });
  await writeCommentsSidecar(entryId);
  res.json(c);
});

app.delete('/api/comments/:commentId', requireWriter, async (req, res) => {
  const cid = Number(req.params.commentId);
  if (!Number.isInteger(cid)) return res.status(400).json({ error: 'Invalid id' });
  const existing = dbmod.getComment(cid);
  dbmod.deleteComment(cid);
  if (existing) await writeCommentsSidecar(existing.entry_id);
  res.json({ ok: true });
});

app.get('/print', requireAuth, async (req, res) => {
  const entries = dbmod.getAllEntries({ publishedOnly: isReader(req) })
    .sort((a, b) => a.id.localeCompare(b.id));
  const body = entries.map(e => {
    const d = new Date(e.date + 'T00:00');
    const formatted = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const time = e.id.slice(11).match(/.{2}/g).slice(0, 2).join(':');
    return `<article><h2>${formatted} — ${time}</h2><div class="body ql-editor">${e.html || '<p><em>(empty)</em></p>'}</div></article>`;
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

app.get('/api/entries/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const indexed = dbmod.getEntry(id);
  if (!indexed) return res.status(404).json({ error: 'Not found' });
  if (isReader(req) && (!indexed.published || indexed.trashed)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { htmlFile, photosDir } = entryPaths(id);
  const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
  const photos = (await fs.readdir(photosDir).catch(() => [])).sort();
  res.json({
    id,
    date: id.slice(0, 10),
    html,
    photos,
    published: indexed.published,
    publishedAt: indexed.publishedAt,
    updatedAt: indexed.updatedAt,
  });
});

app.put('/api/entries/:id', requireWriter, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
  const { dir, htmlFile, photosDir } = entryPaths(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(htmlFile, html, 'utf8');

  const updatedAt = new Date().toISOString();
  const photos = await fs.readdir(photosDir).catch(() => []);
  dbmod.indexEntry({ id, html, updatedAt, photoCount: photos.length });

  const cur = dbmod.getEntry(id);
  res.json({ ok: true, updatedAt, published: cur?.published, publishedAt: cur?.publishedAt });
});

app.delete('/api/entries/:id', requireWriter, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const entry = dbmod.getEntry(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const trashedAt = new Date().toISOString();
  await writeMeta(id, { trashed: true, trashedAt });
  dbmod.setTrashed(id, true, trashedAt);
  res.json({ ok: true, trashed: true });
});

app.get('/api/trash', requireWriter, (req, res) => {
  const list = dbmod.getTrashedEntries();
  res.json(list.map(({ id, date, trashedAt, published, plain }) => ({
    id, date, trashedAt, published,
    wordCount: plain ? (plain.match(/\S+/g) || []).length : 0,
    snippet: plain ? plain.slice(0, 140) : '',
  })));
});

app.post('/api/entries/:id/restore', requireWriter, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const entry = dbmod.getEntry(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  await writeMeta(id, { trashed: false, trashedAt: null });
  dbmod.setTrashed(id, false, null);
  res.json({ ok: true });
});

app.delete('/api/entries/:id/permanent', requireWriter, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const { htmlFile, metaFile, commentsFile, photosDir } = entryPaths(id);
  await fs.unlink(htmlFile).catch(() => {});
  await fs.unlink(metaFile).catch(() => {});
  await fs.unlink(commentsFile).catch(() => {});
  await fs.rm(photosDir, { recursive: true, force: true }).catch(() => {});
  dbmod.deleteEntryById(id);
  res.json({ ok: true });
});

app.post('/api/trash/empty', requireWriter, async (req, res) => {
  const trashed = dbmod.getTrashedEntries();
  for (const e of trashed) {
    const { htmlFile, metaFile, commentsFile, photosDir } = entryPaths(e.id);
    await fs.unlink(htmlFile).catch(() => {});
    await fs.unlink(metaFile).catch(() => {});
    await fs.unlink(commentsFile).catch(() => {});
    await fs.rm(photosDir, { recursive: true, force: true }).catch(() => {});
    dbmod.deleteEntryById(e.id);
  }
  res.json({ ok: true, count: trashed.length });
});

app.post('/api/entries/:id/publish', requireWriter, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid id' });
  const published = !!(req.body && req.body.published);
  const publishedAt = published ? new Date().toISOString() : null;
  const { htmlFile } = entryPaths(id);
  const exists = await fs.access(htmlFile).then(() => true).catch(() => false);
  if (!exists) return res.status(404).json({ error: 'Entry does not exist' });
  await writeMeta(id, { published, publishedAt });
  dbmod.setPublished(id, published, publishedAt);
  res.json({ ok: true, published, publishedAt });
});

const MEDIA_EXT = {
  image: /^\.(jpg|jpeg|png|gif|webp|heic|heif)$/i,
  audio: /^\.(mp3|m4a|aac|ogg|oga|wav|flac)$/i,
};

function makeMediaUpload(kind) {
  return multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const { id } = req.params;
        if (!validId(id)) return cb(new Error('Invalid entry id'));
        const { photosDir } = entryPaths(id);
        try {
          await fs.mkdir(photosDir, { recursive: true });
          cb(null, photosDir);
        } catch (err) { cb(err); }
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const defaultExt = kind === 'audio' ? '.mp3' : '.jpg';
        const re = MEDIA_EXT[kind];
        const safeExt = re.test(ext) ? ext : defaultExt;
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const re = new RegExp(`^${kind}/`);
      if (re.test(file.mimetype)) cb(null, true);
      else cb(new Error(`${kind} files only`));
    },
  });
}

const upload = makeMediaUpload('image');
const audioUpload = makeMediaUpload('audio');

async function refreshPhotoCount(id) {
  const { photosDir, htmlFile } = entryPaths(id);
  const photos = await fs.readdir(photosDir).catch(() => []);
  const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
  const stat = await fs.stat(htmlFile).catch(() => ({ mtime: new Date() }));
  dbmod.indexEntry({
    id,
    html,
    updatedAt: stat.mtime.toISOString(),
    photoCount: photos.length,
  });
}

app.post('/api/entries/:id/photos', requireWriter, upload.array('photo', 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No file' });
  await refreshPhotoCount(req.params.id);
  res.json({
    files: files.map(f => ({
      filename: f.filename,
      url: `/photos/${req.params.id}/${f.filename}`,
    })),
  });
});

app.post('/api/entries/:id/audio', requireWriter, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  await refreshPhotoCount(req.params.id);
  res.json({
    filename: req.file.filename,
    url: `/photos/${req.params.id}/${req.file.filename}`,
  });
});

app.delete('/api/entries/:id/photos/:filename', requireWriter, async (req, res) => {
  const { id, filename } = req.params;
  if (!validId(id) || !safeFilename(filename)) return res.status(400).json({ error: 'Invalid' });
  const { photosDir } = entryPaths(id);
  await fs.unlink(path.join(photosDir, filename)).catch(() => {});
  await refreshPhotoCount(id);
  res.json({ ok: true });
});

app.get('/photos/:id/:filename', requireAuth, (req, res) => {
  const { id, filename } = req.params;
  if (!validId(id) || !safeFilename(filename)) return res.status(400).end();
  if (isReader(req)) {
    const indexed = dbmod.getEntry(id);
    if (!indexed || !indexed.published) return res.status(404).end();
  }
  const { photosDir } = entryPaths(id);
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
