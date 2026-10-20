/* Деҳа — service worker: огоҳинома (push) барои паём ва занг */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { title: 'Деҳа', body: e.data ? e.data.text() : '' };
  }
  const opt = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    requireInteraction: !!d.requireInteraction,
    data: { type: d.type || '' },
  };
  if (d.tag) {
    opt.tag = d.tag;
    opt.renotify = !!d.renotify;
  }
  if (d.vibrate) opt.vibrate = d.vibrate;
  let job = self.registration.showNotification(d.title || 'Деҳа', opt);
  if (d.type === 'call') {
    // огоҳиномаи занг баъди 40 сония худаш пӯшида мешавад
    job = job
      .then(() => new Promise((r) => setTimeout(r, 40000)))
      .then(() => self.registration.getNotifications({ tag: 'call' }))
      .then((l) => l.forEach((n) => n.close()));
  }
  e.waitUntil(job);
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
