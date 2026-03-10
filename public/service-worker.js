// NoteFlow Service Worker
const CACHE_VERSION = 'noteflow-v10';
const API_BASE = 'https://noteflow-api.jeppesen.cc/api';

// Files to cache for offline app shell
const APP_SHELL = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
];

// ── Offline memo queue (stored in SW scope) ───────────────────────────────────
let memoQueue = [];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION && k !== 'noteflow-v2')
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};
  const client = event.source;

  if (type === 'QUEUE_MEMO') {
    // payload: { content, token }
    memoQueue.push({ content: payload.content, token: payload.token, ts: Date.now() });
    client.postMessage({ type: 'QUEUE_SIZE', size: memoQueue.length });
    return;
  }

  if (type === 'GET_QUEUE_SIZE') {
    client.postMessage({ type: 'QUEUE_SIZE', size: memoQueue.length });
    return;
  }

  if (type === 'SYNC_QUEUE') {
    if (memoQueue.length === 0) return;
    let synced = 0;
    const remaining = [];
    for (const item of memoQueue) {
      try {
        const r = await fetch(API_BASE + '/notes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + item.token,
          },
          body: JSON.stringify({ content: item.content }),
        });
        if (r.ok) {
          synced++;
        } else {
          remaining.push(item);
        }
      } catch {
        remaining.push(item);
      }
    }
    memoQueue = remaining;
    // Notify all clients
    const allClients = await self.clients.matchAll();
    for (const c of allClients) {
      c.postMessage({ type: 'QUEUE_FLUSHED', synced, remaining: memoQueue.length });
      c.postMessage({ type: 'QUEUE_SIZE', size: memoQueue.length });
    }
    return;
  }
});

// ── Fetch handler ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cache share pending content for PWA share target
  if (url.pathname === '/share-target' && event.request.method === 'GET') {
    event.respondWith((async () => {
      const params = url.searchParams;
      const content = [params.get('title'), params.get('text'), params.get('url')]
        .filter(Boolean).join('\n');
      const cache = await caches.open('noteflow-v2');
      await cache.put('/__share_pending__', new Response(JSON.stringify({ content }), {
        headers: { 'Content-Type': 'application/json' }
      }));
      return Response.redirect('/', 303);
    })());
    return;
  }

  // App shell: navigation requests → network first, fall back to cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request);
        // Update cache with fresh copy
        const cache = await caches.open(CACHE_VERSION);
        cache.put(event.request, networkResponse.clone());
        return networkResponse;
      } catch {
        const cached = await caches.match('/index.html');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Static assets (icons etc): cache first
  if (url.origin === self.location.origin && APP_SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }
});
