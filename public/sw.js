// ShareTool Service Worker - App Shell + File Caching
const SHELL_CACHE = 'sharetool-shell-v1';
const FILE_CACHE = 'sharetool-files-v1';

const SHELL_ASSETS = [
  '/',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      return cache.addAll(SHELL_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== FILE_CACHE).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: route-based caching strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests: network only
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) {
    return;
  }

  // GET file downloads: cache-first, store for offline
  if (event.request.method === 'GET' && (
    url.pathname.startsWith('/api/file/') ||
    url.pathname.startsWith('/s/') ||
    url.pathname.startsWith('/d/')
  )) {
    event.respondWith(
      caches.open(FILE_CACHE).then(cache => {
        return cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => cached); // fallback to stale cache on network failure
        });
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
