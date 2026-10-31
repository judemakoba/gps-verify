/* GPS Verify — service worker
 * Caches the app shell (HTML/CSS/icons) so the app opens and shows the login
 * screen even with no connectivity at a tower site. API calls are never cached
 * — an audit confirmation must always reach the server to be recorded.
 */
const VERSION = 'gps-verify-v1';
const SHELL_CACHE = `${VERSION}-shell`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/favicon-32.png',
  '/vendor/bootstrap.min.css',
  '/vendor/bootstrap-icons/bootstrap-icons.min.css',
  '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
  '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll fails the whole install if any single asset 404s, so add
      // them individually and tolerate misses.
      .then((cache) => Promise.all(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => undefined)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic — audits must hit the server.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets: cache first, then refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
