const CACHE_NAME = 'jarvis-v4';
const ASSETS = [
  './mobile.html',
  './mobile.css',
  './mobile.js',
  './manifest.json',
  './supabase.client.js',
  './icon-192.png',
  './icon-512.png'
];


self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// --- NYTT: LYSSNA PÅ PUSH-NOTISER FRÅN DATORN ---
self.addEventListener('push', (event) => {
  let data = { title: 'JARVIS LARM', body: 'Rörelse detekterad hemma.' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: 'https://img.icons8.com/neon/96/artificial-intelligence.png',
    badge: 'https://img.icons8.com/neon/96/artificial-intelligence.png',
    vibrate: [200, 100, 200, 100, 200, 100, 400],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    },
    actions: [
      { action: 'view', title: 'Öppna JARVIS' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
