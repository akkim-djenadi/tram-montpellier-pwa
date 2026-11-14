// Assemble l'état temps réel à partir des flux GTFS-RT décodés, et sait les récupérer.
import { decodeFeed } from './gtfsrt.js'
import { inferHeadsign } from './schedule.js'

export const FEEDS = ['VehiclePosition', 'TripUpdate', 'Alert']
export const MAX_FEED_AGE_S = 180

/** Essaie chaque endpoint (gabarit avec {feed}) jusqu'au premier qui répond. */
export async function fetchFeed(endpoints, feed, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let lastError = new Error('aucun endpoint configuré')
  for (const template of endpoints) {
    const url = template.replace('{feed}', feed)
    try {
      const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { decoded: decodeFeed(bytes), origin: res.headers.get('x-feed-source') ?? 'live', url }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function fetchRealtime(endpoints, { forceOrigin, ...options } = {}) {
  const [vehicles, trips, alerts] = await Promise.all(FEEDS.map((f) => fetchFeed(endpoints, f, options)))
  const origins = new Set([vehicles.origin, trips.origin, alerts.origin])
  return {
    origin: forceOrigin ?? (origins.has('snapshot') ? 'snapshot' : 'live'),
    vehicleFeed: vehicles.decoded, tripFeed: trips.decoded, alertFeed: alerts.decoded,
  }
}

const ENDED_RE = /fin d'?alerte|fin alerte|fin perturbation|termin[ée]e|a repris|reprise/i

function tramAlerts(net, alertFeed, nowSecs) {
  return alertFeed.alerts
    .map((a) => {
      const routes = [...new Set(a.entities.map((e) => e.routeId).filter(Boolean))].filter((r) => net.routesById.has(r))
      const isNetworkWide = a.entities.length === 0 || a.entities.every((e) => !e.routeId && !e.stopId)
      const active = a.periods.length === 0 || a.periods.some((p) => (p.start ?? 0) <= nowSecs && nowSecs <= (p.end ?? Infinity))
      return { a, routes, relevant: routes.length > 0 || isNetworkWide, active }
    })
    .filter((x) => x.relevant && x.active)
    .map(({ a, routes }) => ({
      id: a.id, routes,
      title: (a.header ?? '').replace(/^\s*TR\/T\d\/[^/]*\/?/i, '').replace(/^-?MANIF\/TRAM\/\d\s*/i, '').replace(/^\d(?=[A-Z])/, '').trim() || (a.header ?? '').trim(),
      text: (a.description ?? '').trim(),
      ended: ENDED_RE.test(`${a.header} ${a.description}`),
      start: a.periods[0]?.start, end: a.periods[0]?.end,
    }))
}

/** État temps réel normalisé, limité aux trams du réseau. */
export function buildLiveState(net, { origin, vehicleFeed, tripFeed, alertFeed }) {
  const stopName = (id) => net.stopsById.get(id)?.name
  const tramTrips = tripFeed.tripUpdates.filter((t) => net.routesById.has(t.routeId))
  const tripsById = new Map(tramTrips.map((t) => [t.tripId, t]))

  const board = new Map()
  for (const t of tramTrips) {
    const valid = t.stops.filter((s) => s.relationship !== 1 && s.stopId)
    const terminal = valid.at(-1)?.stopId
    const headsign = terminal ? stopName(terminal) : undefined
    valid.slice(0, -1).forEach((s) => {
      const event = s.departure?.time ? s.departure : s.arrival
      if (!event?.time) return
      const list = board.get(s.stopId) ?? []
      list.push({
        tripId: t.tripId, route: t.routeId, headsign, epochMs: event.time * 1000,
        delay: event.delay ?? null, source: 'live',
      })
      board.set(s.stopId, list)
    })
  }

  const vehicles = vehicleFeed.vehicles
    .filter((v) => net.routesById.has(v.routeId) && Number.isFinite(v.lat) && Number.isFinite(v.lon))
    .map((v) => {
      const trip = tripsById.get(v.tripId)
      const stops = trip?.stops.filter((s) => s.relationship !== 1) ?? []
      const upcoming = stops.find((s) => s.stopId === v.stopId) ?? stops[0]
      const event = upcoming?.arrival ?? upcoming?.departure
      const bearing = v.bearing ?? 0
      const guess = stops.length ? null : inferHeadsign(net, v.routeId, v.lat, v.lon, bearing)
      return {
        id: v.vehicleId ?? v.id, label: v.label ?? v.vehicleId ?? v.id, tripId: v.tripId,
        route: v.routeId, dir: v.directionId, lat: v.lat, lon: v.lon,
        bearing, speed: v.speed ?? 0, status: v.status,
        stopId: v.stopId, headsign: stops.length ? stopName(stops.at(-1).stopId) : guess?.headsign,
        nextEpochMs: event?.time ? event.time * 1000 : undefined,
        delay: event?.delay ?? null, timestamp: (v.timestamp ?? vehicleFeed.timestamp) * 1000,
        source: 'live',
      }
    })

  const timestamp = Math.max(vehicleFeed.timestamp ?? 0, tripFeed.timestamp ?? 0) * 1000
  return {
    origin, timestamp, vehicles, board,
    alerts: tramAlerts(net, alertFeed, (alertFeed.timestamp ?? Date.now() / 1000)),
  }
}

export const ageSeconds = (state, nowMs) => (nowMs - state.timestamp) / 1000
export const isFresh = (state, nowMs) => state.origin === 'live' && ageSeconds(state, nowMs) <= MAX_FEED_AGE_S

/** Passages temps réel à un arrêt, triés, dans [now-30 s, +90 min]. */
export function liveDepartures(state, stopId, nowMs, limit = 6) {
  return (state.board.get(stopId) ?? [])
    .map((d) => ({ ...d, inSecs: (d.epochMs - nowMs) / 1000 }))
    .filter((d) => d.inSecs >= -30 && d.inSecs <= 5400)
    .sort((a, b) => a.inSecs - b.inSecs)
    .slice(0, limit)
}

/**
 * Le flux temps réel fait foi : ses identifiants de trajets ne coïncident pas toujours
 * avec le GTFS théorique (trajets ajoutés / haut-le-pied), donc on ne mélange pas les
 * deux. Théorique seulement si le temps réel n'a rien pour cet arrêt.
 */
export function pickDepartures(live, scheduled, limit = 6) {
  return (live.length > 0 ? live : scheduled).slice(0, limit)
}
