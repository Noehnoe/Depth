// Minimal service worker — its job is to exist so Android Chrome shows
// the "Install app" prompt. The game itself needs the network (multiplayer),
// so we don't bother caching beyond the most basic shell.
const CACHE = 'depth-v1';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Never cache POST / API / socket traffic — the game is online-only.
  if (req.method !== 'GET') return;
  if (req.url.includes('/api/') || req.url.includes('/socket.io/')) return;
  // Network-first, fall back to cache (so updates always reach the user).
  event.respondWith(
    fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(req))
  );
});
