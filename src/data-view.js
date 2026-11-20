// Vue « Data » (Observatoire de la qualité du réseau) : affiche les écarts entre l'offre
// théorique et le service réel, les retards par ligne, l'historique par jour et l'export CSV/JSON.
import { h } from './dom.js'
import { badge } from './views.js'
import { summarizeDay, exportHistoryCsv } from './analytics.js'
import { formatClock, localParts } from './time.js'

const fmtDate = (d) =>
  `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`

function fmtDelay(secs) {
  if (!secs || secs <= 0) return '0 min'
  if (secs < 60) return `+${secs} s`
  const min = Math.floor(secs / 60)
  const rem = secs % 60
  return rem >= 15 && min < 10 ? `+${min}m${String(rem).padStart(2, '0')}` : `+${min} min`
}

function severityAttr(coveragePct, latePct, maxDelaySecs) {
  if (coveragePct < 75 || latePct >= 40 || maxDelaySecs >= 600) return 'critical'
  if (coveragePct < 92 || latePct >= 20 || maxDelaySecs >= 300) return 'warn'
  return 'ok'
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function renderTimelineSvg(timeline) {
  if (timeline.length < 2) {
    return h('p', { class: 'sub' }, 'La courbe temps réel se trace au fil des actualisations toutes les 10 s…')
  }
  const W = 340
  const H = 96
  const PAD_X = 8
  const PAD_Y = 12
  const maxVal = Math.max(10, ...timeline.flatMap((p) => [p.tramLive, p.tramSched]))
  const xAt = (i) => PAD_X + (i / (timeline.length - 1)) * (W - PAD_X * 2)
  const yAt = (v) => H - PAD_Y - (v / maxVal) * (H - PAD_Y * 2)

  const schedPts = timeline.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.tramSched).toFixed(1)}`).join(' ')
  const livePts = timeline.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.tramLive).toFixed(1)}`).join(' ')
  const areaPts = `${xAt(0).toFixed(1)},${(H - PAD_Y).toFixed(1)} ${livePts} ${xAt(timeline.length - 1).toFixed(1)},${(H - PAD_Y).toFixed(1)}`

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'dchart__svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Évolution du nombre de rames de tram en circulation comparé au théorique')

  const make = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    return el
  }

  svg.append(
    make('polygon', { points: areaPts, class: 'dchart__area' }),
    make('polyline', { points: schedPts, class: 'dchart__line dchart__line--sched' }),
    make('polyline', { points: livePts, class: 'dchart__line dchart__line--live' }),
  )

  const firstTime = formatClock(timeline[0].secs)
  const lastTime = formatClock(timeline.at(-1).secs)

  return h('div', { class: 'dchart' },
    h('div', { class: 'dchart__legend' },
      h('span', { class: 'dchart__item dchart__item--live' }, `Rames réelles (${timeline.at(-1).tramLive})`),
      h('span', { class: 'dchart__item dchart__item--sched' }, `Prévues GTFS (${timeline.at(-1).tramSched})`)),
    svg,
    h('div', { class: 'dchart__axis' },
      h('span', {}, firstTime),
      h('span', {}, `${timeline.length} relevés (cycle 10 s)`),
      h('span', {}, lastTime)))
}

export function createDataPanel({ host, net, standalone = false, onClearHistory }) {
  let filterMode = 'tram' // 'tram' | 'bus' | 'all'
  let selectedDate = null

  function render({ metrics, store, displayMode }) {
    const dayKeys = Object.keys(store.days).sort((a, b) => Number(b) - Number(a))
    if (!selectedDate || !store.days[String(selectedDate)]) {
      selectedDate = dayKeys[0] ? Number(dayKeys[0]) : metrics?.date ?? null
    }
    const daySummary = selectedDate ? summarizeDay(net, store.days[String(selectedDate)]) : null

    const sum = metrics?.summary
    const isScheduleOnly = displayMode === 'schedule'

    // Cartes de synthèse globale (KPIs)
    const kpiCards = sum ? h('div', { class: 'dkpis' },
      h('div', { class: 'dkpi', 'data-severity': sum.tramCoveragePct < 80 ? 'critical' : sum.tramCoveragePct < 95 ? 'warn' : 'ok' },
        h('span', { class: 'dkpi__label' }, 'Rames Tram (réel / prévu)'),
        h('strong', { class: 'dkpi__val' }, `${sum.totalTramLive} / ${sum.totalTramSched}`),
        h('span', { class: 'dkpi__sub' }, sum.tramMissing > 0 ? `−${sum.tramMissing} rame${sum.tramMissing > 1 ? 's' : ''} manquante${sum.tramMissing > 1 ? 's' : ''} (${sum.tramCoveragePct}%)` : '100% du service assuré')),
      h('div', { class: 'dkpi', 'data-severity': sum.networkLatePct >= 35 ? 'critical' : sum.networkLatePct >= 15 ? 'warn' : 'ok' },
        h('span', { class: 'dkpi__label' }, 'Trajets en retard (≥ 3 min)'),
        h('strong', { class: 'dkpi__val' }, `${sum.networkLatePct}%`),
        h('span', { class: 'dkpi__sub' }, `${sum.totalLateTrips} sur ${sum.totalTripsMeasured} trajets suivis`)),
      h('div', { class: 'dkpi', 'data-severity': sum.networkAvgDelaySecs >= 300 ? 'critical' : sum.networkAvgDelaySecs >= 120 ? 'warn' : 'ok' },
        h('span', { class: 'dkpi__label' }, 'Retard moyen réseau'),
        h('strong', { class: 'dkpi__val' }, fmtDelay(sum.networkAvgDelaySecs)),
        h('span', { class: 'dkpi__sub' }, `Pic max : ${fmtDelay(sum.maxNetworkDelay)}`)),
      h('div', { class: 'dkpi', 'data-severity': sum.totalSevereTrips > 0 ? 'critical' : 'ok' },
        h('span', { class: 'dkpi__label' }, 'Retards critiques (≥ 5 min)'),
        h('strong', { class: 'dkpi__val' }, String(sum.totalSevereTrips)),
        h('span', { class: 'dkpi__sub' }, `${sum.activeAlertsCount} alerte${sum.activeAlertsCount > 1 ? 's' : ''} officielle${sum.activeAlertsCount > 1 ? 's' : ''} en cours`)),
    ) : null

    // Sélecteur de filtre Tram / Bus / Tout
    const modeFilter = h('div', { class: 'dfilter', role: 'group', 'aria-label': 'Filtrer par mode de transport' },
      [['tram', 'Tramways (L1–L5)'], ['bus', 'Bus'], ['all', 'Tout le réseau']].map(([val, label]) =>
        h('button', {
          type: 'button',
          class: 'btn btn--sm',
          'data-active': String(filterMode === val),
          onclick: () => { filterMode = val; render({ metrics, store, displayMode }) },
        }, label)))

    // Cartes détaillées par ligne (temps réel vs théorique)
    const filteredRoutes = (metrics?.byRoute ?? []).filter((r) => {
      if (filterMode === 'tram') return r.mode === 'tram'
      if (filterMode === 'bus') return r.mode === 'bus' && (r.liveCount > 0 || r.schedCount > 0 || r.measuredCount > 0)
      return r.mode === 'tram' || r.liveCount > 0 || r.schedCount > 0 || r.measuredCount > 0
    })

    const liveRoutesList = h('div', { class: 'droutes' },
      filteredRoutes.length === 0
        ? h('p', { class: 'sub' }, 'Aucune ligne active pour ce filtre.')
        : filteredRoutes.map((r) => {
          const route = net.routesById.get(r.id)
          const sev = severityAttr(r.coveragePct, r.latePct, r.maxDelaySecs)
          const barPct = r.schedCount > 0 ? Math.min(100, Math.round((r.liveCount / r.schedCount) * 100)) : (r.liveCount > 0 ? 100 : 0)
          return h('article', { class: 'droute', 'data-severity': sev },
            h('div', { class: 'droute__head' },
              badge(route),
              h('div', { class: 'droute__title' },
                h('strong', {}, r.mode === 'tram' ? `Ligne ${r.name}` : `Bus ${r.name}`),
                h('span', { class: 'sub' }, r.long)),
              r.missingVehicles > 0
                ? h('span', { class: 'tag', 'data-kind': 'late' }, `−${r.missingVehicles} véhicule${r.missingVehicles > 1 ? 's' : ''}`)
                : h('span', { class: 'tag', 'data-kind': 'ontime' }, 'Complet')),
            h('div', { class: 'droute__bar-wrap' },
              h('div', { class: 'droute__bar', style: { width: `${barPct}%`, background: route.color } })),
            h('div', { class: 'droute__stats' },
              h('div', {},
                h('small', {}, 'En service / Prévu'),
                h('strong', {}, `${r.liveCount} / ${r.schedCount} (${r.coveragePct}%)`)),
              h('div', {},
                h('small', {}, 'Retard moyen / Max'),
                h('strong', { 'data-late': String(r.avgDelaySecs >= 180) },
                  r.measuredCount > 0 ? `${fmtDelay(r.avgDelaySecs)} / ${fmtDelay(r.maxDelaySecs)}` : '—')),
              h('div', {},
                h('small', {}, 'Taux retard ≥ 3m'),
                h('strong', { 'data-late': String(r.latePct >= 25) },
                  r.measuredCount > 0 ? `${r.latePct}% (${r.lateCount}/${r.measuredCount})` : '—'))))
        }))

    // Section Historique journalier par jour et par ligne
    const daySelector = dayKeys.length > 0
      ? h('div', { class: 'ddays' },
        dayKeys.map((dk) => {
          const dNum = Number(dk)
          const dRec = store.days[dk]
          return h('button', {
            type: 'button',
            class: 'dday-chip',
            'data-active': String(dNum === selectedDate),
            onclick: () => { selectedDate = dNum; render({ metrics, store, displayMode }) },
          }, fmtDate(dNum), h('small', {}, ` (${dRec.samples})`))
        }))
      : null

    const dayTable = daySummary ? h('div', { class: 'dday-box' },
      h('div', { class: 'dday-meta' },
        h('span', {}, `${daySummary.samples} relevé${daySummary.samples > 1 ? 's' : ''} enregistré${daySummary.samples > 1 ? 's' : ''} (${formatClock(localParts(daySummary.firstTs, net.meta.timezone).secs)} → ${formatClock(localParts(daySummary.lastTs, net.meta.timezone).secs)})`),
        h('span', {}, `Couverture tram moy. : ${daySummary.tramCoveragePct}% · Retard moy. : ${fmtDelay(daySummary.avgDelaySecs)}`)),
      h('div', { class: 'dtable-wrap' },
        h('table', { class: 'dtable' },
          h('thead', {},
            h('tr', {},
              h('th', {}, 'Ligne'),
              h('th', {}, 'Véhicules (moy.)'),
              h('th', {}, 'Manquants (moy./max)'),
              h('th', {}, 'Retard moy. / max'),
              h('th', {}, 'Retards ≥ 3m'))),
          h('tbody', {},
            daySummary.rows
              .filter((r) => filterMode === 'all' || r.mode === filterMode)
              .map((r) => {
                const route = net.routesById.get(r.id)
                return h('tr', {},
                  h('td', {}, badge(route, true)),
                  h('td', { class: 'dtable__num' }, `${r.avgLive} / ${r.avgSched} (${r.coveragePct}%)`),
                  h('td', { class: 'dtable__num', 'data-late': String(r.avgMissing >= 1) },
                    r.maxMissing > 0 ? `−${r.avgMissing} (pic −${r.maxMissing})` : '0'),
                  h('td', { class: 'dtable__num', 'data-late': String(r.avgDelaySecs >= 180) },
                    r.delayMeasurements > 0 ? `${fmtDelay(r.avgDelaySecs)} / ${fmtDelay(r.maxDelaySecs)}` : '—'),
                  h('td', { class: 'dtable__num', 'data-late': String(r.latePct >= 25) },
                    r.delayMeasurements > 0 ? `${r.latePct}%` : '—'))
              })))))
      : h('p', { class: 'sub' }, 'Aucun relevé archivé pour le moment.')

    // Journal des défaillances constatées (sous-effectifs & retards critiques)
    const incidentNodes = store.incidents.length > 0
      ? h('ul', { class: 'dincidents' },
        store.incidents.slice(0, 15).map((inc) => {
          const route = inc.route ? net.routesById.get(inc.route) : null
          const timeStr = formatClock(localParts(inc.ts, net.meta.timezone).secs)
          return h('li', { class: 'dincident', 'data-kind': inc.kind },
            route ? badge(route, true) : h('span', { class: 'tag', 'data-kind': 'late' }, '!'),
            h('div', { class: 'dincident__body' },
              h('strong', {}, inc.title),
              h('span', { class: 'sub' }, `${fmtDate(inc.date)} à ${timeStr}`)))
        }))
      : h('p', { class: 'notice' }, 'Aucune anomalie majeure archivée pour l\'instant.')

    // Boutons d'export des preuves (CSV / JSON)
    const actionsBar = h('div', { class: 'dactions' },
      h('button', {
        type: 'button',
        class: 'btn btn--sm',
        onclick: () => downloadFile(`observatoire-tam-${selectedDate || 'data'}.csv`, exportHistoryCsv(net, store), 'text/csv;charset=utf-8'),
      }, 'Exporter CSV (Tableur)'),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => downloadFile(`observatoire-tam-${selectedDate || 'data'}.json`, JSON.stringify(store, null, 2), 'application/json'),
      }, 'Exporter JSON brut'),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => onClearHistory?.(),
      }, 'Réinitialiser'))

    host.replaceChildren(
      h('div', { class: 'dhead' },
        h('div', { class: 'dsection-head' },
          h('h2', { class: 'h' }, 'Observatoire & Centre de données'),
          standalone ? null : h('a', { class: 'btn btn--ghost btn--sm datapage__link', href: '/data.html' }, 'Ouvrir en pleine page ↗')),
        h('p', { class: 'sub' }, 'Comparaison automatique toutes les 10 s entre les horaires théoriques engagés (GTFS) et la réalité du terrain (véhicules en service et retards GTFS-RT).')),
      isScheduleOnly
        ? h('p', { class: 'notice', 'data-kind': 'warn' }, 'Mode horaires théoriques actif : passez en mode « Automatique » ou « Instantané » dans l\'onglet Infos pour analyser les écarts et retards réels.')
        : null,
      kpiCards,
      renderTimelineSvg(store.timeline),
      h('div', { class: 'dsection-head' },
        h('h3', { class: 'h' }, 'Diagnostic en direct par ligne'),
        modeFilter),
      liveRoutesList,
      h('h3', { class: 'h' }, 'Historique par jour et par ligne'),
      daySelector,
      dayTable,
      h('h3', { class: 'h' }, 'Journal des défaillances relevées'),
      incidentNodes,
      h('h3', { class: 'h' }, 'Export des données & rapports'),
      actionsBar,
    )
  }

  return { render }
}
