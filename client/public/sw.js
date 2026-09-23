/* BotConnector legacy service-worker retirement shim.
 * Purpose: replace the pre-LibreChat /sw.js worker, clear its caches,
 * unregister it, and force all controlled windows back to the network.
 * The current BotConnector PWA uses /botconnector-sw.js instead.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (_) {}

    try { await self.clients.claim(); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}

    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        const url = new URL(client.url);
        url.searchParams.set('bc-cutover', 'librechat');
        await client.navigate(url.href);
      }
    } catch (_) {}
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
