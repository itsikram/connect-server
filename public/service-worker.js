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
  const url = new URL(event.request.url);
  
  // Skip caching for localhost
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (isLocalhost) {
    return; // Let browser handle requests directly, no caching
  }
  
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
