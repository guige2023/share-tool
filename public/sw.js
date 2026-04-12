// ShareTool Service Worker - PWA Offline Support
// Version must be updated when static assets change
const CACHE_VERSION = 'v6.12.0';
const CACHE_NAME = 'sharetool-' + CACHE_VERSION;
// Static assets to cache on install (cache-first strategy)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico'
];
// App shell resources to prefetch after install (low priority)
const PREFETCH_ASSETS = [
  '/manifest.json'
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignore cache.addAll failure (e.g. network unavailable at install time)
      });
      // Prefetch additional assets without blocking activation
      fetch('/manifest.json').then(r => r.ok && cache.put('/manifest.json', r)).catch(() => {});
      return;
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
// - GET /api/*: Network Only (never cache — contains file metadata + auth)
// - GET /* (static assets): Cache First, fallback to network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isApi = url.pathname.startsWith('/api/');

  if (event.request.method !== 'GET') return;

  if (isApi) {
    // API requests: always network (never cache file list or metadata)
    return; // let request pass through normally
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
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
