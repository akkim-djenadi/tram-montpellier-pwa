import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeFeed } from '../src/gtfsrt.js'

const load = async (name) => decodeFeed(await readFile(new URL(`../fixtures/${name}`, import.meta.url)))

test('VehiclePosition : décode position, ligne et véhicule', async () => {
  const feed = await load('VehiclePosition.pb')
  assert.equal(feed.vehicles.length, 114)
  assert.ok(feed.timestamp > 1.7e9)
  const v = feed.vehicles[0]
  assert.equal(v.routeId, '10')
  assert.ok(v.lat > 43.4 && v.lat < 43.8 && v.lon > 3.6 && v.lon < 4.1)
  assert.equal(v.vehicleId, '175')
})

test('VehiclePosition : contient des trams (lignes 1 à 5)', async () => {
  const feed = await load('VehiclePosition.pb')
  const trams = feed.vehicles.filter((v) => ['1', '2', '3', '4', '5'].includes(v.routeId))
  assert.ok(trams.length >= 20)
})

test('TripUpdate : décode arrêts, heures et retards', async () => {
  const feed = await load('TripUpdate.pb')
  assert.equal(feed.tripUpdates.length, 536)
  const t = feed.tripUpdates[0]
  assert.equal(t.tripId, 'U_12-1-T101-1-180000-12')
  assert.equal(t.routeId, '1')
  assert.equal(t.stops[0].stopId, '41101')
  assert.ok(t.stops[0].arrival.time > 1.7e9)
})

test('Alert : décode titre, description et entités concernées', async () => {
  const feed = await load('Alert.pb')
  assert.equal(feed.alerts.length, 5)
  assert.ok(feed.alerts.every((a) => a.header && a.header.length > 0))
})

test('flux tronqué : lève une erreur explicite', () => {
  assert.throws(() => decodeFeed(new Uint8Array([0x12, 0x40, 0x01])), RangeError)
})
