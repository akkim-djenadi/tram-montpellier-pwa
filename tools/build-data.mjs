// Convertit le GTFS TaM + le GeoJSON des lignes de tram en un fichier compact
// (data/network.json) consommé par la PWA. Usage : node tools/build-data.mjs
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPolyline, project, pointAt, polylineLength, distance } from '../src/geo.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GTFS = join(ROOT, 'GTFS')
const MAX_SNAP_OFFSET_M = 60
const round5 = (n) => Math.round(n * 1e5) / 1e5

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1 }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

async function* readRows(file) {
  const rl = createInterface({ input: createReadStream(join(GTFS, file), 'utf8'), crlfDelay: Infinity })
  let header = null
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '')
    if (!line) continue
    const cells = parseCsvLine(line)
    if (!header) { header = cells; continue }
    const row = {}
    header.forEach((h, i) => { row[h] = cells[i] ?? '' })
    yield row
  }
}

const collect = async (file, keep = () => true) => {
  const rows = []
  for await (const r of readRows(file)) if (keep(r)) rows.push(r)
  return rows
}

const toSeconds = (hms) => {
  const [h, m, s] = hms.split(':').map(Number)
  return h * 3600 + m * 60 + s
}

const mostCommon = (values) => {
  const counts = new Map()
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1))
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/** Choisit la meilleure ligne du GeoJSON pour une suite d'arrêts, ou null. */
function snapPattern(stopCoords, candidates) {
  let best = null
  for (const cand of candidates) {
    let fromD = 0
    const ds = []
    let worst = 0
    let total = 0
    for (const pt of stopCoords) {
      const hit = project(cand, pt, fromD)
      if (!hit) { worst = Infinity; break }
      ds.push(hit.d)
      fromD = hit.d
      worst = Math.max(worst, hit.offset)
      total += hit.offset
    }
    if (worst <= MAX_SNAP_OFFSET_M && (!best || total < best.total)) best = { cand, ds, total, worst }
  }
  return best
}

function straightPath(stopCoords) {
  const poly = buildPolyline(stopCoords)
  return { points: stopCoords, ds: poly.cum }
}

function slice(poly, d0, d1) {
  const pts = [pointAt(poly, d0)]
  poly.points.forEach((p, i) => { if (poly.cum[i] > d0 && poly.cum[i] < d1) pts.push({ lat: p[0], lon: p[1] }) })
  pts.push(pointAt(poly, d1))
  return pts.map((p) => [round5(p.lat), round5(p.lon)])
}

async function main() {
  // Tram (type 0) et bus (type 3). Les trajets « TAD » (transport à la demande, sur réservation)
  // sont exclus : ils ne circulent pas à heure fixe, donc les simuler serait trompeur.
  const routes = (await collect('routes.txt', (r) => r.route_type === '0' || r.route_type === '3')).map((r) => ({
    id: r.route_id, name: r.route_short_name, long: r.route_long_name, mode: r.route_type === '0' ? 'tram' : 'bus',
    color: `#${r.route_color}`, text: `#${r.route_text_color}`,
  }))
  const routeIds = new Set(routes.map((r) => r.id))
  const trips = await collect('trips.txt', (t) => routeIds.has(t.route_id) && !t.TAD)
  const tripIds = new Set(trips.map((t) => t.trip_id))

  // stop_times : 55 Mo, lu en flux ; on ne garde que les trams.
  const timesByTrip = new Map()
  for await (const r of readRows('stop_times.txt')) {
    if (!tripIds.has(r.trip_id)) continue
    let list = timesByTrip.get(r.trip_id)
    if (!list) { list = []; timesByTrip.set(r.trip_id, list) }
    list.push([Number(r.stop_sequence), r.stop_id, toSeconds(r.departure_time)])
  }

  const allStops = new Map((await collect('stops.txt')).map((s) => [s.stop_id, s]))
  const lineFeatures = JSON.parse(await readFile(join(ROOT, 'MMM_MMM_LigneTram.json'), 'utf8')).features
  const candidatesByRoute = new Map()
  for (const f of lineFeatures) {
    const route = String(f.properties.num_exploitation)
    const pts = f.geometry.coordinates.map(([lon, lat]) => [lat, lon])
    const list = candidatesByRoute.get(route) ?? []
    list.push(buildPolyline(pts), buildPolyline([...pts].reverse()))
    candidatesByRoute.set(route, list)
  }

  const patterns = []
  const patternIndex = new Map()
  const profiles = []
  const profileIndex = new Map()
  const services = []
  const serviceIndex = new Map()
  const usedStops = new Set()
  const tripRows = []

  for (const t of trips) {
    const times = (timesByTrip.get(t.trip_id) ?? []).sort((a, b) => a[0] - b[0])
    if (times.length < 2) continue
    const stopIds = times.map((x) => x[1])
    stopIds.forEach((s) => usedStops.add(s))
    const key = `${t.route_id}|${t.direction_id}|${stopIds.join(',')}`
    if (!patternIndex.has(key)) {
      patternIndex.set(key, patterns.length)
      patterns.push({ route: t.route_id, dir: Number(t.direction_id), stops: stopIds, heads: [] })
    }
    const pIdx = patternIndex.get(key)
    patterns[pIdx].heads.push(t.trip_headsign)

    const start = times[0][2]
    const offsets = times.map((x) => x[2] - start)
    const pKey = offsets.join(',')
    if (!profileIndex.has(pKey)) { profileIndex.set(pKey, profiles.length); profiles.push(offsets) }
    if (!serviceIndex.has(t.service_id)) { serviceIndex.set(t.service_id, services.length); services.push(t.service_id) }
    tripRows.push([t.trip_id, pIdx, serviceIndex.get(t.service_id), start, profileIndex.get(pKey)])
  }

  // Tracé de chaque pattern : projection des arrêts sur les lignes du GeoJSON.
  const stats = { snapped: 0, straight: 0 }
  for (const p of patterns) {
    p.headsign = mostCommon(p.heads)
    delete p.heads
    const coords = p.stops.map((id) => [Number(allStops.get(id).stop_lat), Number(allStops.get(id).stop_lon)])
    const snap = snapPattern(coords, candidatesByRoute.get(p.route) ?? [])
    if (snap) {
      stats.snapped += 1
      p.path = slice(snap.cand, snap.ds[0], snap.ds[snap.ds.length - 1])
      const sliced = buildPolyline(p.path)
      const base = snap.ds[0]
      p.stopD = snap.ds.map((d) => Math.round(Math.min(d - base, polylineLength(sliced))))
    } else {
      p.straight = true
      stats.straight += 1
      const s = straightPath(coords)
      p.path = s.points.map(([a, b]) => [round5(a), round5(b)])
      p.stopD = s.ds.map(Math.round)
    }
  }

  // Services : dates où chaque service circule (calendar_dates, exception_type = 1).
  const serviceDates = services.map(() => [])
  for await (const r of readRows('calendar_dates.txt')) {
    const idx = serviceIndex.get(r.service_id)
    if (idx !== undefined && r.exception_type === '1') serviceDates[idx].push(Number(r.date))
  }
  serviceDates.forEach((d) => d.sort((a, b) => a - b))

  const stops = [...usedStops].map((id) => {
    const s = allStops.get(id)
    return { id, name: s.stop_name, lat: round5(Number(s.stop_lat)), lon: round5(Number(s.stop_lon)), pmr: s.wheelchair_boarding === '1' }
  })

  const fareProducts = await collect('fare_products.txt')
  const fares = fareProducts.map((p) => ({ name: p.fare_product_name, price: Number(p.amount) }))
  const agency = (await collect('agency.txt'))[0]
  const deepLink = (await collect('ticketing_deep_links.txt'))[0]
  const allDates = serviceDates.flat()

  const lines = {
    type: 'FeatureCollection',
    features: lineFeatures.map((f) => ({
      route: String(f.properties.num_exploitation),
      name: f.properties.nom_ligne,
      color: f.properties.code_couleur,
      coords: f.geometry.coordinates.map(([lon, lat]) => [round5(lat), round5(lon)]),
    })),
  }

  const network = {
    meta: {
      agency: agency.agency_name, url: agency.agency_url, timezone: agency.agency_timezone,
      ticketing: deepLink?.web_url ?? null,
      firstDate: Math.min(...allDates), lastDate: Math.max(...allDates),
      generatedAt: new Date().toISOString(),
    },
    routes, stops, patterns, services: services.map((id, i) => ({ id, dates: serviceDates[i] })),
    profiles, trips: tripRows, lines, fares,
  }

  await mkdir(join(ROOT, 'data'), { recursive: true })
  const json = JSON.stringify(network)
  await writeFile(join(ROOT, 'data', 'network.json'), json)
  console.log(`routes=${routes.length} stops=${stops.length} patterns=${patterns.length} (tracés officiels ${stats.snapped}, stop-à-stop ${stats.straight})`)
  console.log(`trips=${tripRows.length} profils=${profiles.length} services=${services.length} taille=${(json.length / 1e6).toFixed(2)} Mo`)
  const longest = Math.max(...patterns.map((p) => p.stopD[p.stopD.length - 1]))
  console.log(`plus long trajet=${Math.round(longest)} m ; ex. distance L1 = ${Math.round(distance(patterns[0].path[0], patterns[0].path.at(-1)))} m`)
}

main().catch((e) => { console.error(e); process.exit(1) })
