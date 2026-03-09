// NoteFlow Service Worker
const CACHE_VERSION = 'noteflow-v9';
const API_BASE = 'https://noteflow-api.jeppesen.cc/api';

// ── Offline memo queue (stored in SW scope) ───────────────────────────────────
let memoQueue = [];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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

// ── Fetch: handle share-target ────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cache share pending content for PWA share target
  if (url.pathname === '/share-target' && event.request.method === 'GET') {
    event.respondWith((async () => {
      const params = url.searchParams;
      const content = [params.get('title'), params.get('text'), params.get('url')]
        .filter(Boolean).join('\n');
      // Store in cache for the main page to pick up
      const cache = await caches.open('noteflow-v2');
      await cache.put('/__share_pending__', new Response(JSON.stringify({ content }), {
        headers: { 'Content-Type': 'application/json' }
      }));
      return Response.redirect('/', 303);
    })());
    return;
  }
});
