const CACHE_NAME = 'connect-app-v1';
const API_CACHE_NAME = 'connect-api-v1';

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/static/js/main.js',
        '/static/js/vendor.js',
        '/static/css/main.css'
      ]);
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== API_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
});

// Fetch event - network-first strategy for API/Socket.IO, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Pass through Socket.IO requests without intercepting
  if (url.pathname.startsWith('/socket.io/')) {
    return;
  }

  // Network-first strategy for API requests
  if (url.pathname.startsWith('/api/') || url.hostname === '192.168.0.100') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone the response before using it
          const responseToCache = response.clone();
          
          // Cache the successful response
          if (response.status === 200) {
            caches.open(API_CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });
          }
          
          return response;
        })
        .catch(() => {
          // If network request fails, try to get from cache
          return caches.match(event.request);
        })
    );
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request).then((response) => {
          // Clone the response before using it
          const responseToCache = response.clone();
          
          // Cache the successful response
          if (response.status === 200) {
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });
          }
          
          return response;
        });
      })
  );
});
