var CACHE_NAME = 'storepro-v3';
var SHELL_FILES = [
  '/',
  '/index.html',
  '/fastfood.html',
  '/meatshop.html',
  '/restaurant.html',
  '/dhaba.html',
  '/store.html',
  '/dashboard.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
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

// Fetch — smart caching strategy
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  
  // NEVER cache: Google Sheets API, Apps Script, WhatsApp, Nominatim
  if (url.indexOf('docs.google.com') >= 0 ||
      url.indexOf('script.google.com') >= 0 ||
      url.indexOf('wa.me') >= 0 ||
      url.indexOf('gviz/tq') >= 0 ||
      url.indexOf('nominatim.openstreetmap.org') >= 0) {
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
  
  // CDN scripts (QRCode.js etc) — cache first
  if (url.indexOf('cdnjs.cloudflare.com') >= 0) {
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
  
  // HTML pages — network first, fallback to cache (always get latest)
  if (e.request.mode === 'navigate' || url.indexOf('.html') >= 0) {
    e.respondWith(
      fetch(e.request).then(function(res) {
        if (res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return caches.match(e.request).then(function(r) {
          return r || caches.match('/index.html');
        });
      })
    );
    return;
  }
  
  // Everything else — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        if (res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      });
    }).catch(function() {
      if (e.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});
