// Offline support: always try the network first so everyone gets updates straight away,
// and fall back to the saved copy when offline or if the network takes over 3 seconds.
const CACHE = 'fireguard-v14';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fromCache = () => caches.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = res => { if (!done && res) { done = true; resolve(res); } };
    const timer = setTimeout(() => fromCache().then(finish), 3000);
    net.then(res => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); fromCache().then(hit => finish(hit || Response.error())); });
  }));
  e.waitUntil(net.catch(() => {}));
});
