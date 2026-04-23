const CACHE = 'journal-v1';
const SHELL = [
  '/static/styles.css',
  '/static/app.js',
  '/static/icon.svg',
  '/static/manifest.json',
  'https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css',
  'https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API or photo responses — those must be live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/')) return;

  // Cache-first for static shell.
  if (url.pathname.startsWith('/static/') || url.origin.includes('jsdelivr.net')) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => hit))
    );
  }
});
