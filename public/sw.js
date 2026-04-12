// ShareTool Service Worker - PWA Offline Support
const CACHE_NAME = 'sharetool-v6.06.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignore cache.addAll failure (e.g. network unavailable at install time)
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - GET /api/* (files list): Network First, fallback to cache
// - GET /* (static assets): Cache First, fallback to network
// - Other: Network only
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isApi = url.pathname.startsWith('/api/');

  if (event.request.method !== 'GET') return;

  if (isApi) {
    // API requests: Network First
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful API responses (except stream/blob)
          if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Static assets: Cache First
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});

// Handle messages from the main thread
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
