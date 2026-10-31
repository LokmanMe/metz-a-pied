/* Service worker — À pied
 * - app shell + données de toutes les villes : précache, puis « stale-while-revalidate »
 * - tuiles OpenStreetMap : cache d'abord (les zones consultées restent dispo hors ligne)
 */
const VERSION = 'v9';
const SHELL_CACHE = `apied-shell-${VERSION}`;
const TILE_CACHE = 'apied-tiles';           // non versionné : on garde les tuiles entre mises à jour
const MAX_TILES = 1500;

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'villes/villes.json',
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
    // Chaque ville : lieux, distances et photos, pour que tout reste disponible hors ligne.
    const { villes } = await (await cache.match('villes/villes.json')).json();
    for (const v of villes) {
      await cache.addAll([`${v.dossier}/lieux.json`, `${v.dossier}/distances.json`]);
      try {
        const data = await (await cache.match(`${v.dossier}/lieux.json`)).json();
        const photos = [...new Set([v.image, ...data.lieux.map((l) => l.image)].filter(Boolean))];
        await cache.addAll(photos);
      } catch { /* elles seront mises en cache au premier affichage */ }
    }
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
      // Anciennes versions, y compris celles de l'ex-app « Metz à pied » (caches lux-* : autre app, on n'y touche pas).
      .filter((k) => (k.startsWith('apied-shell-') && k !== SHELL_CACHE) || k.startsWith('metz-shell-') || k === 'metz-tiles')
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
