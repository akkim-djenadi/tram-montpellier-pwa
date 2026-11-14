// Service worker : application utilisable hors ligne (coque + données + tuiles déjà vues).
const VERSION = 'v7'
const SHELL_CACHE = `tram-shell-${VERSION}`
const TILE_CACHE = `tram-tiles-${VERSION}`
const MAX_TILES = 500
const TILE_HOST = 'tile.openstreetmap.org'

const SHELL = [
  '/', '/index.html', '/config.js', '/manifest.webmanifest',
  '/styles/tokens.css', '/styles/app.css', '/styles/sheet.css', '/styles/journey.css',
  '/src/main.js', '/src/dom.js', '/src/geo.js', '/src/time.js', '/src/schedule.js', '/src/gtfsrt.js',
  '/src/realtime.js', '/src/map.js', '/src/sheet.js', '/src/views.js', '/src/domain.js', '/src/locate.js', '/src/install.js', '/src/router.js', '/src/journey-view.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
  '/fonts/bricolage-latin.woff2', '/fonts/dmmono-latin.woff2',
  '/icons/icon-192.png', '/icons/logo-mark.png', '/icons/icon-512.png', '/icons/favicon-32.png', '/icons/apple-touch-icon.png',
  '/data/network.json',
  '/fixtures/VehiclePosition.pb', '/fixtures/TripUpdate.pb', '/fixtures/Alert.pb',
]
const STATIC_SWR = ['/data/', '/fonts/', '/vendor/', '/icons/', '/fixtures/']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)))
}

async function staleWhileRevalidate(request, cacheName, { limit } = {}) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const refresh = fetch(request).then((res) => {
    if (res.ok) { // les réponses opaques (tuiles sans CORS) ne sont pas stockées : elles gonflent le quota
      cache.put(request, res.clone()).then(() => limit && trim(cacheName, limit))
    }
    return res
  })
  if (cached) { refresh.catch(() => {}); return cached }
  return refresh
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const res = await fetch(request)
    if (res.ok) cache.put(request, res.clone())
    return res
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true })
    if (cached) return cached
    if (request.mode === 'navigate') return cache.match('/index.html')
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (url.hostname === TILE_HOST) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE, { limit: MAX_TILES }))
    return
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return // temps réel : jamais en cache
  if (STATIC_SWR.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE))
    return
  }
  event.respondWith(networkFirst(request))
})
