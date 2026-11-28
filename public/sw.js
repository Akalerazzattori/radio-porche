// Service worker mínimo: permite instalar la PWA y abrir la app sin conexión.
// Nunca guarda en caché la API ni el audio en directo.
const V = 'rp-v9';
const SHELL = ['/', '/css/app.css', '/js/app.js', '/img/logo-v3.webp', '/img/icon2-192.png', '/fonts/anton-latin-400-normal.woff2', '/fonts/archivo-latin-400-normal.woff2', '/fonts/archivo-latin-700-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // Red primero (para recibir cambios al momento), caché como respaldo.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && /^\/(css|js|img|fonts|library)\//.test(u.pathname)) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
