// Service worker — installable PWA shell + fast repeat loads.
// v14: switched static assets from network-first to CACHE-FIRST. app.js/style.css
// carry a ?v= cache-buster, so a new deploy is a new URL (cache miss → refetch);
// cached copies are therefore always safe and never stale. Navigations stay
// network-first so a fresh index.html (with the new ?v=) is always picked up.
const CACHE = 'salescrm-v14';
const SHELL = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Cross-origin (CDN scripts/fonts/tiles) are left entirely alone — re-fetching
  // them from inside the SW would route them through connect-src instead of the
  // script-src/style-src/font-src directive that actually allows them.
  if (url.origin !== self.location.origin) return;
  // Never cache the API or the socket transport.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // App shell / navigations → network-first (pick up a new deploy's HTML), with
  // a cache fallback so the app still opens offline.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then(m => m || caches.match('/')))
    );
    return;
  }

  // Versioned static assets (app.js?v=, style.css?v=, images, the splash video,
  // icons) → cache-first: instant on repeat loads, fetched + cached on first miss.
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      });
    })
  );
});
