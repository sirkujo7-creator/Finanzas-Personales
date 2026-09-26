/* Service worker: con internet siempre usa la versión más reciente; sin internet, la guardada.
   Al publicar una versión nueva, cambia VERSION aquí y en index.html. */
const VERSION = '3.0.1';
const CACHE = 'fp-' + VERSION;
const ASSETS = ['./', './index.html', './styles.css?v=' + VERSION, './parser.js?v=' + VERSION, './app.js?v=' + VERSION,
  './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(m => m || caches.match('./index.html')))
  );
});
