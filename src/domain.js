// Logique d'affichage pure (testable) : stations proches, regroupement de passages.
import { distance } from './geo.js'

const WALK_M_PER_MIN = 75
const DETOUR_FACTOR = 1.25

export const walkMinutes = (meters) => Math.max(1, Math.round((meters * DETOUR_FACTOR) / WALK_M_PER_MIN))

export function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

/** Stations les plus proches de pos ({lat, lon}), triées, au plus `max` dans `radius` mètres. */
export function nearestStations(stations, pos, { max = 4, radius = 3000 } = {}) {
  return stations
    .map((station) => ({ station, meters: distance([pos.lat, pos.lon], [station.lat, station.lon]) }))
    .filter((x) => x.meters <= radius)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, max)
}

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/** Recherche de station insensible aux accents ; les débuts de mot passent en premier. */
export function searchStations(stations, query, max = 6) {
  const q = normalize(query)
  if (q.length < 2) return []
  return stations
    .map((station) => {
      const name = normalize(station.name)
      const rank = name.startsWith(q) ? 0 : name.split(' ').some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : 3
      return { station, rank }
    })
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.station.name.localeCompare(b.station.name, 'fr'))
    .slice(0, max)
    .map((x) => x.station)
}

/** Regroupe les passages par ligne + destination ; groupes triés par prochain passage. */
export function groupDepartures(departures, timesPerGroup = 3) {
  const groups = new Map()
  for (const d of departures) {
    const key = `${d.route}|${d.headsign ?? ''}`
    const g = groups.get(key) ?? { route: d.route, headsign: d.headsign, times: [] }
    g.times.push(d)
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, times: g.times.sort((a, b) => a.inSecs - b.inSecs).slice(0, timesPerGroup) }))
    .sort((a, b) => a.times[0].inSecs - b.times[0].inSecs)
}

/** Texte de retard : « +2 min » / « à l'heure » / null si inconnu. */
export function delayLabel(delaySecs) {
  if (delaySecs === null || delaySecs === undefined) return null
  if (delaySecs >= 60) return { text: `+${Math.round(delaySecs / 60)} min`, kind: 'late' }
  if (delaySecs <= -60) return { text: `${Math.round(delaySecs / 60)} min`, kind: 'ontime' }
  return { text: "à l'heure", kind: 'ontime' }
}
