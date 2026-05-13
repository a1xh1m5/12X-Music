const CACHE = 'lc-v2';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json'];
const CDN   = ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request: req } = e;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.protocol === 'blob:') return;
  if (req.headers.has('Range') || req.destination === 'audio') return;
  if (CDN.some(p => req.url.startsWith(p))) {
    e.respondWith(networkFirst(req));
  } else if (url.origin === location.origin) {
    e.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch {
    if (req.mode === 'navigate') return caches.match('./index.html');
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch {
    return caches.match(req) || new Response('Offline', { status: 503 });
  }
}

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
