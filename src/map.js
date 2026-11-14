// Couche carte : Leaflet + OpenStreetMap. Lignes, arrêts, trams animés, position de l'utilisateur.
import { h } from './dom.js'

const L = window.L
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const lineStyle = (route) => ({ '--line': route.color, '--line-ink': route.text })

function tramElement(tram, route) {
  const kind = route.mode === 'bus' ? 'Bus' : 'Tram'
  return h(
    'div',
    {
      class: 'tram', style: lineStyle(route), role: 'button', 'data-mode': route.mode, 'data-len': String(route.name.length),
      'aria-label': `${kind} ligne ${route.name}${tram.headsign ? ` vers ${tram.headsign}` : ''}`,
    },
    h('span', { class: 'tram__arrow' }),
    h('span', { class: 'tram__badge' }, route.name),
  )
}

/** Écart d'angle le plus court, pour que la flèche ne fasse pas le tour complet. */
const unwrapAngle = (current, target) => current + ((((target - current) % 360) + 540) % 360) - 180

/**
 * Fond de carte seul, créé tout de suite au démarrage (avant le chargement des 3,5 Mo de
 * données) pour que l'écran ne reste jamais vide. Les tuiles en échec sont retentées, et un
 * bandeau propose de réessayer si aucune tuile ne s'affiche.
 */
export function createBaseMap({ el, config, initialView }) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 0.5, minZoom: 10, maxZoom: 19 })
  const view = initialView ?? { center: config.center, zoom: config.zoom }
  map.setView(view.center, view.zoom)
  if (window.matchMedia('(min-width: 900px)').matches) L.control.zoom({ position: 'topright' }).addTo(map)

  const tiles = L.tileLayer(config.tileUrl, {
    maxZoom: 19,
    crossOrigin: true,
    keepBuffer: 4, // garde les tuiles voisines : pas de trou pendant le zoom
    updateWhenZooming: false, // les tuiles de l'ancien zoom restent visibles jusqu'à l'arrivée des nouvelles
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a> · Données <a href="https://data.montpellier3m.fr" target="_blank" rel="noopener">TaM / Montpellier Méditerranée Métropole</a>',
  }).addTo(map)

  const MAX_TILE_RETRIES = 3
  let loaded = 0
  const notice = h('div', { class: 'map-notice', role: 'alert', hidden: true },
    h('span', {}, 'Le fond de carte ne charge pas.'),
    h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { notice.hidden = true; tiles.redraw(); armWatchdog() } }, 'Réessayer'))
  el.parentElement.append(notice)

  tiles.on('tileload', () => { loaded += 1; notice.hidden = true })
  tiles.on('tileerror', ({ tile }) => {
    tile._retries = (tile._retries ?? 0) + 1
    if (tile._retries > MAX_TILE_RETRIES) return
    const base = tile.src.split('#')[0]
    setTimeout(() => { tile.src = `${base}#retry${tile._retries}` }, 800 * tile._retries)
  })

  let watchdog = 0
  function armWatchdog() {
    clearTimeout(watchdog)
    const before = loaded
    watchdog = setTimeout(() => { if (loaded === before) notice.hidden = false }, 10_000)
  }
  armWatchdog()

  // La carte doit se redimensionner avec son conteneur (barre d'adresse mobile, rotation, PWA installée).
  const refit = () => map.invalidateSize({ animate: false })
  if ('ResizeObserver' in window) new ResizeObserver(refit).observe(el)
  window.addEventListener('orientationchange', () => setTimeout(refit, 250))
  window.addEventListener('pageshow', refit)

  // Résolue quand les premières tuiles sont affichées (ou après 4 s) : le chargement des
  // données attend ce moment pour ne pas se disputer la bande passante avec le fond de carte.
  map.tilesReady = new Promise((resolve) => {
    tiles.once('load', resolve)
    setTimeout(resolve, 4000)
  })
  return map
}

export function createMap({ map, config, net, onStation, describeTram, getBottomInset = () => 0 }) {
  // ── Lignes : tracé officiel pour le tram, segments d'arrêt en arrêt pour le bus ──
  const lineGroups = new Map()
  const addLine = (route, coords, weight) => {
    const group = lineGroups.get(route.id) ?? L.layerGroup()
    L.polyline(coords, { color: '#ffffff', weight: weight + 4, opacity: 0.85, interactive: false, lineCap: 'round' }).addTo(group)
    L.polyline(coords, { color: route.color, weight, opacity: 1, interactive: false, lineCap: 'round' }).addTo(group)
    lineGroups.set(route.id, group)
  }
  for (const feature of net.raw.lines.features) {
    const route = net.routesById.get(feature.route)
    if (route) addLine(route, feature.coords, 5)
  }
  // Bus : par ligne et par sens, le trajet qui dessert le plus d'arrêts.
  const longest = new Map()
  for (const p of net.patterns) {
    if (net.routesById.get(p.route)?.mode !== 'bus') continue
    const key = `${p.route}|${p.dir}`
    if (!longest.has(key) || p.stops.length > longest.get(key).stops.length) longest.set(key, p)
  }
  for (const p of longest.values()) addLine(net.routesById.get(p.route), p.path, 3)

  // ── Stations ──
  const stationLayer = L.layerGroup()
  const stationMarkers = net.stations.map((station) => {
    const marker = L.circleMarker([station.lat, station.lon], {
      radius: 6, weight: 3, color: '#0e1418', fillColor: '#f3efe6', fillOpacity: 1, bubblingMouseEvents: false,
    })
    marker.bindTooltip(station.name, { direction: 'top', offset: [0, -6], className: 'stop-label' })
    marker.on('click', () => onStation(station))
    return { station, marker }
  })
  const STATION_MIN_ZOOM = 13.5
  let visibleRoutes = new Set(net.routesById.keys())

  function refreshStations() {
    const show = map.getZoom() >= STATION_MIN_ZOOM
    for (const { station, marker } of stationMarkers) {
      const wanted = show && station.routes.some((r) => visibleRoutes.has(r))
      if (wanted && !stationLayer.hasLayer(marker)) marker.addTo(stationLayer)
      if (!wanted && stationLayer.hasLayer(marker)) stationLayer.removeLayer(marker)
    }
    if (!map.hasLayer(stationLayer)) stationLayer.addTo(map)
    stationMarkers.forEach(({ marker }) => marker.setRadius(map.getZoom() >= 15.5 ? 8 : 6))
  }
  map.on('zoomend', refreshStations)

  function setVisibleRoutes(routes) {
    visibleRoutes = new Set(routes)
    for (const [id, group] of lineGroups) {
      if (visibleRoutes.has(id)) group.addTo(map)
      else map.removeLayer(group)
    }
    refreshStations()
  }
  setVisibleRoutes(visibleRoutes)

  // ── Trams animés ──
  const trams = new Map()
  let raf = 0

  function frame(now) {
    let active = false
    for (const t of trams.values()) {
      const k = t.dur > 0 ? Math.min(1, (now - t.start) / t.dur) : 1
      if (k < 1) active = true
      t.marker.setLatLng([t.from.lat + (t.to.lat - t.from.lat) * k, t.from.lon + (t.to.lon - t.from.lon) * k])
    }
    raf = active ? requestAnimationFrame(frame) : 0
  }

  function setTrams(list, { durationMs = 1000, stale = false } = {}) {
    const dur = reduceMotion() ? 0 : durationMs
    const seen = new Set()
    const now = performance.now()
    for (const tram of list) {
      const route = net.routesById.get(tram.route)
      if (!route || !visibleRoutes.has(tram.route)) continue
      seen.add(tram.id)
      const existing = trams.get(tram.id)
      if (!existing) {
        const marker = L.marker([tram.lat, tram.lon], {
          icon: L.divIcon({ className: 'tram-icon', html: tramElement(tram, route), iconSize: [44, 44], iconAnchor: [22, 22] }),
          zIndexOffset: route.mode === 'tram' ? 1000 : 600, keyboard: true,
        }).addTo(map)
        const entry = { marker, data: tram, from: { lat: tram.lat, lon: tram.lon }, to: { lat: tram.lat, lon: tram.lon }, start: now, dur: 0, angle: tram.bearing }
        marker.bindPopup(() => describeTram(entry.data), { closeButton: true, autoPanPadding: [20, 120] })
        trams.set(tram.id, entry)
      } else {
        const here = existing.marker.getLatLng()
        existing.from = { lat: here.lat, lon: here.lng }
        existing.to = { lat: tram.lat, lon: tram.lon }
        existing.start = now
        existing.dur = dur
        existing.data = tram
        existing.angle = unwrapAngle(existing.angle, tram.bearing)
      }
      const entry = trams.get(tram.id)
      const el = entry.marker.getElement()?.firstElementChild
      if (el) {
        el.style.setProperty('--bearing', `${entry.angle}deg`)
        el.dataset.late = String((tram.delay ?? 0) > 120)
        el.dataset.stale = String(stale)
      }
    }
    for (const [id, entry] of trams) {
      if (!seen.has(id)) { entry.marker.remove(); trams.delete(id) }
    }
    if (!raf) raf = requestAnimationFrame(frame)
  }

  // ── Position de l'utilisateur ──
  let me = null
  let accuracy = null
  function setUser(pos) {
    if (!pos) {
      me?.remove(); accuracy?.remove(); me = null; accuracy = null
      return
    }
    const latlng = [pos.lat, pos.lon]
    if (!me) {
      me = L.marker(latlng, { icon: L.divIcon({ className: 'tram-icon', html: h('div', { class: 'me' }), iconSize: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(map)
      accuracy = L.circle(latlng, { radius: pos.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map)
    } else {
      me.setLatLng(latlng)
      accuracy.setLatLng(latlng).setRadius(pos.accuracy)
    }
  }

  return {
    leaflet: map,
    setVisibleRoutes, setTrams, setUser,
    // Recentre en tenant compte du panneau qui masque le bas de la carte.
    flyTo(lat, lon, zoom = 16) {
      const z = Math.max(map.getZoom(), zoom)
      const target = map.unproject(map.project([lat, lon], z).add([0, getBottomInset() / 2]), z)
      map.flyTo(target, z, { duration: reduceMotion() ? 0 : 0.8 })
    },
    panToTram(id) {
      const entry = trams.get(id)
      if (!entry) return
      map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 15))
      entry.marker.openPopup()
    },
    fitBounds: (points) => map.fitBounds(points, { padding: [60, 60], maxZoom: 16 }),
    getView: () => ({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }),
    onMoveEnd: (fn) => map.on('moveend', fn),
    invalidate: () => map.invalidateSize(),
  }
}
