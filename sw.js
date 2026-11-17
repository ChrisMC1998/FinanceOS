/* FinanceOS service worker
   - Makes the app installable as a real app (Android WebAPK) and usable offline.
   - Network-first for the app's own files, so every update you deploy shows up
     immediately; the cache is only a fallback when you are offline.
   - Never touches cross-origin requests (Supabase, CDNs, fonts): they go straight to the network.
   - Receives push messages from the server and shows them even when the app is closed.
   - Opens/focuses the app when a notification is tapped. */
const CACHE = 'financeos-shell-v4';
const ACK_URL = 'https://fvkzhydshoklketmfqzz.supabase.co/functions/v1/push-ack';   // delivery confirmation, no auth data sent

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(['./', './manifest.webmanifest', './icon-192.png', './icon-512.png']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('financeos-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // leave third-party traffic alone
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.postMessage({ type: 'push-open', url: target }); return c.focus(); }   // app routes to the section; sign-in / app lock still apply
      }
      return self.clients.openWindow(target);                                                     // cold start: app reads #n=… after it unlocks
    })
  );
});

/* ── BACKGROUND PUSH: arrives from the send-push server even when the app is closed ── */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'FinanceOS', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'FinanceOS';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: d.url || './', id: d.id || null, category: d.category || null }
    }),
    // tell the server this device really received it (queue id only, no tokens)
    d.id ? fetch(ACK_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: d.id }), keepalive: true }).catch(() => {}) : null
  ]));
});

/* If the phone rotates the push subscription, tell the app to re-save it next time it opens. */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then(list => list.forEach(c => c.postMessage({ type: 'push-resubscribe' }))));
});
