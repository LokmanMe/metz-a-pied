/* Service worker — Metz à pied
 * - app shell + données : précache, puis « stale-while-revalidate »
 * - tuiles OpenStreetMap : cache d'abord (les zones consultées restent dispo hors ligne)
 */
const VERSION = 'v5';
const SHELL_CACHE = `metz-shell-${VERSION}`;
const TILE_CACHE = 'metz-tiles';           // non versionné : on garde les tuiles entre mises à jour
const MAX_TILES = 1500;

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'data/lieux.json',
  'data/distances.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    // Photos des lieux : précachées pour être disponibles hors ligne pendant la visite.
    try {
      const data = await (await cache.match('data/lieux.json')).json();
      const photos = [...new Set(data.lieux.map((l) => l.image).filter(Boolean))];
      await cache.addAll(photos);
    } catch { /* elles seront mises en cache au premier affichage */ }
    // Leaflet depuis le CDN (requêtes CORS pour rester compatibles avec l'attribut integrity).
    await Promise.all(CDN.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) await cache.put(url, res);
      } catch { /* sera mis en cache au premier usage */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('metz-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(req));
    return;
  }
  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  // Les navigations (ex. ./?source=pwa) retombent sur index.html hors ligne.
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' })
    || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => undefined);
  return cached || (await network) || new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {             // tuiles demandées en CORS (crossOrigin) : pas de réponses opaques coûteuses en quota
      await cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    const excess = keys.length - MAX_TILES;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);   // les plus anciennes d'abord
  } finally { trimming = false; }
}
