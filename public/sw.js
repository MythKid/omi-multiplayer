// Service worker: makes OMI installable and lets it open offline. It
// precaches the app shell, but always prefers the network for it: the client
// must match the server it talks to, so a stale cached copy is only ever an
// offline fallback. The API and the Socket.IO connection are never touched.
//
// The page loads its scripts and styles by fingerprinted URLs
// (/js/app.js?v=...), so copies are stored under their plain path: one entry
// per file, always the latest one fetched, however many versions go by.
const CACHE = 'omi-v4';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/chat.js',
  '/js/leaderboard.js',
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
    caches.open(CACHE)
      // cache: 'reload' skips the browser's HTTP cache, so the shell is
      // fetched fresh rather than copied from an older download.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function remember(key, res) {
  if (res && res.status === 200) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(key, copy));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // third-party (fonts): let it be
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return; // never cache

  // Navigations: fresh app when online, the last good copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => remember('/index.html', res)).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: network first (keeping the cache fresh), cache when offline.
  event.respondWith(
    fetch(req).then((res) => remember(url.pathname, res)).catch(() => caches.match(url.pathname))
  );
});
