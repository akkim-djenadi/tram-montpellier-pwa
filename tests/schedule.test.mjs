import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createNetwork, vehiclesAt, departuresAt } from '../src/schedule.js'
import { localParts, previousDate, formatClock, formatEta } from '../src/time.js'

const net = createNetwork(JSON.parse(await readFile(new URL('../data/network.json', import.meta.url), 'utf8')))
// Samedi 14 novembre 2026, 10:00 à Paris (UTC+1)
const SAT_10H = Date.UTC(2026, 10, 14, 9, 0, 0)

test('time : heure locale Paris et jour précédent', () => {
  assert.deepEqual(localParts(SAT_10H), { date: 20261114, secs: 36000 })
  assert.equal(previousDate(20261101), 20261031)
  assert.equal(previousDate(20270101), 20261231)
  assert.equal(formatClock(36000 + 90), '10:01')
  assert.equal(formatEta(180), '3 min')
  assert.equal(formatEta(10), 'À quai')
})

const TRAMS = new Set([...net.routesById.values()].filter((r) => r.mode === 'tram').map((r) => r.id))
const BUSES = new Set([...net.routesById.values()].filter((r) => r.mode === 'bus').map((r) => r.id))

test('réseau : 5 lignes de tram, 39 de bus et stations regroupées par proximité', () => {
  assert.equal(TRAMS.size, 5)
  assert.equal(BUSES.size, 39)
  assert.ok(net.stations.length > 500)
  assert.ok(net.stations.every((s) => s.routes.length > 0))
  assert.deepEqual(net.stations.find((s) => s.name === 'Comédie').routes, ['1', '2'])
  assert.ok(net.stopsById.has('41101'))
})

test('vehiclesAt : des trams circulent un samedi matin, dans Montpellier', () => {
  const vs = vehiclesAt(net, SAT_10H, { routes: TRAMS })
  assert.ok(vs.length >= 20, `trams: ${vs.length}`)
  for (const v of vs) {
    assert.ok(v.lat > 43.5 && v.lat < 43.7 && v.lon > 3.7 && v.lon < 4.0, JSON.stringify(v))
    assert.ok(TRAMS.has(v.route))
  }
})

test('vehiclesAt : le filtre de lignes sépare trams et bus', () => {
  const buses = vehiclesAt(net, SAT_10H, { routes: BUSES })
  assert.ok(buses.length >= 20, `bus: ${buses.length}`)
  assert.ok(buses.every((v) => BUSES.has(v.route) && v.lat > 43.4 && v.lat < 43.8))
  assert.equal(vehiclesAt(net, SAT_10H, { routes: new Set() }).length, 0)
  assert.equal(vehiclesAt(net, SAT_10H).length, vehiclesAt(net, SAT_10H, { routes: TRAMS }).length + buses.length)
})

test('departuresAt : un arrêt de bus ne remonte que les lignes demandées', () => {
  const busStop = [...net.patternsByStop.keys()].find((id) => net.patternsByStop.get(id).every((x) => BUSES.has(net.patterns[x.pattern].route)))
  const all = departuresAt(net, busStop, SAT_10H, { limit: 50, horizon: 14400 })
  assert.ok(all.length > 0)
  assert.equal(departuresAt(net, busStop, SAT_10H, { routes: TRAMS }).length, 0)
})

test('vehiclesAt : positions qui avancent entre deux instants', () => {
  const a = vehiclesAt(net, SAT_10H, { routes: TRAMS }).find((v) => v.nextInSecs > 40)
  const b = vehiclesAt(net, SAT_10H + 20000).find((v) => v.id === a.id)
  assert.ok(b && (a.lat !== b.lat || a.lon !== b.lon))
})

test('vehiclesAt : pas de tram à 4h du matin', () => {
  assert.equal(vehiclesAt(net, Date.UTC(2026, 10, 14, 3, 0, 0), { routes: TRAMS }).length, 0)
})

test('departuresAt : prochains passages triés, au terminus Mosson', () => {
  const deps = departuresAt(net, '41101', SAT_10H, { limit: 5 })
  assert.equal(deps.length, 5)
  assert.ok(deps.every((d, i) => i === 0 || d.inSecs >= deps[i - 1].inSecs))
  assert.ok(deps[0].inSecs >= -30 && deps[0].inSecs < 1200)
})
