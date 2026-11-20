import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeFeed } from '../src/gtfsrt.js'
import { createNetwork } from '../src/schedule.js'
import { buildLiveState } from '../src/realtime.js'
import {
  computeSnapshotMetrics,
  createEmptyStore,
  recordSnapshot,
  summarizeDay,
  exportHistoryCsv,
} from '../src/analytics.js'

const read = (p) => readFile(new URL(p, import.meta.url))
const net = createNetwork(JSON.parse(await read('../data/network.json')))
const feeds = {
  origin: 'live',
  vehicleFeed: decodeFeed(await read('../fixtures/VehiclePosition.pb')),
  tripFeed: decodeFeed(await read('../fixtures/TripUpdate.pb')),
  alertFeed: decodeFeed(await read('../fixtures/Alert.pb')),
}
const state = buildLiveState(net, feeds)

test('computeSnapshotMetrics : compare rames réelles vs prévues et calcule les retards par ligne', () => {
  const m = computeSnapshotMetrics(net, state, state.timestamp)
  assert.equal(m.date, 20261114)
  assert.equal(m.summary.totalTramLive, 30)
  assert.ok(m.summary.totalTramSched > 30, 'le théorique prévoit plus de rames un samedi à 18h35')
  assert.ok(m.summary.tramMissing > 0, 'des rames sont manquantes par rapport au théorique')

  const l1 = m.byRoute.find((r) => r.id === '1')
  assert.equal(l1.liveCount, 9)
  assert.ok(l1.schedCount > l1.liveCount)
  assert.equal(l1.missingVehicles, l1.schedCount - l1.liveCount)
  assert.ok(l1.measuredCount > 0)
  assert.ok(l1.avgDelaySecs > 180, `retard moyen L1 attendu > 3 min, obtenu ${l1.avgDelaySecs}s`)
  assert.ok(l1.maxDelaySecs >= l1.avgDelaySecs)
})

test('recordSnapshot & summarizeDay : agrège l\'historique par jour et par ligne et consigne les incidents', () => {
  let store = createEmptyStore()
  const m1 = computeSnapshotMetrics(net, state, state.timestamp)
  store = recordSnapshot(store, m1, state.alerts)
  assert.equal(store.timeline.length, 1)
  assert.equal(store.days['20261114'].samples, 1)
  assert.ok(store.incidents.length > 0, 'des incidents (sous-effectif ou retards critiques) sont consignés')

  // Un second relevé au même timestamp (< 5 s) est dédupliqué
  store = recordSnapshot(store, m1, state.alerts)
  assert.equal(store.timeline.length, 1)

  // Un relevé 10 s plus tard est ajouté
  const m2 = computeSnapshotMetrics(net, state, state.timestamp + 10_000)
  store = recordSnapshot(store, m2, state.alerts)
  assert.equal(store.timeline.length, 2)
  assert.equal(store.days['20261114'].samples, 2)

  const daySum = summarizeDay(net, store.days['20261114'])
  assert.equal(daySum.samples, 2)
  const l1Day = daySum.rows.find((r) => r.id === '1')
  assert.equal(l1Day.avgLive, 9)
  assert.ok(l1Day.avgMissing > 0)
  assert.ok(l1Day.avgDelaySecs > 180)
})

test('exportHistoryCsv : génère un CSV valide avec les colonnes par jour et par ligne', () => {
  let store = createEmptyStore()
  const m = computeSnapshotMetrics(net, state, state.timestamp)
  store = recordSnapshot(store, m, state.alerts)
  const csv = exportHistoryCsv(net, store)
  const lines = csv.split('\n')
  assert.ok(lines.length > 5)
  assert.ok(lines[0].includes('vehicules_manquants_moy'))
  assert.ok(lines.some((l) => l.startsWith('2026-11-14;1;')))
})
