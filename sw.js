/**
 * SocialOS — Service Worker
 * Caches the app shell for offline use.
 * API calls (proxy, Google) are network-only. Google Fonts are cache-first.
 * Paths are relative so the app works from a subpath (e.g. GitHub Pages).
 */

const CACHE_NAME = 'socialos-v17'; // v17: 3-step onboarding + accordion brief
const SHELL_ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './css/app.css',
  './js/app.js',
  './js/ai.js',
  './js/auth.js',
  './js/sync.js',
  './js/composer.js',
  './js/db.js',
  './js/engagement.js',
  './js/google.js',
  './js/linkedin.js',
  './js/reddit.js',
  './js/tiktok.js',
  './js/linker.js',
  './js/pm.js',
  './js/queue.js',
  './js/self-healing.js',
  './js/ui.js',
  './js/utils.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// Install — cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch:
//  - Google Fonts: cache-first (so typography survives offline)
//  - other cross-origin (proxy, Google APIs): network-only, never cached
//  - same-origin shell: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached ||
        fetch(event.request).then((response) => {
          const copy = response.clone();
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
      )
    );
    return;
  }

  // Never cache API / proxy calls
  if (url.hostname !== location.hostname) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        // Clone BEFORE the body is consumed by cache.put
        const copy = response.clone();
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
      return cached || fetchPromise;
    })
  );
});
