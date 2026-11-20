// Observatoire du réseau : historique du nombre de véhicules (réel vs théorique)
// et des retards par ligne et par jour, pour documenter la qualité de service.
import { vehiclesAt } from './schedule.js'
import { localParts } from './time.js'

export const ANALYTICS_STORAGE_KEY = 'tram-mtp:observatory:v1'
export const LATE_THRESHOLD_S = 180 // >= 3 min = considéré en retard
export const SEVERE_THRESHOLD_S = 300 // >= 5 min = retard important
const MAX_DAYS = 90
const MAX_TIMELINE_POINTS = 180 // ~30 min à 10 s d'intervalle

/**
 * Calcule un bilan instantané par ligne à partir d'un état live (ou snapshot) et
 * du moteur d'horaires théoriques à l'instant `nowMs`.
 */
export function computeSnapshotMetrics(net, liveState, nowMs = liveState?.timestamp ?? Date.now()) {
  const scheduled = vehiclesAt(net, nowMs)
  const liveVehicles = liveState?.vehicles ?? []
  const routeDelays = liveState?.routeDelays ?? new Map()

  const schedByRoute = new Map()
  for (const v of scheduled) schedByRoute.set(v.route, (schedByRoute.get(v.route) ?? 0) + 1)

  const liveByRoute = new Map()
  for (const v of liveVehicles) liveByRoute.set(v.route, (liveByRoute.get(v.route) ?? 0) + 1)

  const routes = [...net.routesById.values()].sort((a, b) => net.byRoute(a.id, b.id))
  const byRoute = []

  let totalTramLive = 0
  let totalTramSched = 0
  let totalBusLive = 0
  let totalBusSched = 0
  let totalTripsMeasured = 0
  let totalLateTrips = 0
  let totalSevereTrips = 0
  let sumAllDelays = 0
  let maxNetworkDelay = 0

  for (const route of routes) {
    const liveCount = liveByRoute.get(route.id) ?? 0
    const schedCount = schedByRoute.get(route.id) ?? 0
    const delayEntries = routeDelays.get(route.id) ?? []

    // On complète avec les retards portés par les véhicules si non déjà présents dans routeDelays
    const seenTrips = new Set(delayEntries.map((d) => d.tripId))
    const allDelays = delayEntries.map((d) => d.delay)
    for (const v of liveVehicles) {
      if (v.route === route.id && typeof v.delay === 'number' && Math.abs(v.delay) <= 7200 && !seenTrips.has(v.tripId)) {
        allDelays.push(v.delay)
      }
    }

    const positiveDelays = allDelays.map((d) => Math.max(0, d))
    const measuredCount = allDelays.length
    const lateCount = allDelays.filter((d) => d >= LATE_THRESHOLD_S).length
    const severeCount = allDelays.filter((d) => d >= SEVERE_THRESHOLD_S).length
    const sumDelaySecs = positiveDelays.reduce((a, b) => a + b, 0)
    const avgDelaySecs = measuredCount > 0 ? Math.round(sumDelaySecs / measuredCount) : 0
    const maxDelaySecs = positiveDelays.length > 0 ? Math.max(...positiveDelays) : 0
    const latePct = measuredCount > 0 ? Math.round((lateCount / measuredCount) * 100) : 0
    const missingVehicles = Math.max(0, schedCount - liveCount)
    const coveragePct = schedCount > 0 ? Math.min(100, Math.round((liveCount / schedCount) * 100)) : (liveCount > 0 ? 100 : 100)

    if (route.mode === 'tram') {
      totalTramLive += liveCount
      totalTramSched += schedCount
    } else {
      totalBusLive += liveCount
      totalBusSched += schedCount
    }

    totalTripsMeasured += measuredCount
    totalLateTrips += lateCount
    totalSevereTrips += severeCount
    sumAllDelays += sumDelaySecs
    if (maxDelaySecs > maxNetworkDelay) maxNetworkDelay = maxDelaySecs

    byRoute.push({
      id: route.id,
      name: route.name,
      long: route.long,
      mode: route.mode,
      color: route.color,
      text: route.text,
      liveCount,
      schedCount,
      missingVehicles,
      coveragePct,
      measuredCount,
      lateCount,
      severeCount,
      latePct,
      avgDelaySecs,
      maxDelaySecs,
      sumDelaySecs,
    })
  }

  const tramCoveragePct = totalTramSched > 0 ? Math.round((totalTramLive / totalTramSched) * 100) : 100
  const networkAvgDelaySecs = totalTripsMeasured > 0 ? Math.round(sumAllDelays / totalTripsMeasured) : 0
  const networkLatePct = totalTripsMeasured > 0 ? Math.round((totalLateTrips / totalTripsMeasured) * 100) : 0

  return {
    timestamp: nowMs,
    date: localParts(nowMs, net.meta.timezone).date,
    secs: localParts(nowMs, net.meta.timezone).secs,
    summary: {
      totalTramLive,
      totalTramSched,
      tramMissing: Math.max(0, totalTramSched - totalTramLive),
      tramCoveragePct,
      totalBusLive,
      totalBusSched,
      busMissing: Math.max(0, totalBusSched - totalBusLive),
      totalTripsMeasured,
      totalLateTrips,
      totalSevereTrips,
      networkLatePct,
      networkAvgDelaySecs,
      maxNetworkDelay,
      activeAlertsCount: (liveState?.alerts ?? []).filter((a) => !a.ended).length,
    },
    byRoute,
  }
}

/** Crée un magasin d'historique vide. */
export function createEmptyStore() {
  return {
    version: 1,
    days: {},
    timeline: [],
    incidents: [],
  }
}

/**
 * Enregistre un relevé (`metrics` issu de `computeSnapshotMetrics`) dans l'historique
 * journalier et la courbe temporelle. Déduplique les relevés ayant le même timestamp.
 */
export function recordSnapshot(store, metrics, alerts = []) {
  const next = {
    version: 1,
    days: { ...(store?.days ?? {}) },
    timeline: [...(store?.timeline ?? [])],
    incidents: [...(store?.incidents ?? [])],
  }

  // Évite d'enregistrer deux fois exactement le même instantané à moins de 5 s d'écart
  const lastPoint = next.timeline.at(-1)
  if (lastPoint && Math.abs(metrics.timestamp - lastPoint.ts) < 5000) {
    return next
  }

  const dateKey = String(metrics.date)
  const prevDay = next.days[dateKey] ?? {
    date: metrics.date,
    samples: 0,
    firstTs: metrics.timestamp,
    lastTs: metrics.timestamp,
    routes: {},
  }

  const updatedRoutes = { ...prevDay.routes }
  for (const r of metrics.byRoute) {
    // On enregistre toutes les lignes de tram et les lignes de bus actives (théorique ou réel > 0)
    if (r.mode !== 'tram' && r.liveCount === 0 && r.schedCount === 0 && r.measuredCount === 0 && !updatedRoutes[r.id]) {
      continue
    }
    const prev = updatedRoutes[r.id] ?? {
      samples: 0,
      sumLive: 0,
      sumSched: 0,
      minLive: r.liveCount,
      maxLive: r.liveCount,
      maxMissing: 0,
      deficitSamples: 0,
      delayMeasurements: 0,
      lateMeasurements: 0,
      severeMeasurements: 0,
      sumDelaySecs: 0,
      maxDelaySecs: 0,
    }
    const isDeficit = r.schedCount > 0 && r.liveCount < r.schedCount
    updatedRoutes[r.id] = {
      samples: prev.samples + 1,
      sumLive: prev.sumLive + r.liveCount,
      sumSched: prev.sumSched + r.schedCount,
      minLive: Math.min(prev.minLive, r.liveCount),
      maxLive: Math.max(prev.maxLive, r.liveCount),
      maxMissing: Math.max(prev.maxMissing, r.missingVehicles),
      deficitSamples: prev.deficitSamples + (isDeficit ? 1 : 0),
      delayMeasurements: prev.delayMeasurements + r.measuredCount,
      lateMeasurements: prev.lateMeasurements + r.lateCount,
      severeMeasurements: prev.severeMeasurements + r.severeCount,
      sumDelaySecs: prev.sumDelaySecs + r.sumDelaySecs,
      maxDelaySecs: Math.max(prev.maxDelaySecs, r.maxDelaySecs),
    }
  }

  next.days[dateKey] = {
    date: metrics.date,
    samples: prevDay.samples + 1,
    firstTs: Math.min(prevDay.firstTs, metrics.timestamp),
    lastTs: Math.max(prevDay.lastTs, metrics.timestamp),
    routes: updatedRoutes,
  }

  // Limite le nombre de jours conservés
  const dayKeys = Object.keys(next.days).sort()
  while (dayKeys.length > MAX_DAYS) {
    const oldest = dayKeys.shift()
    delete next.days[oldest]
  }

  // Point dans la série temporelle (trams par ligne + retards moyens)
  const tramRoutes = {}
  for (const r of metrics.byRoute) {
    if (r.mode === 'tram') {
      tramRoutes[r.id] = {
        live: r.liveCount,
        sched: r.schedCount,
        avgDelay: r.avgDelaySecs,
        maxDelay: r.maxDelaySecs,
        latePct: r.latePct,
      }
    }
  }

  next.timeline.push({
    ts: metrics.timestamp,
    date: metrics.date,
    secs: metrics.secs,
    tramLive: metrics.summary.totalTramLive,
    tramSched: metrics.summary.totalTramSched,
    busLive: metrics.summary.totalBusLive,
    busSched: metrics.summary.totalBusSched,
    avgDelay: metrics.summary.networkAvgDelaySecs,
    maxDelay: metrics.summary.maxNetworkDelay,
    latePct: metrics.summary.networkLatePct,
    trams: tramRoutes,
  })
  if (next.timeline.length > MAX_TIMELINE_POINTS) {
    next.timeline = next.timeline.slice(-MAX_TIMELINE_POINTS)
  }

  // Enregistre les anomalies marquantes (gros retard >= 10 min, déficit >= 3 rames sur une ligne de tram, ou alerte active)
  const seenIncidentKeys = new Set(next.incidents.map((inc) => inc.key))
  const hourBucket = Math.floor(metrics.timestamp / (15 * 60 * 1000)) // déduplication par tranche de 15 min

  for (const r of metrics.byRoute) {
    if (r.mode === 'tram' && r.missingVehicles >= 3) {
      const key = `deficit:${r.id}:${hourBucket}`
      if (!seenIncidentKeys.has(key)) {
        next.incidents.unshift({
          key,
          ts: metrics.timestamp,
          date: metrics.date,
          route: r.id,
          kind: 'deficit',
          title: `Sous-effectif Ligne ${r.name} : ${r.liveCount} rames au lieu de ${r.schedCount} prévues (−${r.missingVehicles})`,
        })
        seenIncidentKeys.add(key)
      }
    }
    if (r.maxDelaySecs >= 600) {
      const key = `delay:${r.id}:${hourBucket}`
      if (!seenIncidentKeys.has(key)) {
        next.incidents.unshift({
          key,
          ts: metrics.timestamp,
          date: metrics.date,
          route: r.id,
          kind: 'delay',
          title: `Retard critique Ligne ${r.name} : jusqu'à +${Math.round(r.maxDelaySecs / 60)} min (moy. +${Math.round(r.avgDelaySecs / 60)} min)`,
        })
        seenIncidentKeys.add(key)
      }
    }
  }

  for (const a of alerts) {
    if (a.ended) continue
    const key = `alert:${a.id}:${metrics.date}`
    if (!seenIncidentKeys.has(key)) {
      next.incidents.unshift({
        key,
        ts: metrics.timestamp,
        date: metrics.date,
        route: a.routes[0] ?? null,
        kind: 'alert',
        title: a.title || 'Perturbation signalée',
      })
      seenIncidentKeys.add(key)
    }
  }

  if (next.incidents.length > 60) {
    next.incidents = next.incidents.slice(0, 60)
  }

  return next
}

/** Résume les statistiques consolidées d'une journée pour l'affichage. */
export function summarizeDay(net, dayRecord) {
  if (!dayRecord) return null
  const rows = []
  let totalTramLiveSum = 0
  let totalTramSchedSum = 0
  let totalDelayMeas = 0
  let totalLateMeas = 0
  let totalSevereMeas = 0
  let totalDelaySum = 0
  let maxDelayDay = 0

  for (const [routeId, stats] of Object.entries(dayRecord.routes)) {
    const route = net.routesById.get(routeId)
    if (!route || stats.samples === 0) continue
    const avgLive = +(stats.sumLive / stats.samples).toFixed(1)
    const avgSched = +(stats.sumSched / stats.samples).toFixed(1)
    const avgMissing = Math.max(0, +(avgSched - avgLive).toFixed(1))
    const coveragePct = stats.sumSched > 0 ? Math.min(100, Math.round((stats.sumLive / stats.sumSched) * 100)) : 100
    const avgDelaySecs = stats.delayMeasurements > 0 ? Math.round(stats.sumDelaySecs / stats.delayMeasurements) : 0
    const latePct = stats.delayMeasurements > 0 ? Math.round((stats.lateMeasurements / stats.delayMeasurements) * 100) : 0
    const severePct = stats.delayMeasurements > 0 ? Math.round((stats.severeMeasurements / stats.delayMeasurements) * 100) : 0

    if (route.mode === 'tram') {
      totalTramLiveSum += avgLive
      totalTramSchedSum += avgSched
    }
    totalDelayMeas += stats.delayMeasurements
    totalLateMeas += stats.lateMeasurements
    totalSevereMeas += stats.severeMeasurements
    totalDelaySum += stats.sumDelaySecs
    if (stats.maxDelaySecs > maxDelayDay) maxDelayDay = stats.maxDelaySecs

    rows.push({
      id: route.id,
      name: route.name,
      long: route.long,
      mode: route.mode,
      color: route.color,
      text: route.text,
      samples: stats.samples,
      avgLive,
      avgSched,
      minLive: stats.minLive,
      maxLive: stats.maxLive,
      avgMissing,
      maxMissing: stats.maxMissing,
      coveragePct,
      avgDelaySecs,
      maxDelaySecs: stats.maxDelaySecs,
      latePct,
      severePct,
      delayMeasurements: stats.delayMeasurements,
    })
  }

  rows.sort((a, b) => net.byRoute(a.id, b.id))

  return {
    date: dayRecord.date,
    samples: dayRecord.samples,
    firstTs: dayRecord.firstTs,
    lastTs: dayRecord.lastTs,
    avgTramLive: +totalTramLiveSum.toFixed(1),
    avgTramSched: +totalTramSchedSum.toFixed(1),
    tramCoveragePct: totalTramSchedSum > 0 ? Math.min(100, Math.round((totalTramLiveSum / totalTramSchedSum) * 100)) : 100,
    avgDelaySecs: totalDelayMeas > 0 ? Math.round(totalDelaySum / totalDelayMeas) : 0,
    maxDelaySecs: maxDelayDay,
    latePct: totalDelayMeas > 0 ? Math.round((totalLateMeas / totalDelayMeas) * 100) : 0,
    severePct: totalDelayMeas > 0 ? Math.round((totalSevereMeas / totalDelayMeas) * 100) : 0,
    rows,
  }
}

/** Exporte tout l'historique journalier par ligne au format CSV pour tableur / rapport citoyen. */
export function exportHistoryCsv(net, store) {
  const header = [
    'date',
    'ligne_id',
    'ligne_nom',
    'mode',
    'releves',
    'vehicules_reels_moy',
    'vehicules_theoriques_moy',
    'vehicules_manquants_moy',
    'vehicules_manquants_max',
    'taux_couverture_pct',
    'retard_moyen_sec',
    'retard_max_sec',
    'taux_retard_3min_pct',
    'taux_retard_5min_pct',
  ].join(';')

  const lines = [header]
  const days = Object.values(store?.days ?? {}).sort((a, b) => b.date - a.date)
  for (const d of days) {
    const sum = summarizeDay(net, d)
    if (!sum) continue
    const dateStr = `${Math.floor(d.date / 10000)}-${String(Math.floor(d.date / 100) % 100).padStart(2, '0')}-${String(d.date % 100).padStart(2, '0')}`
    for (const r of sum.rows) {
      lines.push([
        dateStr,
        r.id,
        `"${r.name} (${r.long.replace(/"/g, '""')})"`,
        r.mode,
        r.samples,
        r.avgLive,
        r.avgSched,
        r.avgMissing,
        r.maxMissing,
        r.coveragePct,
        r.avgDelaySecs,
        r.maxDelaySecs,
        r.latePct,
        r.severePct,
      ].join(';'))
    }
  }
  return lines.join('\n')
}

export function loadObservatoryStore(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(ANALYTICS_STORAGE_KEY)
    if (!raw) return createEmptyStore()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return createEmptyStore()
    return {
      version: 1,
      days: parsed.days ?? {},
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
    }
  } catch {
    return createEmptyStore()
  }
}

export function saveObservatoryStore(store, storage = globalThis.localStorage) {
  try {
    storage?.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* quota ou navigation privée */
  }
}
