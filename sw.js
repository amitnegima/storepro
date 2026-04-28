var CACHE_NAME = 'kirana-v1';
var SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// Install — cache app shell
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_FILES).catch(function() {});
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — smart strategy
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  
  // Never cache Google Sheets API, Apps Script, or WhatsApp links
  if (url.indexOf('docs.google.com') >= 0 ||
      url.indexOf('script.google.com') >= 0 ||
      url.indexOf('wa.me') >= 0 ||
      url.indexOf('gviz/tq') >= 0) {
    return; // let browser handle normally
  }
  
  // Google Fonts — cache first (they rarely change)
  if (url.indexOf('fonts.googleapis.com') >= 0 || url.indexOf('fonts.gstatic.com') >= 0) {
    e.respondWith(
      caches.match(e.request).then(function(r) {
        return r || fetch(e.request).then(function(res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
          return res;
        });
      })
    );
    return;
  }
  
  // App shell files — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        // Cache successful responses for future
        if (res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      });
    }).catch(function() {
      // Offline fallback — return cached index.html for navigation
      if (e.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});
