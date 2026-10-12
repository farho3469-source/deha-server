self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
