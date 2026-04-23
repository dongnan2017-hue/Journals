import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs/promises';

let db = null;

export function openDb(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      date TEXT PRIMARY KEY,
      html TEXT NOT NULL DEFAULT '',
      plain TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      photo_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      date UNINDEXED,
      plain,
      content='entries',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, date, plain) VALUES (new.rowid, new.date, new.plain);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, date, plain) VALUES('delete', old.rowid, old.date, old.plain);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, date, plain) VALUES('delete', old.rowid, old.date, old.plain);
      INSERT INTO entries_fts(rowid, date, plain) VALUES (new.rowid, new.date, new.plain);
    END;

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_date, created_at);
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const upsertEntry = () => db.prepare(`
  INSERT INTO entries (date, html, plain, updated_at, photo_count)
  VALUES (@date, @html, @plain, @updated_at, @photo_count)
  ON CONFLICT(date) DO UPDATE SET
    html = excluded.html,
    plain = excluded.plain,
    updated_at = excluded.updated_at,
    photo_count = excluded.photo_count
`);

export function indexEntry({ date, html, updatedAt, photoCount }) {
  upsertEntry().run({
    date,
    html,
    plain: stripHtml(html),
    updated_at: updatedAt,
    photo_count: photoCount ?? 0,
  });
}

export function deleteEntry(date) {
  db.prepare('DELETE FROM entries WHERE date = ?').run(date);
}

export async function rebuildFromFiles(entriesDir) {
  const years = (await fs.readdir(entriesDir, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map(d => d.name);

  // Collect all file data async first (no DB calls)
  const entryRows = [];
  const commentRows = [];
  for (const year of years) {
    const yearDir = path.join(entriesDir, year);
    const files = await fs.readdir(yearDir).catch(() => []);
    for (const f of files) {
      const entryMatch = f.match(/^(\d{4}-\d{2}-\d{2})\.html$/);
      const commentMatch = f.match(/^(\d{4}-\d{2}-\d{2})\.comments\.json$/);
      if (entryMatch) {
        const date = entryMatch[1];
        const htmlFile = path.join(yearDir, f);
        const photosDir = path.join(yearDir, date);
        const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
        const stat = await fs.stat(htmlFile);
        const photoList = await fs.readdir(photosDir).catch(() => []);
        entryRows.push({
          date,
          html,
          plain: stripHtml(html),
          updated_at: stat.mtime.toISOString(),
          photo_count: photoList.length,
        });
      } else if (commentMatch) {
        const data = await fs.readFile(path.join(yearDir, f), 'utf8').catch(() => '[]');
        try {
          const list = JSON.parse(data);
          for (const c of list) {
            commentRows.push({
              entry_date: commentMatch[1],
              author: c.author,
              body: c.body,
              created_at: c.created_at,
            });
          }
        } catch { /* skip bad file */ }
      }
    }
  }

  // Now do all DB writes synchronously in a transaction
  const upsert = db.prepare(`
    INSERT INTO entries (date, html, plain, updated_at, photo_count)
    VALUES (@date, @html, @plain, @updated_at, @photo_count)
    ON CONFLICT(date) DO UPDATE SET
      html = excluded.html,
      plain = excluded.plain,
      updated_at = excluded.updated_at,
      photo_count = excluded.photo_count
  `);
  const insertComment = db.prepare(
    'INSERT INTO comments (entry_date, author, body, created_at) VALUES (@entry_date, @author, @body, @created_at)'
  );
  const tx = db.transaction(() => {
    for (const row of entryRows) upsert.run(row);
    db.prepare('DELETE FROM comments').run();
    for (const row of commentRows) insertComment.run(row);
  });
  tx();
}

export function searchEntries(query, limit = 200) {
  if (!query.trim()) return [];
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/["']/g, '').replace(/[^\w]/g, ''))
    .filter(Boolean)
    .map(w => `"${w}"*`)
    .join(' ');
  if (!ftsQuery) return [];
  try {
    return db.prepare(`
      SELECT e.date, snippet(entries_fts, 1, '<mark>', '</mark>', '…', 20) AS snippet
      FROM entries_fts f
      JOIN entries e ON e.rowid = f.rowid
      WHERE f.plain MATCH ?
      ORDER BY e.date DESC
      LIMIT ?
    `).all(ftsQuery, limit);
  } catch {
    return [];
  }
}

export function onThisDay(refDate) {
  const monthDay = refDate.slice(5);
  return db.prepare(`
    SELECT date, html FROM entries
    WHERE substr(date, 6) = ? AND date < ?
    ORDER BY date DESC
  `).all(monthDay, refDate);
}

export function calendar(year) {
  return db.prepare(`
    SELECT date, length(plain) AS len, photo_count
    FROM entries
    WHERE substr(date, 1, 4) = ?
    ORDER BY date
  `).all(String(year));
}

export function stats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE length(plain) > 0').get().n;
  const firstRow = db.prepare('SELECT MIN(date) AS first FROM entries WHERE length(plain) > 0').get();
  const first = firstRow.first;

  const dates = db.prepare(
    'SELECT date FROM entries WHERE length(plain) > 0 ORDER BY date'
  ).all().map(r => r.date);

  let currentStreak = 0, longestStreak = 0;
  if (dates.length) {
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T00:00:00Z').getTime();
      const curr = new Date(dates[i] + 'T00:00:00Z').getTime();
      if (curr - prev === 86400000) streak++;
      else { longestStreak = Math.max(longestStreak, streak); streak = 1; }
    }
    longestStreak = Math.max(longestStreak, streak);

    // Current streak: count back from today
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    let cursor = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const dateSet = new Set(dates);
    while (dateSet.has(cursor)) {
      currentStreak++;
      const d = new Date(cursor + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      cursor = d.toISOString().slice(0, 10);
    }
  }

  const byMonth = db.prepare(`
    SELECT substr(date, 1, 7) AS month, COUNT(*) AS n
    FROM entries WHERE length(plain) > 0
    GROUP BY month ORDER BY month
  `).all();

  const totalComments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;

  return { total, first, currentStreak, longestStreak, byMonth, totalComments };
}

export function listComments(entryDate) {
  return db.prepare(
    'SELECT id, author, body, created_at FROM comments WHERE entry_date = ? ORDER BY created_at'
  ).all(entryDate);
}

export function addComment({ entryDate, author, body }) {
  const createdAt = new Date().toISOString();
  const r = db.prepare(
    'INSERT INTO comments (entry_date, author, body, created_at) VALUES (?, ?, ?, ?)'
  ).run(entryDate, author, body, createdAt);
  return { id: r.lastInsertRowid, entry_date: entryDate, author, body, created_at: createdAt };
}

export function deleteComment(id) {
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}

export function listCommentsForDate(date) {
  return listComments(date);
}
