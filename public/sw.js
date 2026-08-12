// Service worker for Maxim Realty Attendance - enables "Add to Home Screen" / installable
// PWA behavior and caches the static app shell so the UI still loads (with a clear offline
// notice for data) if the network briefly drops. API calls always go to the network -
// attendance/leave/payroll data is never served stale from cache.
const CACHE_NAME = 'maxim-attendance-shell-v1';
const SHELL_FILES = [
  '/index.html',
  '/dashboard.html',
  '/admin.html',
  '/face-punch.html',
  '/forgot-password.html',
  '/css/style.css',
  '/js/api.js',
  '/js/login.js',
  '/js/dashboard.js',
  '/js/admin.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {}) // don't block install if one file 404s
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or the live SSE feed - always hit the network so data is fresh.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline - fall back to cached shell
      return cached || networkFetch;
    })
  );
});
