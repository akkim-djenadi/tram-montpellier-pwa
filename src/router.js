// Calcul d'itinéraire d'arrêt à arrêt sur les horaires théoriques (algorithme RAPTOR) :
// arrivée au plus tôt, correspondances (jusqu'à 4) et marche à pied entre arrêts proches.
import { distance } from './geo.js'
import { previousDate, nextDate } from './time.js'

const DAY = 86400
const MAX_ROUNDS = 5 // 5 trajets en véhicule = 4 correspondances
const WALK_RADIUS_M = 300
const WALK_SPEED_MS = 1.1
const WALK_DETOUR = 1.3
const MIN_WALK_S = 60
const TRANSFER_BUFFER_S = 60 // marge de correspondance (au-delà du 1er véhicule)
const SEARCH_HORIZON_S = 4 * 3600 // aucun départ proposé au-delà de 4 h après l'heure souhaitée
const GRID_DEG = 0.004

export function createRouter(net) {
  const stops = net.raw.stops
  const stopIndex = new Map(stops.map((s, i) => [s.id, i]))
  const patternStops = net.patterns.map((p) => p.stops.map((id) => stopIndex.get(id)))
  const profiles = net.raw.profiles
  const patternsAtStop = stops.map(() => [])
  patternStops.forEach((list, p) => list.forEach((s, pos) => patternsAtStop[s].push({ p, pos })))

  // ── Marche entre arrêts proches (calculée une fois, à la demande) ──
  let walkLinks = null
  function footpaths() {
    if (walkLinks) return walkLinks
    const grid = new Map()
    const cell = (v) => Math.floor(v / GRID_DEG)
    stops.forEach((s, i) => {
      const key = `${cell(s.lat)},${cell(s.lon)}`
      grid.set(key, [...(grid.get(key) ?? []), i])
    })
    walkLinks = stops.map((s, i) => {
      const links = []
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          for (const j of grid.get(`${cell(s.lat) + dy},${cell(s.lon) + dx}`) ?? []) {
            if (j === i) continue
            const meters = distance([s.lat, s.lon], [stops[j].lat, stops[j].lon])
            if (meters <= WALK_RADIUS_M) links.push({ to: j, meters, secs: Math.max(MIN_WALK_S, Math.round((meters * WALK_DETOUR) / WALK_SPEED_MS)) })
          }
        }
      }
      return links
    })
    return walkLinks
  }

  // ── Trajets en circulation autour d'une date de service (la veille déborde après minuit) ──
  const dayCache = new Map()
  function instancesFor(date) {
    if (dayCache.has(date)) return dayCache.get(date)
    const perPattern = net.patterns.map(() => [])
    for (const [d, shift] of [[previousDate(date), -DAY], [date, 0], [nextDate(date), DAY]]) {
      for (const trip of net.trips) {
        const dep0 = trip.start + shift
        if (trip.end + shift < 0 || dep0 > 2 * DAY || !net.isActive(trip, d)) continue
        perPattern[trip.pattern].push({ trip, dep0 })
      }
    }
    perPattern.forEach((list) => list.sort((a, b) => a.dep0 - b.dep0))
    if (dayCache.size > 3) dayCache.clear()
    dayCache.set(date, perPattern)
    return perPattern
  }

  const timeAt = (inst, pos) => inst.dep0 + profiles[inst.trip.profile][pos]

  /** Premier trajet du pattern partant de la position `pos` à l'heure t ou après. */
  function earliestTrip(list, pos, t) {
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (timeAt(list[mid], pos) < t) lo = mid + 1
      else hi = mid
    }
    // Les profils diffèrent d'un trajet à l'autre : on revérifie quelques trajets précédents.
    while (lo > 0 && timeAt(list[lo - 1], pos) >= t) lo -= 1
    return lo < list.length ? list[lo] : null
  }

  function search({ fromStops, toStops, date, secs }) {
    const N = stops.length
    const insts = instancesFor(date)
    const links = footpaths()
    const best = new Float64Array(N).fill(Infinity)
    const rounds = Array.from({ length: MAX_ROUNDS + 1 }, () => new Float64Array(N).fill(Infinity))
    const parents = Array.from({ length: MAX_ROUNDS + 1 }, () => new Map())
    const limit = secs + SEARCH_HORIZON_S
    const targetBest = () => Math.min(...toStops.map((s) => best[s]))

    let marked = new Set()
    for (const s of fromStops) { rounds[0][s] = secs; best[s] = secs; marked.add(s) }
    const relaxWalks = (k, from, arrivals) => {
      const improved = new Set()
      for (const s of from) {
        for (const l of links[s]) {
          const arr = arrivals.get(s) + l.secs
          if (arr < best[l.to] && arr < limit && arr < targetBest()) {
            rounds[k][l.to] = arr; best[l.to] = arr
            parents[k].set(l.to, { kind: 'walk', from: s, meters: l.meters, secs: l.secs })
            improved.add(l.to)
          }
        }
      }
      return improved
    }
    marked = new Set([...marked, ...relaxWalks(0, marked, new Map([...marked].map((s) => [s, secs])))])

    for (let k = 1; k <= MAX_ROUNDS && marked.size > 0; k += 1) {
      rounds[k].set(rounds[k - 1])
      const queue = new Map()
      for (const s of marked) for (const { p, pos } of patternsAtStop[s]) if (!queue.has(p) || queue.get(p) > pos) queue.set(p, pos)
      const improved = new Set()
      const margin = k >= 2 ? TRANSFER_BUFFER_S : 0
      for (const [p, startPos] of queue) {
        const list = insts[p]
        const route = patternStops[p]
        let current = null
        let boardPos = -1
        for (let i = startPos; i < route.length; i += 1) {
          const s = route[i]
          if (current) {
            const arr = timeAt(current, i)
            if (arr < best[s] && arr < limit && arr < targetBest()) {
              rounds[k][s] = arr; best[s] = arr
              parents[k].set(s, { kind: 'ride', p, inst: current, boardPos, alightPos: i })
              improved.add(s)
            }
          }
          const ready = rounds[k - 1][s]
          if (Number.isFinite(ready) && (!current || ready + margin <= timeAt(current, i))) {
            const candidate = earliestTrip(list, i, ready + margin)
            if (candidate && candidate.dep0 + profiles[candidate.trip.profile][i] <= limit && (!current || timeAt(candidate, i) < timeAt(current, i))) {
              current = candidate; boardPos = i
            }
          }
        }
      }
      const rideArrivals = new Map([...improved].map((s) => [s, rounds[k][s]]))
      marked = new Set([...improved, ...relaxWalks(k, improved, rideArrivals)])
    }

    // Une solution par nombre de véhicules pris, si elle améliore l'arrivée (front de Pareto).
    const pareto = []
    let bestSoFar = Infinity
    for (let k = 1; k <= MAX_ROUNDS; k += 1) {
      let target = -1
      for (const s of toStops) if (Number.isFinite(rounds[k][s]) && (target < 0 || rounds[k][s] < rounds[k][target])) target = s
      if (target < 0 || rounds[k][target] >= bestSoFar) continue
      bestSoFar = rounds[k][target]
      const journey = reconstruct(target, k, parents, secs)
      if (journey) pareto.push(journey)
    }
    if (pareto.length === 0) {
      // Marche seule (arrêts voisins) : trajet de round 0.
      let target = -1
      for (const s of toStops) if (Number.isFinite(rounds[0][s]) && (target < 0 || rounds[0][s] < rounds[0][target])) target = s
      const journey = target >= 0 ? reconstruct(target, 0, parents, secs) : null
      return journey ? [journey] : []
    }
    return pareto
  }

  function reconstruct(target, round, parents, secs) {
    const legs = []
    let stop = target
    let k = round
    for (;;) {
      let j = k
      while (j > 0 && !parents[j].has(stop)) j -= 1
      const par = parents[j].get(stop)
      if (!par) break
      if (par.kind === 'walk') {
        legs.push({ type: 'walk', fromStop: stops[par.from].id, toStop: stops[stop].id, meters: Math.round(par.meters), secs: par.secs })
        stop = par.from
        k = j
      } else {
        const pattern = net.patterns[par.p]
        legs.push({
          type: 'ride', route: pattern.route, headsign: pattern.headsign, pattern: par.p, tripId: par.inst.trip.id,
          boardPos: par.boardPos, alightPos: par.alightPos,
          fromStop: pattern.stops[par.boardPos], toStop: pattern.stops[par.alightPos],
          dep: timeAt(par.inst, par.boardPos), arr: timeAt(par.inst, par.alightPos), stopCount: par.alightPos - par.boardPos,
        })
        stop = patternStops[par.p][par.boardPos]
        k = j - 1
      }
    }
    legs.reverse()
    if (legs.length === 0) return null
    return legs.some((l) => l.type === 'ride')
      ? finalize(legs, secs)
      : { legs, departure: secs, arrival: secs + legs.reduce((a, l) => a + l.secs, 0), rides: 0, transfers: -1, walkOnly: true }
  }

  /** Recale les marches sur les horaires des véhicules et calcule départ / arrivée / correspondances. */
  function finalize(legs, secs) {
    const out = []
    let clock = null
    legs.forEach((leg, i) => {
      if (leg.type === 'ride') { out.push(leg); clock = leg.arr; return }
      // marche : après un véhicule, elle commence à son arrivée ; en tête, elle précède le 1er départ
      if (i === 0) {
        const firstRide = legs.find((l) => l.type === 'ride')
        const walkTotal = legs.slice(0, legs.indexOf(firstRide)).reduce((a, l) => a + l.secs, 0)
        out.push({ ...leg, dep: firstRide.dep - walkTotal, arr: firstRide.dep - walkTotal + leg.secs })
      } else {
        const start = out.at(-1).arr
        out.push({ ...leg, dep: start, arr: start + leg.secs })
        clock = start + leg.secs
      }
    })
    const rides = out.filter((l) => l.type === 'ride')
    return {
      legs: out, rides: rides.length, transfers: rides.length - 1,
      departure: rides[0].dep, arrival: out.at(-1).arr, startAt: out[0].dep, wait: Math.max(0, rides[0].dep - secs), clock,
    }
  }

  /**
   * Jusqu'à `count` itinéraires partant à `secs` ou après, de plus en plus tardifs.
   * fromStationStops / toStationStops : identifiants GTFS d'arrêts.
   */
  function plan({ fromStopIds, toStopIds, date, secs, count = 3 }) {
    const fromStops = fromStopIds.map((id) => stopIndex.get(id)).filter((i) => i !== undefined)
    const toStops = toStopIds.map((id) => stopIndex.get(id)).filter((i) => i !== undefined)
    if (fromStops.length === 0 || toStops.length === 0 || fromStops.some((s) => toStops.includes(s))) return []
    const journeys = []
    const seen = new Set()
    const add = (j) => {
      const key = j.legs.filter((l) => l.type === 'ride').map((l) => l.tripId).join('>') || 'walk'
      if (seen.has(key)) return false
      seen.add(key)
      journeys.push({ ...j, key, date })
      return true
    }
    let from = secs
    let first = true
    while (journeys.length < count && from < secs + SEARCH_HORIZON_S) {
      const found = search({ fromStops, toStops, date, secs: from })
      if (found.length === 0) break
      if (found[0].walkOnly) { add(found[0]); break }
      // 1re requête : le plus rapide ET le moins de correspondances ; ensuite : le plus rapide seulement.
      const kept = first ? found : [found.at(-1)]
      first = false
      kept.forEach(add)
      from = found.at(-1).departure + 60
    }
    return journeys.sort((a, b) => a.arrival - b.arrival || a.departure - b.departure)
  }

  return { plan }
}
