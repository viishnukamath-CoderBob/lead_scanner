// Network-first for the app shell so updates roll out immediately; cached copy is used when offline. Apps Script calls (other origin) are never cached.
const CACHE = 'leadcap-static-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'backend.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const rel = u.pathname.startsWith(scope) ? u.pathname.slice(scope.length) : u.pathname;
  if (!SHELL.includes(rel === '' ? './' : rel)) return;
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
