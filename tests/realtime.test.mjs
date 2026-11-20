import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeFeed } from '../src/gtfsrt.js'
import { createNetwork } from '../src/schedule.js'
import { buildLiveState, liveVehiclesAt, isFresh, liveDepartures, pickDepartures, fetchFeed } from '../src/realtime.js'
import { distance } from '../src/geo.js'

const read = (p) => readFile(new URL(p, import.meta.url))
const net = createNetwork(JSON.parse(await read('../data/network.json')))
const feeds = {
  origin: 'snapshot',
  vehicleFeed: decodeFeed(await read('../fixtures/VehiclePosition.pb')),
  tripFeed: decodeFeed(await read('../fixtures/TripUpdate.pb')),
  alertFeed: decodeFeed(await read('../fixtures/Alert.pb')),
}
const state = buildLiveState(net, feeds)

test('état live : trams et bus du réseau, avec position et destination', () => {
  const trams = state.vehicles.filter((v) => net.routesById.get(v.route).mode === 'tram')
  const buses = state.vehicles.filter((v) => net.routesById.get(v.route).mode === 'bus')
  assert.equal(trams.length, 30)
  assert.ok(buses.length >= 50, `bus: ${buses.length}`)
  assert.ok(trams.filter((v) => v.headsign).length >= 28)
  assert.ok(buses.filter((v) => v.headsign).length / buses.length > 0.8)
})

test('liveVehiclesAt : les trams en mouvement avancent le long de leur ligne toutes les 10 s', () => {
  const t0 = state.timestamp
  const v0 = liveVehiclesAt(net, state, t0)
  const v10 = liveVehiclesAt(net, state, t0 + 10_000)
  const moving = v0.filter((v) => net.routesById.get(v.route).mode === 'tram' && v.speed > 5 && v.status !== 1)
  assert.ok(moving.length > 0)
  for (const before of moving) {
    const after = v10.find((v) => v.id === before.id)
    const movedMeters = distance([before.lat, before.lon], [after.lat, after.lon])
    assert.ok(movedMeters > 1, `le tram ${before.id} (vitesse ${before.speed} km/h) doit avancer en 10 s (déplacé de ${movedMeters.toFixed(1)} m)`)
  }
  const stopped = v0.filter((v) => v.status === 1 || v.speed === 0)
  for (const before of stopped) {
    const after = v10.find((v) => v.id === before.id)
    assert.equal(after.lat, before.lat)
    assert.equal(after.lon, before.lon)
  }
})

test('état live : alertes des lignes de tram, avec indicateur de fin', () => {
  assert.equal(state.alerts.length, 5)
  assert.equal(state.alerts.filter((a) => a.ended).length, 2)
  assert.ok(state.alerts.find((a) => a.routes[0] === '4').text.includes('Ligne 4'))
})

test('fraîcheur : un instantané n\'est jamais « live »', () => {
  assert.equal(isFresh(state, state.timestamp + 10_000), false)
  assert.equal(isFresh({ ...state, origin: 'live' }, state.timestamp + 10_000), true)
  assert.equal(isFresh({ ...state, origin: 'live' }, state.timestamp + 400_000), false)
})

test('passages live : triés et dans la fenêtre', () => {
  const now = state.timestamp
  const stopId = [...state.board.keys()][0]
  const deps = liveDepartures(state, stopId, now, 4)
  assert.ok(deps.length > 0)
  assert.ok(deps.every((d, i) => i === 0 || d.inSecs >= deps[i - 1].inSecs))
})

test('pickDepartures : live prioritaire, sinon théorique', () => {
  assert.deepEqual(pickDepartures([{ a: 1 }], [{ b: 2 }]), [{ a: 1 }])
  assert.deepEqual(pickDepartures([], [{ b: 2 }]), [{ b: 2 }])
})

test('fetchFeed : bascule sur l\'endpoint suivant en cas d\'échec', async () => {
  const bytes = await read('../fixtures/Alert.pb')
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('/bad')) return { ok: false, status: 502 }
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), headers: new Headers({ 'x-feed-source': 'snapshot' }) }
  }
  const res = await fetchFeed(['/bad/{feed}', '/good/{feed}'], 'Alert', { fetchImpl })
  assert.deepEqual(calls, ['/bad/Alert', '/good/Alert'])
  assert.equal(res.origin, 'snapshot')
  assert.equal(res.decoded.alerts.length, 5)
})

test('fetchFeed : cacheBust ajoute un paramètre horodaté à la requête', async () => {
  const bytes = await read('../fixtures/Alert.pb')
  let calledUrl = null
  const fetchImpl = async (url) => {
    calledUrl = url
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), headers: new Headers() }
  }
  const res = await fetchFeed(['/api/rt/{feed}'], 'Alert', { fetchImpl, cacheBust: true })
  assert.match(calledUrl, /^\/api\/rt\/Alert\?_t=\d+$/)
  assert.equal(res.url, '/api/rt/Alert')
})

test('fetchFeed : propage l\'erreur si tous les endpoints échouent', async () => {
  await assert.rejects(fetchFeed(['/x/{feed}'], 'Alert', { fetchImpl: async () => ({ ok: false, status: 404 }) }))
})
