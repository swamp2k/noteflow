// NoteFlow Service Worker
const CACHE_VERSION = 'noteflow-v13';
const API_BASE = 'https://noteflow-api.jeppesen.cc/api';

// ── Offline memo queue (stored in SW scope) ───────────────────────────────────
let memoQueue = [];

// Install immediately — don't block on cache fetches (they can fail due to auth etc.)
self.addEventListener('install', () => self.skipWaiting());

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
        if (r.ok) synced++;
        else remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }
    memoQueue = remaining;
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

  // Share target
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

  // Navigation requests: network first, cache the response, fall back to cache
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const networkResponse = await fetch(event.request);
        // Only cache successful HTML responses (not CF Access login redirects)
        if (networkResponse.ok && networkResponse.type !== 'opaqueredirect') {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        // Offline — serve cached page
        const cached = await cache.match(event.request)
                    || await cache.match('/')
                    || await cache.match('/index.html');
        if (cached) return cached;
        return new Response('<h2>Offline</h2><p>Open NoteFlow while online first to enable offline access.</p>', {
          status: 503, headers: { 'Content-Type': 'text/html' }
        });
      }
    })());
    return;
  }

  // Static assets (same origin, GET only): cache first
  if (url.origin === self.location.origin && event.request.method === 'GET') {
    const ext = url.pathname.split('.').pop();
    if (['png', 'ico', 'svg', 'webp', 'woff2'].includes(ext)) {
      event.respondWith(
        caches.match(event.request).then(cached =>
          cached || fetch(event.request).then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
            }
            return res;
          })
        )
      );
    }
  }
});
