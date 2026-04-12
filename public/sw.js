// ShareTool Service Worker v3 - Offline-First + Upload Queue
const CACHE_NAME = 'sharetool-v3';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ── Install ──────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS).catch(() => {})
    )
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k.startsWith('sharetool-'))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  // Skip non-GET for cache logic (upload queue handles POST)
  if (request.method !== 'GET') return;

  // Static assets: cache-first
  if (url.pathname.match(/\.(png|json|js|css)$/)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // API GET requests: stale-while-revalidate
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navigation: network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }
});

// ── Message: upload queue sync + cache purge ──────────────────────────
const UPLOAD_QUEUE_DB = 'sharetool-uploads';
const UPLOAD_QUEUE_STORE = 'pending';

self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'QUEUE_UPLOAD') {
    // Enqueue an upload to be processed when online
    openUploadDB().then(db => {
      const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readwrite');
      tx.objectStore(UPLOAD_QUEUE_STORE).add({
        id: Date.now() + '-' + Math.random().toString(36).slice(2),
        endpoint: payload.endpoint,
        body: payload.body,
        headers: payload.headers || {},
        timestamp: Date.now()
      });
      return tx.complete;
    }).catch(() => {});
    // Notify client the upload was queued
    event.ports[0]?.postMessage({ queued: true });
    return;
  }

  if (type === 'SYNC_UPLOADS') {
    // Process all queued uploads
    event.waitUntil(processUploadQueue());
    return;
  }

  if (type === 'PURGE_API_CACHE') {
    // Client asks SW to clear API cache (e.g., after file upload)
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.delete(payload.url))
    );
    return;
  }
});

// ── Background Sync ──────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'upload-sync') {
    event.waitUntil(processUploadQueue());
  }
});

// ── Cache Strategies ─────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Return cached immediately if available, otherwise wait for network
  if (cached) {
    return cached;
  }
  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;

  // Fallback: return cached or offline JSON
  return cached || new Response(JSON.stringify({
    success: false, error: '网络不可用', offline: true, _cached: false
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const root = await caches.match('/');
    return root || new Response('Offline', { status: 503 });
  }
}

// ── Upload Queue (IndexedDB) ──────────────────────────────────────────

function openUploadDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(UPLOAD_QUEUE_DB, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(UPLOAD_QUEUE_STORE)) {
        db.createObjectStore(UPLOAD_QUEUE_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function processUploadQueue() {
  const db = await openUploadDB();
  const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readonly');
  const store = tx.objectStore(UPLOAD_QUEUE_STORE);
  const req = store.getAll();
  const pending = await new Promise(resolve => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });

  if (pending.length === 0) return;

  // Notify all clients that sync started
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'UPLOAD_SYNC_STARTED', count: pending.length }));

  let success = 0, failed = 0;
  for (const item of pending) {
    try {
      const response = await fetch(item.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...item.headers },
        body: typeof item.body === 'string' ? item.body : JSON.stringify(item.body)
      });
      if (response.ok || response.status === 401 || response.status === 409) {
        // Remove from queue on success or auth error (token may be stale)
        const delTx = db.transaction(UPLOAD_QUEUE_STORE, 'readwrite');
        delTx.objectStore(UPLOAD_QUEUE_STORE).delete(item.id);
        success++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  clients.forEach(c => c.postMessage({
    type: 'UPLOAD_SYNC_COMPLETE',
    success,
    failed,
    remaining: failed
  }));
}
