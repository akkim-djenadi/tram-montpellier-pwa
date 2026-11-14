// Moteur d'horaires théoriques : transforme data/network.json en index et calcule,
// à un instant donné, la position des trams et les prochains passages.
import { buildPolyline, pointAt, project, distance } from './geo.js'
import { localParts, previousDate } from './time.js'

const DAY = 86400

export function createNetwork(raw) {
  const stopsById = new Map(raw.stops.map((s) => [s.id, s]))
  const routesById = new Map(raw.routes.map((r) => [r.id, r]))
  const serviceDates = raw.services.map((s) => new Set(s.dates))
  const patterns = raw.patterns.map((p, index) => ({ ...p, index, poly: buildPolyline(p.path) }))
  const trips = raw.trips.map(([id, pattern, service, start, profile]) => ({
    id, pattern, service, start, profile, route: patterns[pattern].route, end: start + raw.profiles[profile].at(-1),
  }))
  const tripsById = new Map(trips.map((t) => [t.id, t]))

  const tripsByPattern = patterns.map(() => [])
  trips.forEach((t) => tripsByPattern[t.pattern].push(t))

  const patternsByStop = new Map()
  patterns.forEach((p) => p.stops.forEach((stopId, pos) => {
    const list = patternsByStop.get(stopId) ?? []
    list.push({ pattern: p.index, pos })
    patternsByStop.set(stopId, list)
  }))

  // Station = arrêts de même nom situés à moins de 250 m les uns des autres (les noms de
  // bus se répètent d'une commune à l'autre : le nom seul ne suffit pas).
  const CLUSTER_M = 250
  const stopsByName = new Map()
  raw.stops.forEach((s) => stopsByName.set(s.name, [...(stopsByName.get(s.name) ?? []), s]))
  const routeRank = (id) => {
    const r = routesById.get(id)
    return [r.mode === 'tram' ? 0 : 1, Number.parseInt(r.name, 10) || 999, r.name]
  }
  const byRoute = (a, b) => {
    const [ma, na, sa] = routeRank(a)
    const [mb, nb, sb] = routeRank(b)
    return ma - mb || na - nb || sa.localeCompare(sb)
  }
  const stations = []
  for (const [name, list] of stopsByName) {
    const clusters = []
    for (const stop of list) {
      const home = clusters.find((c) => distance([c.lat, c.lon], [stop.lat, stop.lon]) <= CLUSTER_M)
      if (home) {
        home.stops.push(stop)
        home.lat = home.stops.reduce((a, x) => a + x.lat, 0) / home.stops.length
        home.lon = home.stops.reduce((a, x) => a + x.lon, 0) / home.stops.length
      } else clusters.push({ stops: [stop], lat: stop.lat, lon: stop.lon })
    }
    clusters.forEach((c, i) => stations.push({
      id: `${name}#${i}`, name, stopIds: c.stops.map((s) => s.id), lat: c.lat, lon: c.lon,
      pmr: c.stops.every((s) => s.pmr),
      routes: [...new Set(c.stops.flatMap((s) => (patternsByStop.get(s.id) ?? []).map((x) => patterns[x.pattern].route)))].sort(byRoute),
    }))
  }

  return {
    raw, meta: raw.meta, stopsById, routesById, patterns, trips, tripsById,
    tripsByPattern, patternsByStop, stations, byRoute,
    isActive: (trip, date) => serviceDates[trip.service].has(date),
  }
}

/** Jours de service à considérer : aujourd'hui, et hier avec des heures > 24:00. */
function serviceDays(ms, timeZone) {
  const { date, secs } = localParts(ms, timeZone)
  return { secs, days: [{ date, now: secs }, { date: previousDate(date), now: secs + DAY }] }
}

/** `routes` (Set d'identifiants) restreint le calcul aux lignes affichées ; absent = toutes. */
export function vehiclesAt(net, ms, { routes } = {}) {
  const { days } = serviceDays(ms, net.meta.timezone)
  const out = []
  for (const { date, now } of days) {
    for (const trip of net.trips) {
      if (now < trip.start || now > trip.end || (routes && !routes.has(trip.route)) || !net.isActive(trip, date)) continue
      const pattern = net.patterns[trip.pattern]
      const offsets = net.raw.profiles[trip.profile]
      const elapsed = now - trip.start
      let i = 0
      while (i < offsets.length - 2 && offsets[i + 1] <= elapsed) i += 1
      const span = offsets[i + 1] - offsets[i]
      const frac = span > 0 ? Math.min(1, Math.max(0, (elapsed - offsets[i]) / span)) : 0
      const d = pattern.stopD[i] + frac * (pattern.stopD[i + 1] - pattern.stopD[i])
      const pos = pointAt(pattern.poly, d)
      out.push({
        id: trip.id, tripId: trip.id, route: pattern.route, dir: pattern.dir, headsign: pattern.headsign,
        lat: pos.lat, lon: pos.lon, bearing: pos.bearing,
        prevStopId: pattern.stops[i], nextStopId: pattern.stops[i + 1],
        nextInSecs: Math.max(0, offsets[i + 1] - elapsed),
        speed: span > 0 ? (pattern.stopD[i + 1] - pattern.stopD[i]) / span : 0,
        source: 'schedule',
      })
    }
  }
  return out
}

/** Prochains départs théoriques à un arrêt (hors terminus d'arrivée). */
export function departuresAt(net, stopId, ms, { limit = 6, horizon = 5400, routes } = {}) {
  const { days } = serviceDays(ms, net.meta.timezone)
  const out = []
  for (const { pattern: pIdx, pos } of net.patternsByStop.get(stopId) ?? []) {
    const pattern = net.patterns[pIdx]
    if (pos === pattern.stops.length - 1 || (routes && !routes.has(pattern.route))) continue
    for (const { date, now } of days) {
      for (const trip of net.tripsByPattern[pIdx]) {
        const t = trip.start + net.raw.profiles[trip.profile][pos]
        if (t < now - 30 || t > now + horizon || !net.isActive(trip, date)) continue
        out.push({
          tripId: trip.id, route: pattern.route, dir: pattern.dir, headsign: pattern.headsign,
          inSecs: t - now, epochMs: ms + (t - now) * 1000, delay: 0, source: 'schedule',
        })
      }
    }
  }
  return out.sort((a, b) => a.inSecs - b.inSecs).slice(0, limit)
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180)

/**
 * Déduit la destination d'un tram à partir de sa position et de son cap : on cherche
 * le trajet de la ligne qui passe à proximité en allant dans le même sens.
 */
export function inferHeadsign(net, route, lat, lon, bearing) {
  let best = null
  for (const pattern of net.patterns) {
    if (pattern.route !== route) continue
    const hit = project(pattern.poly, [lat, lon])
    // Les trajets sans tracé officiel (bus) sont des segments droits entre arrêts : tolérance large.
    if (!hit || hit.offset > (pattern.straight ? 300 : 60)) continue
    const diff = angleDiff(pointAt(pattern.poly, hit.d).bearing, bearing)
    if (!best || diff < best.diff) best = { diff, headsign: pattern.headsign, dir: pattern.dir }
  }
  return best && best.diff < 80 ? best : null
}
