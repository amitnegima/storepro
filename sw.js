var CACHE_NAME = 'storepro-v41';
var SHELL_FILES = [
  '/',
  '/index.html',
  '/about.html',
  '/signup.html',
  '/privacy.html',
  '/terms.html',
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

// Activate — clean old caches AND notify clients to reload (self-heal stale tabs)
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    }).then(function(){
      return self.clients.claim();
    }).then(function(){
      return self.clients.matchAll({ type: 'window' });
    }).then(function(list){
      list.forEach(function(c){ try { c.postMessage({ type: 'sw-updated', cache: CACHE_NAME }); } catch(e) {} });
    })
  );
});

// Fetch — smart caching strategy
self.addEventListener('fetch', function(e) {
  // Cache API only supports GET. For everything else (POST to Apps Script, push relay), pass through.
  if (e.request.method !== 'GET') return;

  var url = e.request.url;

  // NEVER cache: Google Sheets API, Apps Script, WhatsApp, Nominatim, push relay
  if (url.indexOf('docs.google.com') >= 0 ||
      url.indexOf('script.google.com') >= 0 ||
      url.indexOf('wa.me') >= 0 ||
      url.indexOf('gviz/tq') >= 0 ||
      url.indexOf('nominatim.openstreetmap.org') >= 0 ||
      url.indexOf('workers.dev') >= 0) {
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

// ═══════════════════════════════════════════════════════════
// WEB PUSH — for new-order alerts when phone is locked / app closed
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    try { data = { title: 'New order', body: event.data ? event.data.text() : '' }; } catch (e2) {}
  }
  var title = data.title || '🔔 New order';
  var body  = data.body  || 'Tap to view your dashboard';
  var url   = (data.data && data.data.url) || '/dashboard-v2.html' + (data.data && data.data.store ? '?store=' + encodeURIComponent(data.data.store) : '');
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: (data.data && data.data.tag) || 'new-order',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 100, 400, 100, 400, 100, 800, 200, 400, 100, 400],
      data: { url: url, store: data.data && data.data.store }
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/dashboard-v2.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(url.split('?')[0]) >= 0 && 'focus' in c) {
          c.focus();
          if ('navigate' in c) c.navigate(url).catch(function(){});
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('pushsubscriptionchange', function(event) {
  // Subscription expired/rotated. Tell any open dashboards to re-subscribe.
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(list) {
      list.forEach(function(c){ try { c.postMessage({ type: 'pushsubscriptionchange' }) } catch(e) {} });
    })
  );
});
