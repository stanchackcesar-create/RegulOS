const CACHE_NAME = 'regulos-pwa-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// O RegulOS continua online e dinâmico.
// Não armazenamos API, sessão, WhatsApp ou dados do painel em cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
