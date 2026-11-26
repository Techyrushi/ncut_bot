self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() ?? '' };
  }

  const title = typeof payload.title === 'string' ? payload.title : 'Ncut notification';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'You have a new notification.',
    icon: '/ncut_logo.jpeg',
    badge: '/ncut_logo.jpeg',
    data: { url: typeof payload.url === 'string' ? payload.url : '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      let destination = new URL('/', self.location.origin);
      try {
        const requested = new URL(event.notification.data?.url ?? '/', self.location.origin);
        if (requested.origin === self.location.origin) destination = requested;
      } catch {
        destination = new URL('/', self.location.origin);
      }

      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(destination.href);
          return client.focus();
        }
      }
      return self.clients.openWindow(destination.href);
    })(),
  );
});
