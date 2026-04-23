import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const ENTRIES_DIR = process.env.ENTRIES_DIR
  ? path.resolve(process.env.ENTRIES_DIR)
  : path.resolve(__dirname, '..', '..', 'entries');
const WRITER_PASSWORD = process.env.WRITER_PASSWORD;
const READER_PASSWORD = process.env.READER_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!WRITER_PASSWORD || !READER_PASSWORD || !SESSION_SECRET) {
  console.error('WRITER_PASSWORD, READER_PASSWORD, and SESSION_SECRET must be set. See .env.example');
  process.exit(1);
}

await fs.mkdir(ENTRIES_DIR, { recursive: true });

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
  const { dir, htmlFile } = entryPaths(date);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(htmlFile, html, 'utf8');
  res.json({ ok: true, updatedAt: new Date().toISOString() });
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

app.post('/api/entries/:date/photos', requireWriter, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    filename: req.file.filename,
    url: `/photos/${req.params.date}/${req.file.filename}`,
  });
});

app.delete('/api/entries/:date/photos/:filename', requireWriter, async (req, res) => {
  const { date, filename } = req.params;
  if (!validDate(date) || !safeFilename(filename)) return res.status(400).json({ error: 'Invalid' });
  const { photosDir } = entryPaths(date);
  await fs.unlink(path.join(photosDir, filename)).catch(() => {});
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

app.listen(PORT, () => {
  console.log(`Journal server listening on http://localhost:${PORT}`);
  console.log(`Entries directory: ${ENTRIES_DIR}`);
});
