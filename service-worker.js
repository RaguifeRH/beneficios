// PWA do Portal Raguife (versão tudo-em-um). Suba CACHE a cada publicação.
const CACHE = 'raguife-v11';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (/firebase|googleapis|gstatic|firestore|cloudflare/.test(url.hostname)) return; // sempre online
  if (e.request.method !== 'GET') return;
  // Navegações: tenta a rede, cai pro index em cache se offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  // Demais arquivos da casca: cache primeiro, atualiza em segundo plano.
  e.respondWith(caches.match(e.request).then(cached => {
    const net = fetch(e.request).then(res => {
      if (res && res.status === 200 && url.origin === self.location.origin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});
