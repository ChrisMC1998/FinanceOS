/* ════════════════════════════════════════════════════════════════════════════
   FinanceOS service worker (sw.js)
   • lets FinanceOS install as an app (phone, tablet, PC) and open even when offline
   • shows push notifications even when the app is closed
   Put this file in the SAME folder as index.html (next to manifest.webmanifest and the
   icons folder). The app registers it by itself.
   ════════════════════════════════════════════════════════════════════════════ */
const SW_VERSION = 'fos-sw-10.0';
const SHELL = 'fos-shell-v10';      // the app page + icons, for opening offline
const LIBS = 'fos-libs-v10';        // chart / pdf / font libraries from the CDNs
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  self.skipWaiting();                                                               // a new version takes over straight away
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(SHELL_FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keep = [SHELL, LIBS];
  for (const k of await caches.keys()) if (k.startsWith('fos-') && !keep.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

/* Opening the app: always the newest version when online, the saved copy when offline.
   Your data never goes through here: Supabase requests are left alone. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) { const c = await caches.open(SHELL); c.put('./index.html', fresh.clone()).catch(() => {}); }
        return fresh;
      } catch (err) {
        const c = await caches.open(SHELL);
        return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }
  if (url.origin === self.location.origin && /\/(icons\/|manifest\.webmanifest$)/.test(url.pathname)) {
    e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  if (LIB_HOSTS.includes(url.hostname)) {        // saved after the first load, refreshed in the background
    e.respondWith(caches.open(LIBS).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()).catch(() => {}); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* The app icon for notifications, read from your manifest.webmanifest (no icon files needed here) */
let iconUrl = null;
async function appIcon() {
  if (iconUrl !== null) return iconUrl || undefined;
  try {
    const murl = new URL('manifest.webmanifest', self.registration.scope).href;
    const m = await (await fetch(murl, { cache: 'force-cache' })).json();
    const list = (m.icons || []).filter((i) => i && i.src);
    const pick = list.find((i) => /192/.test(i.sizes || '')) || list[0];
    iconUrl = pick ? new URL(pick.src, murl).href : '';
  } catch (e) { iconUrl = ''; }
  return iconUrl || undefined;
}

/* 1. A push arrives from your Supabase push server → show it */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'FinanceOS';
  event.waitUntil(appIcon().then((icon) => self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,          // the same alert replaces itself instead of stacking
    renotify: !!d.tag,
    icon, badge: icon,
    timestamp: Date.now(),
    data: { url: d.url || './?notif=1', category: d.category || '' },
  })));
});

/* 2. The notification is tapped → open (or bring forward) the app on the right page */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (app) {
      try { await app.focus(); } catch (e) { }
      app.postMessage({ type: 'push-open', url });   // the app goes to the page after sign-in / app lock
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/* 3. The browser renewed this device's push address → ask the open app to save the new one */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push-resubscribe' }));
  })());
});

/* The app can ask which version is installed: navigator.serviceWorker.controller.postMessage('version') */
self.addEventListener('message', (e) => { if (e.data === 'version' && e.source) e.source.postMessage({ type: 'sw-version', v: SW_VERSION }); });
