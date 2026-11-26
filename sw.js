/* ════════════════════════════════════════════════════════════════════════════
   FinanceOS service worker (sw.js): shows push notifications even when the app is closed.
   Put this file in the SAME folder as index.html (next to manifest.webmanifest), so it is
   served from https://your-site/…/sw.js. The app registers it by itself.
   ════════════════════════════════════════════════════════════════════════════ */
const SW_VERSION = 'fos-sw-9.0';

self.addEventListener('install', () => self.skipWaiting());                       // a new version takes over straight away
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
