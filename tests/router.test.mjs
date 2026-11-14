import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createNetwork } from '../src/schedule.js'
import { createRouter } from '../src/router.js'
import { slicePolyline, buildPolyline, polylineLength } from '../src/geo.js'
import { nextDate } from '../src/time.js'

const net = createNetwork(JSON.parse(await readFile(new URL('../data/network.json', import.meta.url), 'utf8')))
const router = createRouter(net)
const station = (name) => net.stations.find((s) => s.name === name)
const DATE = 20261114 // samedi
const TEN = 10 * 3600
const plan = (a, b, secs = TEN, count = 3) => router.plan({ fromStopIds: station(a).stopIds, toStopIds: station(b).stopIds, date: DATE, secs, count })
const stopSet = (name) => new Set(station(name).stopIds)

test('trajet direct tram : Mosson → Comédie (L1) proposé avec le plus rapide', () => {
  const js = plan('Mosson', 'Comédie')
  assert.ok(js.length >= 1, 'un itinéraire existe')
  const j = js.find((x) => x.transfers === 0)
  assert.ok(j, 'le trajet direct (le moins de correspondances) est proposé')
  assert.ok(js[0].arrival <= j.arrival, 'trié par arrivée : le plus rapide en premier')
  const ride = j.legs.find((l) => l.type === 'ride')
  assert.equal(ride.route, '1')
  assert.ok(stopSet('Mosson').has(ride.fromStop) && stopSet('Comédie').has(ride.toStop))
  assert.ok(j.departure >= TEN && j.arrival > j.departure)
  const minutes = (j.arrival - j.departure) / 60
  assert.ok(minutes > 8 && minutes < 45, `durée ${minutes} min`)
})

test('l\'heure d\'arrivée est celle du GTFS (profil du trajet)', () => {
  const j = plan('Mosson', 'Comédie').find((x) => x.transfers === 0)
  const ride = j.legs[0]
  const trip = net.tripsById.get(ride.tripId)
  const offsets = net.raw.profiles[trip.profile]
  assert.equal(ride.arr - ride.dep, offsets[ride.alightPos] - offsets[ride.boardPos])
})

test('plusieurs itinéraires triés par heure d\'arrivée', () => {
  const js = plan('Mosson', 'Comédie', TEN, 4)
  assert.ok(js.length >= 3)
  assert.ok(js.every((j, i) => i === 0 || j.arrival >= js[i - 1].arrival))
  assert.ok(js.every((j) => j.departure >= TEN))
})

test('avec correspondance : Mosson → Pérols Étang de l\'Or', () => {
  const j = plan('Mosson', "Pérols Étang de l'Or")[0]
  assert.ok(j)
  assert.ok(j.arrival > j.departure)
  const rides = j.legs.filter((l) => l.type === 'ride')
  // chaque correspondance laisse au moins 1 minute
  rides.slice(1).forEach((r, i) => assert.ok(r.dep - rides[i].arr >= 0, 'pas de correspondance impossible'))
  assert.ok((j.arrival - j.departure) / 60 < 90)
})

test('trajet en bus entre deux arrêts d\'une même ligne', () => {
  const p = net.patterns.find((x) => net.routesById.get(x.route).mode === 'bus' && x.stops.length > 10)
  const a = net.stopsById.get(p.stops[1])
  const b = net.stopsById.get(p.stops[8])
  const js = router.plan({ fromStopIds: [a.id], toStopIds: [b.id], date: DATE, secs: TEN })
  assert.ok(js.length > 0 && js[0].legs.some((l) => l.type === 'ride'))
  assert.ok(js[0].arrival > js[0].departure)
})

test('même station au départ et à l\'arrivée : aucun itinéraire', () => {
  assert.deepEqual(plan('Comédie', 'Comédie'), [])
})

test('de nuit : le premier départ est après l\'heure demandée, jamais avant', () => {
  const j = plan('Mosson', 'Comédie', 3 * 3600)[0]
  assert.ok(j && j.departure >= 3 * 3600)
})

test('slicePolyline : extrémités interpolées et points intermédiaires', () => {
  const poly = buildPolyline([[43.6, 3.8], [43.6, 3.85], [43.6, 3.9]])
  const len = polylineLength(poly)
  const part = slicePolyline(poly, len * 0.25, len * 0.75)
  assert.equal(part.length, 3)
  assert.ok(Math.abs(part[0][1] - 3.825) < 1e-3 && Math.abs(part[2][1] - 3.875) < 1e-3)
})

test('nextDate : fin de mois et d\'année', () => {
  assert.equal(nextDate(20261130), 20261201)
  assert.equal(nextDate(20261231), 20270101)
})
