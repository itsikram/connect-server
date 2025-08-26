const CACHE_NAME = 'v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/static/js/main.68091f5a.js', // ⚠️ update to match actual filename
  '/static/css/main.42baba34.css', // ⚠️ update to match actual filename
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch((err) => {
        console.warn('Caching failed:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  // Skip socket.io requests
  if (event.request.url.includes('/socket.io/')) return;

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;

      return fetch(event.request).catch(() => {
        console.warn('Fetch failed for:', event.request.url);
        return new Response('Offline or file not found.', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      });
    })
  );
});
