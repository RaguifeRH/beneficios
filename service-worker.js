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

  // Código do app (navegações + arquivos do mesmo domínio: html, js, css):
  // REDE PRIMEIRO. Assim o celular sempre pega a versão mais nova.
  // O cache vira só o plano B para quando estiver offline.
  if (e.request.mode === 'navigate' || url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Terceiros (fontes, libs externas): cache primeiro, que não muda.
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
