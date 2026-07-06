// Service worker — makes the app installable and caches the shell
const CACHE = 'salescrm-v13';
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

// Network-first for same-origin requests, falling back to cache when offline.
// Cross-origin requests (CDN scripts/fonts, Google Fonts, etc.) are left
// alone entirely — re-fetching them from inside the service worker would
// route them through the page's `connect-src` CSP directive instead of the
// `script-src`/`style-src`/`font-src` directive that actually allows them,
// so intercepting them here silently breaks Chart.js, XLSX export, Leaflet
// maps and WebAuthn even when the CSP is configured to allow those hosts.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
