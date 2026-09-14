// PWA do Portal Raguife (versão tudo-em-um). Suba CACHE a cada publicação.
const CACHE = 'raguife-v12';
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

  // Navegações (index.html): rede primeiro, cai pro cache se offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isCode = /\.(js|css|mjs)$/.test(url.pathname);

  // Código do próprio site (db.js, utils.js, etc.): REDE PRIMEIRO.
  // Sempre busca a versão nova; usa o cache só como plano B (offline).
  // Assim os módulos não ficam "presos" numa versão antiga no celular.
  if (sameOrigin && isCode) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Demais arquivos da casca (ícones, imagens): cache primeiro, atualiza em segundo plano.
  e.respondWith(caches.match(e.request).then(cached => {
    const net = fetch(e.request).then(res => {
      if (res && res.status === 200 && sameOrigin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});
