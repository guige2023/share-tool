// ShareTool Service Worker - App Shell + File Caching + Offline Queue
const SHELL_CACHE = 'sharetool-shell-v2';
const FILE_CACHE = 'sharetool-files-v2';
const MAX_FILE_CACHE_SIZE = 50; // max cached file entries
const MAX_FILE_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB cap

// Track cache size for eviction
const CACHE_SIZE_KEY = 'file-cache-size';

// Helper: get approximate cache size from Storage API
async function getCacheSize() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return est.usage || 0;
  }
  return 0;
}

// Helper: evict oldest entries when over limit
async function evictIfNeeded(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_FILE_CACHE_SIZE) {
    // Remove oldest entries (FIFO) to get back under limit
    const toRemove = keys.slice(0, keys.length - MAX_FILE_CACHE_SIZE);
    await Promise.all(toRemove.map(k => cache.delete(k)));
  }
  // Also check Storage API quota
  const size = await getCacheSize();
  if (size > MAX_FILE_CACHE_BYTES) {
    // Remove oldest half
    const half = Math.floor(keys.length / 2);
    const toRemove = keys.slice(0, half);
    await Promise.all(toRemove.map(k => cache.delete(k)));
  }
}

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      return cache.addAll([
        '/',
        '/icon-192.png',
        '/icon-512.png',
        '/manifest.json'
      ]);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => !k.startsWith('sharetool-')).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: route-based caching strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests: network only (except static assets)
  if (url.pathname.startsWith('/api') && !url.pathname.startsWith('/api/storage/icon')) {
    return;
  }

  // GET file downloads: cache-first, store for offline
  if (event.request.method === 'GET' && (
    url.pathname.startsWith('/api/file/') ||
    url.pathname.startsWith('/s/') ||
    url.pathname.startsWith('/d/')
  )) {
    event.respondWith(
      caches.open(FILE_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response.ok) {
            await evictIfNeeded(cache);
            cache.put(event.request, response.clone());
          }
          return response;
        } catch {
          // Network failed and no cache — return offline error
          return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })
    );
    return;
  }

  // Static assets / navigation: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

// Handle messages from main thread
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  // Clear file cache on user request
  if (event.data === 'clearFileCache') {
    caches.delete(FILE_CACHE).then(() => {
      event.ports[0].postMessage({ ok: true });
    });
    return;
  }
  // Get cache stats
  if (event.data === 'getCacheStats') {
    caches.open(FILE_CACHE).then(async cache => {
      const keys = await cache.keys();
      const size = await getCacheSize();
      event.ports[0].postMessage({ count: keys.length, bytes: size });
    });
  }
});
