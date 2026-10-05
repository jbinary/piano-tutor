// Offline support: always load the current version when online, fall back to the cached copy offline.

const CACHE = 'piano-tutor-v15';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'keyboard.js',
  'midi.js',
  'library.js',
  'marks.js',
  'manifest.webmanifest',
  'vendor/opensheetmusicdisplay.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// `cache: 'reload'` bypasses the browser's HTTP cache (GitHub Pages allows 10 minutes), which
// could otherwise mix a new index.html with an old app.js.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so every file comes from the same (latest) version; the cache is only for offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // By URL: a navigation Request can't be re-fetched with extra options.
        const res = await fetch(e.request.url, { cache: 'no-cache' });
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(e.request, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
