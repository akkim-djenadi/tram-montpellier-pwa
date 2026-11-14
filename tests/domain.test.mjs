import test from 'node:test'
import assert from 'node:assert/strict'
import { nearestStations, searchStations, groupDepartures, delayLabel, walkMinutes, formatDistance } from '../src/domain.js'

const stations = [
  { name: 'Comédie', lat: 43.6088, lon: 3.8795 },
  { name: 'Gare Saint-Roch', lat: 43.6045, lon: 3.8785 },
  { name: 'Mosson', lat: 43.6163, lon: 3.8197 },
  { name: 'Place Éugène Bataillon', lat: 43.6314, lon: 3.8651 },
]

test('nearestStations : triées par distance et bornées par le rayon', () => {
  const res = nearestStations(stations, { lat: 43.6085, lon: 3.8790 }, { max: 3, radius: 3000 })
  assert.deepEqual(res.map((r) => r.station.name), ['Comédie', 'Gare Saint-Roch', 'Place Éugène Bataillon'])
  assert.ok(res.every((r) => r.meters <= 3000))
})

test('searchStations : sans accent, début de mot prioritaire', () => {
  assert.equal(searchStations(stations, 'comedie')[0].name, 'Comédie')
  assert.equal(searchStations(stations, 'eugene')[0].name, 'Place Éugène Bataillon')
  assert.deepEqual(searchStations(stations, 'x'), [])
})

test('groupDepartures : regroupe par ligne/destination, trie, limite', () => {
  const deps = [
    { route: '1', headsign: 'Mosson', inSecs: 600 }, { route: '2', headsign: 'Jacou', inSecs: 120 },
    { route: '1', headsign: 'Mosson', inSecs: 60 }, { route: '1', headsign: 'Mosson', inSecs: 1200 },
    { route: '1', headsign: 'Mosson', inSecs: 1800 },
  ]
  const g = groupDepartures(deps, 3)
  assert.equal(g.length, 2)
  assert.equal(g[0].route, '1')
  assert.deepEqual(g[0].times.map((t) => t.inSecs), [60, 600, 1200])
})

test('delayLabel', () => {
  assert.equal(delayLabel(null), null)
  assert.deepEqual(delayLabel(150), { text: '+3 min', kind: 'late' })
  assert.deepEqual(delayLabel(10), { text: "à l'heure", kind: 'ontime' })
})

test('marche et distance', () => {
  assert.equal(walkMinutes(10), 1)
  assert.equal(walkMinutes(600), 10)
  assert.equal(formatDistance(480), '480 m')
  assert.equal(formatDistance(1250), '1,3 km')
})
