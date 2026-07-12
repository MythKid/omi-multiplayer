// Service worker: makes OMI installable and fast to load. It precaches the
// app shell and serves static assets from cache, but never touches the API or
// the Socket.IO connection, which must always go straight to the network.
const CACHE = 'omi-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/socket.io.min.js',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  '/icons/favicon.svg',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // third-party (fonts): let it be
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return; // never cache

  // Navigations: fresh app when online, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
