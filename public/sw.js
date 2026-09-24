const CACHE_NAME = 'nakupny-zoznam-v7';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Upozornenie z Cloudflare Workera: druhý mobil pridal položky.
// Príde aj vtedy, keď je appka zatvorená.
self.addEventListener('push', (event) => {
  let data = { title: 'Nákupný zoznam', body: '' };
  try { if (event.data) data = { ...data, ...event.data.json() }; }
  catch { if (event.data) data.body = event.data.text(); }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Nákupný zoznam', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: data.tag || 'pridane',
      renotify: true,
    });
    // Ak je appka otvorená, nech si zoznam stiahne hneď a nečaká na ďalší dopyt.
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: 'sync' }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes('snuggle-script-add') && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Volania na Cloudflare Worker (AI, synchronizácia zoznamu) nechaj tak —
  // sú to dáta, nie statické súbory, a cachovať ich nedáva zmysel.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Never cache HTML navigations — always fetch fresh so new deploys load correctly
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache successful responses — never cache 4xx/5xx
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
