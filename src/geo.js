// Utilitaires géographiques purs (aucune dépendance) — partagés navigateur / Node.
// Les points sont des paires [lat, lon] en degrés.

const EARTH_RADIUS_M = 6371008.8
const toRad = (deg) => (deg * Math.PI) / 180
const toDeg = (rad) => (rad * 180) / Math.PI

export function distance(a, b) {
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Cap initial de a vers b, en degrés [0, 360). */
export function bearing(a, b) {
  const p1 = toRad(a[0])
  const p2 = toRad(b[0])
  const dLon = toRad(b[1] - a[1])
  const y = Math.sin(dLon) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const lerp = (a, b, t) => a + (b - a) * t

/** Polyligne avec distances cumulées : { points, cum } (cum[i] = mètres depuis le départ). */
export function buildPolyline(points) {
  const cum = new Array(points.length)
  cum[0] = 0
  for (let i = 1; i < points.length; i += 1) {
    cum[i] = cum[i - 1] + distance(points[i - 1], points[i])
  }
  return { points, cum }
}

export const polylineLength = (poly) => poly.cum[poly.cum.length - 1]

/** Point situé à `d` mètres du début de la polyligne (borné), avec son cap local. */
export function pointAt(poly, d) {
  const { points, cum } = poly
  if (points.length === 1) return { lat: points[0][0], lon: points[0][1], bearing: 0 }
  const clamped = Math.max(0, Math.min(d, cum[cum.length - 1]))
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= clamped) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const t = span > 0 ? (clamped - cum[lo]) / span : 0
  return {
    lat: lerp(points[lo][0], points[hi][0], t),
    lon: lerp(points[lo][1], points[hi][1], t),
    bearing: bearing(points[lo], points[hi]),
  }
}

/**
 * Projette `pt` sur la polyligne, en n'examinant que les segments dont la fin
 * est à une distance >= fromD. Renvoie { d, offset } : abscisse curviligne et
 * écart latéral en mètres. À écart quasi égal, le premier segment gagne
 * (important pour les boucles où départ et arrivée coïncident).
 */
export function project(poly, pt, fromD = 0, tieMeters = 15) {
  const { points, cum } = poly
  const cosLat = Math.cos(toRad(pt[0]))
  const mPerDegLat = 110540
  const mPerDegLon = 111320 * cosLat
  let best = null
  for (let i = 0; i < points.length - 1; i += 1) {
    if (cum[i + 1] < fromD) continue
    const ax = (points[i][1] - pt[1]) * mPerDegLon
    const ay = (points[i][0] - pt[0]) * mPerDegLat
    const bx = (points[i + 1][1] - pt[1]) * mPerDegLon
    const by = (points[i + 1][0] - pt[0]) * mPerDegLat
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const offset = Math.hypot(ax + t * dx, ay + t * dy)
    const d = Math.max(fromD, cum[i] + t * (cum[i + 1] - cum[i]))
    if (best === null || offset < best.offset - tieMeters) best = { d, offset }
  }
  return best
}

/** Sous-polyligne entre les abscisses d0 et d1 (mètres), extrémités interpolées. */
export function slicePolyline(poly, d0, d1) {
  const a = pointAt(poly, d0)
  const b = pointAt(poly, d1)
  const inner = poly.points.filter((_, i) => poly.cum[i] > d0 && poly.cum[i] < d1)
  return [[a.lat, a.lon], ...inner, [b.lat, b.lon]]
}
