// In-memory index over the file-based entries + comments sidecar files.
// Rebuilt from disk on startup. All writes go to disk first (source of truth),
// then update this index. If this index is lost, it's rebuilt on next startup.
import path from 'node:path';
import fs from 'node:fs/promises';

// entries map key is entryId: YYYY-MM-DD-HHmmss
const entries = new Map();
let comments = [];
let nextCommentId = 1;

export function idDate(id) { return id.slice(0, 10); }

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function openDb() { /* no-op; kept for API symmetry */ }

export function indexEntry({ id, html, updatedAt, photoCount, published, publishedAt, trashed, trashedAt }) {
  const prev = entries.get(id);
  entries.set(id, {
    html: html ?? prev?.html ?? '',
    plain: stripHtml(html ?? prev?.html ?? ''),
    updatedAt: updatedAt ?? prev?.updatedAt ?? new Date().toISOString(),
    photoCount: photoCount ?? prev?.photoCount ?? 0,
    published: typeof published === 'boolean' ? published : (prev?.published ?? true),
    publishedAt: publishedAt !== undefined ? publishedAt : (prev?.publishedAt ?? null),
    trashed: typeof trashed === 'boolean' ? trashed : (prev?.trashed ?? false),
    trashedAt: trashedAt !== undefined ? trashedAt : (prev?.trashedAt ?? null),
  });
}

export function setPublished(id, published, publishedAt) {
  const e = entries.get(id);
  if (!e) return;
  e.published = !!published;
  e.publishedAt = publishedAt ?? null;
}

export function setTrashed(id, trashed, trashedAt) {
  const e = entries.get(id);
  if (!e) return;
  e.trashed = !!trashed;
  e.trashedAt = trashedAt ?? null;
}

export function getEntry(id) {
  const e = entries.get(id);
  return e ? { id, ...e } : null;
}

export function deleteEntryById(id) {
  entries.delete(id);
  comments = comments.filter(c => c.entry_id !== id);
}

function commentCountFor(entryId) {
  let n = 0;
  for (const c of comments) if (c.entry_id === entryId) n++;
  return n;
}

export function getAllEntries({ publishedOnly = false } = {}) {
  return [...entries.entries()]
    .filter(([, e]) => !e.trashed && (!publishedOnly || e.published))
    .map(([id, e]) => ({ id, date: idDate(id), commentCount: commentCountFor(id), ...e }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function getEntriesForDate(date, { publishedOnly = false } = {}) {
  return [...entries.entries()]
    .filter(([id, e]) => idDate(id) === date && !e.trashed && (!publishedOnly || e.published))
    .map(([id, e]) => ({ id, date: idDate(id), ...e }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getTrashedEntries() {
  return [...entries.entries()]
    .filter(([, e]) => e.trashed)
    .map(([id, e]) => ({ id, date: idDate(id), ...e }))
    .sort((a, b) => (b.trashedAt || '').localeCompare(a.trashedAt || ''));
}

export function getEntriesForHashtagScan() {
  return [...entries.entries()]
    .filter(([, e]) => !e.trashed && e.plain.includes('#'))
    .map(([id, e]) => ({ id, date: idDate(id), plain: e.plain }));
}

async function migrateLegacyEntries(entriesDir) {
  const years = (await fs.readdir(entriesDir, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map(d => d.name);

  for (const year of years) {
    const yearDir = path.join(entriesDir, year);
    const files = await fs.readdir(yearDir).catch(() => []);
    for (const f of files) {
      // Legacy format: YYYY-MM-DD.html (no time suffix)
      const legacy = f.match(/^(\d{4}-\d{2}-\d{2})\.html$/);
      if (!legacy) continue;
      const date = legacy[1];
      const oldHtml = path.join(yearDir, f);
      const stat = await fs.stat(oldHtml);
      const t = stat.mtime;
      const p = (n) => String(n).padStart(2, '0');
      const time = `${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
      const newId = `${date}-${time}`;

      let html = await fs.readFile(oldHtml, 'utf8').catch(() => '');
      html = html.replace(new RegExp(`/photos/${date}/`, 'g'), `/photos/${newId}/`);
      await fs.writeFile(path.join(yearDir, `${newId}.html`), html, 'utf8');
      await fs.unlink(oldHtml);

      const rename = async (oldName, newName) => {
        const oldPath = path.join(yearDir, oldName);
        if (await fs.access(oldPath).then(() => true).catch(() => false)) {
          await fs.rename(oldPath, path.join(yearDir, newName));
        }
      };
      await rename(`${date}.meta.json`, `${newId}.meta.json`);
      await rename(`${date}.comments.json`, `${newId}.comments.json`);
      await rename(date, newId);
      console.log(`[journal] Migrated ${date} → ${newId}`);
    }
  }
}

export async function rebuildFromFiles(entriesDir) {
  entries.clear();
  comments = [];
  nextCommentId = 1;

  await migrateLegacyEntries(entriesDir);

  const years = (await fs.readdir(entriesDir, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map(d => d.name);

  for (const year of years) {
    const yearDir = path.join(entriesDir, year);
    const files = await fs.readdir(yearDir).catch(() => []);
    for (const f of files) {
      const entryMatch = f.match(/^(\d{4}-\d{2}-\d{2}-\d{6})\.html$/);
      const commentMatch = f.match(/^(\d{4}-\d{2}-\d{2}-\d{6})\.comments\.json$/);
      if (entryMatch) {
        const id = entryMatch[1];
        const htmlFile = path.join(yearDir, f);
        const metaFile = path.join(yearDir, `${id}.meta.json`);
        const photosDir = path.join(yearDir, id);
        const html = await fs.readFile(htmlFile, 'utf8').catch(() => '');
        const stat = await fs.stat(htmlFile).catch(() => ({ mtime: new Date() }));
        const photoList = await fs.readdir(photosDir).catch(() => []);
        const metaRaw = await fs.readFile(metaFile, 'utf8').catch(() => null);
        let published = true;
        let publishedAt = null;
        let trashed = false;
        let trashedAt = null;
        if (metaRaw) {
          try {
            const meta = JSON.parse(metaRaw);
            published = meta.published !== false;
            publishedAt = meta.publishedAt || null;
            trashed = meta.trashed === true;
            trashedAt = meta.trashedAt || null;
          } catch {}
        }
        indexEntry({
          id,
          html,
          updatedAt: stat.mtime.toISOString(),
          photoCount: photoList.length,
          published,
          publishedAt,
          trashed,
          trashedAt,
        });
      } else if (commentMatch) {
        const data = await fs.readFile(path.join(yearDir, f), 'utf8').catch(() => '[]');
        try {
          const list = JSON.parse(data);
          for (const c of list) {
            const id = Number(c.id) || nextCommentId++;
            if (id >= nextCommentId) nextCommentId = id + 1;
            comments.push({
              id,
              entry_id: commentMatch[1],
              author: c.author,
              body: c.body,
              created_at: c.created_at,
              parent_id: c.parent_id ?? null,
            });
          }
        } catch { /* skip bad file */ }
      }
    }
  }
}

function buildSnippet(plain, words) {
  const lower = plain.toLowerCase();
  const idx = lower.indexOf(words[0]);
  if (idx === -1) return escapeHtml(plain.slice(0, 100));
  const start = Math.max(0, idx - 30);
  const end = Math.min(plain.length, idx + words[0].length + 80);
  const before = escapeHtml(plain.slice(start, idx));
  const match = escapeHtml(plain.slice(idx, idx + words[0].length));
  const after = escapeHtml(plain.slice(idx + words[0].length, end));
  return (start > 0 ? '…' : '') + before + `<mark>${match}</mark>` + after + (end < plain.length ? '…' : '');
}

export function searchEntries(query, { limit = 200, publishedOnly = false } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = new Map(); // id -> result
  for (const [id, e] of entries) {
    if (e.trashed) continue;
    if (publishedOnly && !e.published) continue;
    const plain = e.plain.toLowerCase();
    if (!words.every(w => plain.includes(w))) continue;
    results.set(id, {
      id,
      date: idDate(id),
      snippet: buildSnippet(e.plain, words),
      matchType: 'entry',
    });
  }
  // Also search comments
  for (const c of comments) {
    const e = entries.get(c.entry_id);
    if (!e) continue;
    if (e.trashed) continue;
    if (publishedOnly && !e.published) continue;
    const body = c.body.toLowerCase();
    if (!words.every(w => body.includes(w))) continue;
    if (!results.has(c.entry_id)) {
      results.set(c.entry_id, {
        id: c.entry_id,
        date: idDate(c.entry_id),
        snippet: buildSnippet(c.body, words),
        matchType: 'comment',
        commentAuthor: c.author,
      });
    } else {
      // Entry already matched — annotate that comments also match
      const r = results.get(c.entry_id);
      r.alsoInComments = true;
    }
  }
  const sorted = [...results.values()].sort((a, b) => b.id.localeCompare(a.id));
  return sorted.slice(0, limit);
}

export function onThisDay(refDate, { publishedOnly = false } = {}) {
  const monthDay = refDate.slice(5);
  return [...entries.entries()]
    .filter(([id, e]) => {
      if (e.trashed) return false;
      const d = idDate(id);
      return d.slice(5) === monthDay && d < refDate && (!publishedOnly || e.published);
    })
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([id, e]) => ({ id, date: idDate(id), html: e.html }));
}

export function randomEntry({ publishedOnly = false } = {}) {
  const all = [...entries.entries()].filter(([, e]) => !e.trashed && e.plain.length > 0 && (!publishedOnly || e.published));
  if (!all.length) return null;
  const [id, e] = all[Math.floor(Math.random() * all.length)];
  return { id, date: idDate(id), html: e.html };
}

export function calendar(year, { publishedOnly = false } = {}) {
  const prefix = String(year);
  const byDate = new Map();
  for (const [id, e] of entries) {
    if (e.trashed) continue;
    if (!idDate(id).startsWith(prefix + '-')) continue;
    if (publishedOnly && !e.published) continue;
    const date = idDate(id);
    const cur = byDate.get(date) || { date, len: 0, photo_count: 0, count: 0 };
    cur.len += e.plain.length;
    cur.photo_count += e.photoCount;
    cur.count += 1;
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function stats({ publishedOnly = false } = {}) {
  const nonEmpty = [...entries.entries()]
    .filter(([, e]) => !e.trashed && e.plain.length > 0 && (!publishedOnly || e.published));
  const total = nonEmpty.length;
  const dates = nonEmpty.map(([d]) => d).sort();
  const first = dates[0] || null;

  let currentStreak = 0;
  let longestStreak = 0;

  if (dates.length) {
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T00:00:00Z').getTime();
      const curr = new Date(dates[i] + 'T00:00:00Z').getTime();
      if (curr - prev === 86400000) streak++;
      else { longestStreak = Math.max(longestStreak, streak); streak = 1; }
    }
    longestStreak = Math.max(longestStreak, streak);

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

  const byMonthMap = new Map();
  for (const [date] of nonEmpty) {
    const m = date.slice(0, 7);
    byMonthMap.set(m, (byMonthMap.get(m) || 0) + 1);
  }
  const byMonth = [...byMonthMap.entries()]
    .map(([month, n]) => ({ month, n }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    total,
    first,
    currentStreak,
    longestStreak,
    byMonth,
    totalComments: comments.length,
  };
}

export function listComments(entryId) {
  return comments
    .filter(c => c.entry_id === entryId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(c => ({ ...c }));
}

export function commentsForEntry(entryId) {
  return comments.filter(c => c.entry_id === entryId);
}

export function addComment({ entryId, author, body, parentId = null }) {
  const c = {
    id: nextCommentId++,
    entry_id: entryId,
    author,
    body,
    created_at: new Date().toISOString(),
    parent_id: parentId,
  };
  comments.push(c);
  return c;
}

export function deleteComment(id) {
  const idx = comments.findIndex(c => c.id === id);
  if (idx >= 0) {
    const removed = comments.splice(idx, 1)[0];
    return removed;
  }
  return null;
}

export function getComment(id) {
  return comments.find(c => c.id === id) || null;
}
