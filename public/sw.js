// ShareTool Service Worker - Offline Page Serving
const CACHE_NAME = 'sharetool-v1';

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin navigation requests
  if (url.origin !== location.origin) return;
  if (request.method !== 'GET') return;

  // API and WebSocket: always go to network (no caching)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Navigation request (main page): network-first, fallback to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful page response for offline use
          if (response.status === 200) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return response;
        })
        .catch(() => {
          // Network failed: try cache
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // Last resort: return offline page
            return caches.match('/').then((root) => {
              return root || new Response('Offline', { status: 503 });
            });
          });
        })
    );
    return;
  }
});
