const V = 'deha-shell-v1';
async function okFor(u, r) {
  if (!r || !r.ok) return false;
  if (u === '/') return (await r.clone().text()).includes('id="hdr"');
  return (r.headers.get('content-type') || '').includes('javascript');
}
async function tell() {
  for (const c of await self.clients.matchAll()) c.postMessage({ updated: true });
}
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(V).then(async (c) => {
      for (const u of ['/', '/socket.io/socket.io.js']) {
        try {
          const r = await fetch(u, { cache: 'no-store' });
          if (await okFor(u, r)) await c.put(u, r);
        } catch (_) {}
      }
    })
  );
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
      await self.clients.claim();
    })()
  )
);
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const key =
    req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html'
      ? '/'
      : url.pathname === '/socket.io/socket.io.js'
      ? url.pathname
      : null;
  if (!key) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(V);
      const cached = await cache.match(key);
      const refresh = fetch(key, { cache: 'no-store' })
        .then(async (r) => {
          if (await okFor(key, r)) {
            if (key === '/' && cached) {
              const a = await cached.clone().text();
              const b = await r.clone().text();
              if (a !== b) await tell();
            }
            await cache.put(key, r.clone());
          }
          return r;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(refresh);
        return cached;
      }
      const r = await refresh;
      return r || new Response('Сервер ҷавоб намедиҳад', { status: 503 });
    })()
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (_) {}
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (d.tag !== 'test' && list.some((c) => c.visibilityState === 'visible')) return;
      await self.registration.showNotification(d.title || 'Деҳа', {
        body: d.body || '',
        tag: d.tag || 'deha',
        renotify: true,
        vibrate: [200, 100, 200],
      });
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (list.length) {
        try {
          await list[0].focus();
          return;
        } catch (_) {}
      }
      await self.clients.openWindow('/');
    })()
  );
});
