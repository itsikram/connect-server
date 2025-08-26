self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('my-cache-v1').then((cache) => {
      return cache.addAll([
        '/static/js/main.js',
        '/static/js/vendor.js',
      ]);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
