// Offline support. App shell (HTML/manifest/sw) is network-first so updates show up immediately;
// hashed assets and the OCR engine are cache-first so it works offline after the first load.
const CACHE = 'webreader-local-v2';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  const shell = req.mode === 'navigate' || /\/(sw\.js|manifest\.webmanifest)$/.test(req.url);
  e.respondWith(caches.open(CACHE).then(async (c) => {
    if (shell) {
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch { return (await c.match(req)) || (await c.match('./')) || Response.error(); }
    }
    const hit = await c.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  }));
});
