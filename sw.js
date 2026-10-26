/*
 * Service worker for the home-screen app.
 *  - App files: network first (updates arrive immediately when online), cached copy offline.
 *  - Poller data (raw.githubusercontent.com): network first, last copy offline, so the
 *    dashboard opens with the last known state and its age instead of a blank globe.
 *  - Map tiles: cache first, capped, so revisited areas load instantly.
 * Nothing else is intercepted.
 */
const VERSION = 'osi-v3';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const TILES = `${VERSION}-tiles`;
const MAX_TILES = 600;

/* Every file the page loads from this site; scripts/check-syntax.mjs fails if one is missing. */
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'poller/data/districts.json',
  'src/styles.css', 'src/app.js', 'src/sat-worker.js',
  'src/vendor/three.min.js', 'src/vendor/satellite.min.js', 'src/vendor/topojson-client.min.js', 'src/vendor/countries-110m.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    if (cap && Math.random() < 0.05) {
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - cap))) await cache.delete(k);
    }
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL, 5000));
  } else if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(networkFirst(req, DATA, 12000));
  } else if (url.hostname === 'server.arcgisonline.com' && url.pathname.includes('/tile/')) {
    event.respondWith(cacheFirst(req, TILES, MAX_TILES));
  }
});
