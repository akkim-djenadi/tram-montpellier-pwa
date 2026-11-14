import test from 'node:test'
import assert from 'node:assert/strict'
import { distance, bearing, buildPolyline, pointAt, project, polylineLength } from '../src/geo.js'

test('distance : 0,01° de latitude ≈ 1112 m', () => {
  assert.ok(Math.abs(distance([43.6, 3.88], [43.61, 3.88]) - 1112) < 5)
})

test('bearing : plein est = 90°, plein nord = 0°', () => {
  assert.ok(Math.abs(bearing([43.6, 3.8], [43.6, 3.9]) - 90) < 0.2)
  assert.ok(Math.abs(bearing([43.6, 3.8], [43.7, 3.8])) < 0.01)
})

test('pointAt : interpole au milieu et borne aux extrémités', () => {
  const poly = buildPolyline([[43.6, 3.8], [43.6, 3.9]])
  const mid = pointAt(poly, polylineLength(poly) / 2)
  assert.ok(Math.abs(mid.lon - 3.85) < 1e-6)
  assert.equal(pointAt(poly, -10).lon, 3.8)
  assert.equal(pointAt(poly, 1e9).lon, 3.9)
})

test('project : écart latéral et abscisse', () => {
  const poly = buildPolyline([[43.6, 3.8], [43.6, 3.9]])
  const hit = project(poly, [43.6009, 3.85])
  assert.ok(Math.abs(hit.offset - 100) < 3)
  assert.ok(Math.abs(hit.d - polylineLength(poly) / 2) < 5)
})

test('project : boucle — départ et arrivée confondus, fromD départage', () => {
  const loop = buildPolyline([[43.6, 3.8], [43.6, 3.81], [43.61, 3.81], [43.6, 3.8]])
  const start = project(loop, [43.6, 3.8], 0)
  const end = project(loop, [43.6, 3.8], polylineLength(loop) - 1)
  assert.ok(start.d < 1)
  assert.ok(end.d > polylineLength(loop) - 2)
})
