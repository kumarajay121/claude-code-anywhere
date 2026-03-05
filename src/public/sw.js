// Service Worker for Claude Code Bridge push notifications
self.addEventListener('push', (event) => {
  let data = { title: 'Claude has responded', body: '' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || undefined,
      badge: data.badge || undefined,
      tag: 'claude-response',
      renotify: true,
      requireInteraction: true,
    })
  );
});

// Click notification → open/focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});
