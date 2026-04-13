// ShareTool Service Worker - PWA Offline Support
// Cache name is injected server-side: const CACHE_NAME = 'sharetool-vX.Y.Z';
// Static assets to cache on install (cache-first strategy)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico'
];
// IndexedDB config for offline upload queue
const IDB_NAME = 'sharetool-uploads';
const IDB_STORE = 'pending-uploads';
const DB_VERSION = 1;

// Open IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

// Store pending upload in IndexedDB
async function storePendingUpload(file) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.add({ ...file, storedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Get all pending uploads
async function getPendingUploads() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Remove pending upload from IndexedDB
async function removePendingUpload(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Upload a single pending file via fetch
async function uploadPendingFile(item) {
  const { filename, content, type, token } = item;
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (token || '')
    },
    body: JSON.stringify({ filename, content, type })
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status);
  return res.json();
}

// Background sync: upload all pending files
async function syncPendingUploads(client) {
  const pending = await getPendingUploads();
  if (!pending.length) return { success: 0, failed: 0 };

  let success = 0, failed = 0;
  for (const item of pending) {
    try {
      await uploadPendingFile(item);
      await removePendingUpload(item.id);
      success++;
    } catch (e) {
      failed++;
      // Remove if definitively failed (not a transient network error)
      if (e.message.includes('4') || e.message.includes('5')) {
        await removePendingUpload(item.id);
      }
    }
  }

  // Notify all clients
  const msg = { type: 'UPLOAD_SYNC_COMPLETE', success, failed };
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage(msg));
  if (client) client.postMessage(msg);
  return { success, failed };
}

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('sharetool-cache').then(async cache => {
      await cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignore cache.addAll failure (e.g. network unavailable at install time)
      });
      return;
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('sharetool-')).map(k => caches.delete(k))
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
            caches.open('sharetool-cache').then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});

// Handle messages from the main thread
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data === 'skipWaiting' || data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Store a pending upload when going offline
  // Browser sends: { type: 'QUEUE_UPLOAD', file: { filename, content, type, token } }
  if (data.type === 'QUEUE_UPLOAD') {
    const { filename, content, type, token } = data.file || {};
    if (filename && content) {
      storePendingUpload({ filename, content, type: type || 'file', token }).catch(() => {});
    }
    return;
  }

  // Sync pending uploads (called by browser when back online)
  if (data.type === 'SYNC_UPLOADS') {
    syncPendingUploads(event.source).catch(() => {});
  }
});
