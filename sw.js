// Service worker : cache-first pour tous les assets du jeu.
// Incrémenter VERSION à chaque déploiement pour invalider l'ancien cache.
const VERSION = 'neonbeat-1.07';

const CORE = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './vendor/peerjs.min.js',
  './vendor/qrcode.min.js',
  './assets/icon.svg',
  './assets/fonts/inter-latin-400-normal.woff2',
  './assets/fonts/inter-latin-700-normal.woff2',
  './assets/fonts/inter-latin-800-normal.woff2',
  './tracks/index.json',
  './tracks/CREDITS.md'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // La version doit toujours venir du réseau : c'est elle qui détecte les
  // mises à jour — la servir depuis le cache rendrait l'update indétectable.
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetched = fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});
