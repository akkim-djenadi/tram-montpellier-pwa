// Point d'entrée : charge le réseau, orchestre carte, temps réel, géolocalisation et panneau.
import { config } from '../config.js'
import { h } from './dom.js'
import { createNetwork, vehiclesAt, departuresAt } from './schedule.js'
import { fetchRealtime, buildLiveState, liveVehiclesAt, isFresh, liveDepartures, pickDepartures, ageSeconds } from './realtime.js'
import { createBaseMap, createMap } from './map.js'
import { createSheet } from './sheet.js'
import { startLocating, geoErrorMessage } from './locate.js'
import { setupInstall } from './install.js'
import { nearestStations, searchStations, delayLabel } from './domain.js'
import { localParts, formatClock } from './time.js'
import { createRouter } from './router.js'
import { createJourneyPanel } from './journey-view.js'
import * as views from './views.js'

const $ = (id) => document.getElementById(id)
const PREFS_KEY = 'tram-mtp:prefs:v1'
const POPULAR_MIN_LINES = 2

const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {} } catch { return {} }
}
const savePrefs = (patch) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })) } catch { /* stockage indisponible */ }
}

/** Remplace le contenu d'un hôte en conservant le focus clavier (via data-key). */
function renderInto(host, nodes) {
  const key = host.contains(document.activeElement) ? document.activeElement.dataset?.key : null
  host.replaceChildren(...[nodes].flat(Infinity).filter(Boolean))
  if (key) host.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
}

async function boot() {
  const prefs = loadPrefs()
  // La carte d'abord : elle s'affiche pendant que les données du réseau se téléchargent.
  const baseMap = createBaseMap({ el: $('map'), config, initialView: prefs.view })
  const raw = await (await fetch('/data/network.json')).json()
  const net = createNetwork(raw)

  let S = {
    mode: prefs.mode ?? 'auto', live: null, liveError: null, lineQuery: '',
    active: new Set(prefs.active ?? [...net.routesById.values()].filter((r) => r.mode === 'tram').map((r) => r.id)),
    online: navigator.onLine, userPos: null, userError: null, station: null, query: '', tab: 'around',
  }
  const set = (patch) => { S = { ...S, ...patch } }

  // ── Dérivés ──
  const displayMode = (now = Date.now()) => {
    if (S.mode === 'schedule') return 'schedule'
    if (S.mode === 'snapshot') return S.live ? 'snapshot' : 'schedule'
    return S.live && isFresh(S.live, now) ? 'live' : 'schedule'
  }
  const viewNow = () => (displayMode() === 'snapshot' ? S.live.timestamp : Date.now())
  const visible = (r) => S.active.has(r)
  const activeRoutes = () => [...net.routesById.keys()].filter(visible)

  // Stations restreintes aux lignes actives (leurs badges aussi), mémorisées tant que la sélection ne change pas.
  let stationsCache = { key: null, list: [] }
  function activeStations() {
    const key = activeRoutes().join(',')
    if (stationsCache.key !== key) {
      stationsCache = {
        key,
        list: net.stations.map((s) => ({ ...s, routes: s.routes.filter(visible) })).filter((s) => s.routes.length > 0),
      }
    }
    return stationsCache.list
  }

  function currentTrams(now = Date.now()) {
    const mode = displayMode(now)
    const list = mode === 'schedule'
      ? vehiclesAt(net, now, { routes: S.active })
      : mode === 'live'
        ? liveVehiclesAt(net, S.live, now)
        : S.live.vehicles
    return list.filter((t) => visible(t.route))
  }

  function stationDepartures(station, limit = 8) {
    const now = viewNow()
    const mode = displayMode()
    return station.stopIds
      .flatMap((id) => {
        const scheduled = mode === 'snapshot' ? [] : departuresAt(net, id, now, { limit, routes: S.active })
        const live = mode === 'schedule' ? [] : liveDepartures(S.live, id, now, limit * 2).filter((d) => visible(d.route))
        return pickDepartures(live, scheduled, limit)
      })
      .sort((a, b) => a.inSecs - b.inSecs)
      .slice(0, limit)
  }

  const ctx = () => ({
    net, mode: S.mode, userPos: S.userPos, trams: currentTrams(), active: S.active, lineQuery: S.lineQuery,
    alerts: S.live?.alerts ?? [],
  })

  // ── Carte ──
  const describeTram = (t) => {
    const route = net.routesById.get(t.route)
    const nextId = t.stopId ?? t.nextStopId
    const lateness = delayLabel(t.delay)?.text
    // Le flux GTFS-RT TaM fournit déjà speed en km/h ; le moteur théorique le calcule en m/s.
    const kmh = Math.round(t.source === 'live' ? (t.speed ?? 0) : (t.speed ?? 0) * 3.6)
    return h('div', { class: 'pop' },
      h('div', { class: 'pop__head' }, views.badge(route), `→ ${t.headsign ?? 'direction inconnue'}`),
      nextId ? h('div', { class: 'pop__row' }, t.status === 1 ? 'À l\'arrêt' : 'Prochain arrêt', h('strong', {}, net.stopsById.get(nextId)?.name ?? '')) : null,
      h('div', { class: 'pop__row' }, 'Vitesse', h('strong', {}, `${kmh} km/h`)),
      lateness ? h('div', { class: 'pop__row' }, 'Ponctualité', h('strong', {}, lateness)) : null,
      t.label ? h('div', { class: 'pop__row' }, 'Rame', h('strong', {}, `n° ${t.label}`)) : null,
      h('div', { class: 'pop__row' }, 'Source', h('strong', {}, t.source === 'live' ? (displayMode() === 'snapshot' ? 'instantané' : 'temps réel') : 'horaires théoriques')))
  }

  // Hauteur visible du panneau sur mobile (0 sur grand écran, où il est latéral).
  const bottomInset = () => {
    if (window.matchMedia('(min-width: 900px)').matches) return 0
    const snap = $('sheet').dataset.snap
    return snap === 'peek' ? 168 : window.innerHeight * (snap === 'half' ? 0.54 : 0.88)
  }

  const mapCtl = createMap({
    map: baseMap, config, net, describeTram,
    getBottomInset: () => bottomInset(),
    onStation: (station) => actions.openStation(station),
  })
  mapCtl.onMoveEnd(() => savePrefs({ view: mapCtl.getView() }))
  mapCtl.setVisibleRoutes(activeRoutes())

  // ── Panneau ──
  // Si index.html provient d'un ancien cache Service Worker, on injecte l'onglet et le panneau Data à la volée.
  if (!$('panel-data')) {
    const link = h('link', { rel: 'stylesheet', href: '/styles/data.css' })
    document.head.append(link)
    const tabBtn = h('button', {
      role: 'tab', id: 'tab-data', class: 'tabs__tab',
      'aria-selected': 'false', 'aria-controls': 'panel-data', 'data-tab': 'data', tabindex: '-1',
    }, 'Data')
    const infoTab = $('tab-info')
    if (infoTab?.parentElement) infoTab.parentElement.insertBefore(tabBtn, infoTab)
    const dataPanelEl = h('div', { role: 'tabpanel', id: 'panel-data', class: 'panel', 'aria-labelledby': 'tab-data', hidden: true })
    $('sheet-body')?.append(dataPanelEl)
  }

  const panels = {
    around: $('panel-around'), trams: $('panel-trams'), lines: $('panel-lines'),
    journey: $('panel-journey'), data: $('panel-data'), info: $('panel-info'),
  }
  const sheet = createSheet({
    root: $('sheet'), handle: $('sheet-handle'), tabs: [...document.querySelectorAll('.tabs__tab')], panels,
    onTab: (tab) => { set({ tab }); renderAll() },
  })

  // ── Observatoire / Centre de données ──
  let observatoryStore = loadObservatoryStore()
  let latestMetrics = computeSnapshotMetrics(net, null, Date.now())
  const dataPanel = createDataPanel({
    host: panels.data ?? h('div'),
    net,
    onClearHistory() {
      observatoryStore = createEmptyStore()
      if (S.live) {
        latestMetrics = computeSnapshotMetrics(net, S.live, viewNow())
        observatoryStore = recordSnapshot(observatoryStore, latestMetrics, S.live.alerts)
      }
      saveObservatoryStore(observatoryStore)
      renderData()
    },
  })
  const renderData = () => {
    if (!panels.data) return
    dataPanel.render({ metrics: latestMetrics, store: observatoryStore, displayMode: displayMode() })
  }

  const actions = {
    openStation(full) {
      const station = { ...full, routes: full.routes.filter(visible) }
      set({ station, tab: 'around' })
      sheet.setTab('around')
      sheet.setSnap('half')
      mapCtl.leaflet.panTo([station.lat, station.lon])
      renderAround()
    },
    closeStation() { set({ station: null }); renderAround() },
    focusTram(id) {
      if (window.matchMedia('(max-width: 899px)').matches) sheet.setSnap('peek')
      mapCtl.panToTram(id)
    },
    journeyFrom(station) { openJourney('setFrom', station) },
    journeyTo(station) { openJourney('setTo', station) },
    toggleRoute(id) {
      const active = new Set(S.active)
      if (active.has(id)) active.delete(id); else active.add(id)
      applyActive(active)
    },
    setGroup(mode, on) {
      const active = new Set(S.active)
      for (const r of net.routesById.values()) if (r.mode === mode) { if (on) active.add(r.id); else active.delete(r.id) }
      applyActive(active)
    },
    setMode(mode) {
      set({ mode, live: null, liveError: null })
      savePrefs({ mode })
      poll()
      renderAll()
    },
  }

  // ── Itinéraire d'un arrêt à un autre (horaires théoriques, comparés au temps réel pour le 1er départ) ──
  const router = createRouter(net)
  function liveForLeg(leg, date) {
    const mode = displayMode()
    if (mode === 'schedule' || !S.live || date !== localParts(Date.now(), net.meta.timezone).date) return null
    const candidates = liveDepartures(S.live, leg.fromStop, viewNow(), 16)
      .filter((d) => d.route === leg.route)
      .map((d) => ({ delay: d.delay, secs: localParts(d.epochMs, net.meta.timezone).secs }))
      .map((d) => ({ ...d, gap: Math.abs(d.secs - leg.dep) }))
      .filter((d) => d.gap <= 600)
      .sort((a, b) => a.gap - b.gap)
    return candidates[0] ? { secs: candidates[0].secs, delay: candidates[0].secs - leg.dep } : null
  }
  let pendingGeoStart = false
  const journeyPanel = createJourneyPanel({
    host: panels.journey, net, router, liveForLeg,
    onShow: (journey) => mapCtl.showJourney(journey),
    requestMyStation() {
      if (S.userPos) { fromMyPosition(); return }
      pendingGeoStart = true
      $('btn-locate').click()
    },
  })
  function fromMyPosition() {
    const [nearest] = nearestStations(net.stations, S.userPos, { max: 1, radius: 5000 })
    if (nearest) journeyPanel.setFrom(nearest.station)
    else set({ userError: 'Aucun arrêt à moins de 5 km de votre position.' })
  }
  function openJourney(method, station) {
    sheet.setTab('journey')
    sheet.setSnap('full')
    journeyPanel[method](station)
  }

  /** Applique une nouvelle sélection de lignes : carte, véhicules, listes et puces. */
  function applyActive(active) {
    set({ active })
    savePrefs({ active: [...active] })
    mapCtl.setVisibleRoutes(activeRoutes())
    syncChips()
    applyTrams()
    renderAll()
  }

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher une station…', 'aria-label': 'Rechercher une station', autocomplete: 'off',
    oninput: (e) => { set({ query: e.target.value }); renderAroundList() } })
  const aroundHost = h('div', { class: 'panel__list' })
  panels.around.append(search, aroundHost)

  function renderAroundList() {
    const c = ctx()
    if (S.station) {
      search.hidden = true
      renderInto(aroundHost, views.stationDetail(c, S.station, stationDepartures(S.station, 12), actions))
      return
    }
    search.hidden = false
    const withDeps = (s, meters) => ({ station: s, meters, departures: stationDepartures(s, 6) })
    const nodes = []
    if (S.query.trim().length >= 2) {
      const found = searchStations(activeStations(), S.query)
      nodes.push(found.length ? views.nearbyList(c, found.map((s) => withDeps(s)), actions) : h('p', { class: 'empty' }, 'Aucune station trouvée.'))
    } else if (S.userPos) {
      const near = nearestStations(activeStations(), S.userPos)
      nodes.push(h('h2', { class: 'h' }, 'Arrêts autour de vous'))
      nodes.push(near.length ? views.nearbyList(c, near.map((n) => withDeps(n.station, n.meters)), actions) : h('p', { class: 'notice' }, "Aucun arrêt des lignes sélectionnées à moins de 3 km. Utilisez la recherche ou la carte."))
    } else {
      if (S.userError) nodes.push(h('p', { class: 'notice', 'data-kind': 'error' }, S.userError))
      else nodes.push(h('p', { class: 'notice' }, 'Touchez le bouton ⌖ de la carte pour voir les arrêts et prochains passages autour de vous.'))
      const hubs = activeStations().filter((s) => s.routes.length >= POPULAR_MIN_LINES).sort((a, b) => b.routes.length - a.routes.length || a.name.localeCompare(b.name, 'fr')).slice(0, 5)
      nodes.push(h('h2', { class: 'h' }, 'Grandes stations'))
      nodes.push(views.nearbyList(c, hubs.map((s) => withDeps(s)), actions))
    }
    renderInto(aroundHost, nodes)
  }
  const renderAround = renderAroundList
  const renderTrams = () => renderInto(panels.trams, views.tramList(ctx(), actions))

  const lineSearch = h('input', { class: 'search', type: 'search', placeholder: 'Rechercher une ligne (n°, destination)…', 'aria-label': 'Rechercher une ligne', autocomplete: 'off',
    oninput: (e) => { set({ lineQuery: e.target.value }); renderLines() } })
  const lineHost = h('div', { class: 'panel__list' })
  panels.lines.append(lineSearch, lineHost)
  const renderLines = () => renderInto(lineHost, views.lineChooser(ctx(), actions))

  function renderInfo() {
    const c = ctx()
    const mode = displayMode()
    const when = S.live ? `${new Date(S.live.timestamp).toLocaleString('fr-FR', { timeZone: net.meta.timezone, dateStyle: 'short', timeStyle: 'medium' })}` : '—'
    renderInto(panels.info, [
      h('h2', { class: 'h' }, 'Perturbations'),
      ...views.alertCards(c),
      h('h2', { class: 'h' }, 'Source des positions'),
      views.sourcePicker(c, actions),
      h('p', { class: 'notice', 'data-kind': mode === 'live' ? undefined : 'warn' },
        mode === 'live' ? `Flux temps réel TaM du ${when}.`
          : mode === 'snapshot' ? `Instantané figé du ${when} (fichiers fournis).`
            : S.liveError ? `Flux temps réel indisponible (${S.liveError}) : positions calculées d'après les horaires.`
              : 'Positions calculées d\'après les horaires théoriques du GTFS.'),
      h('h2', { class: 'h' }, 'Tarifs TaM'),
      views.faresList(c),
      net.meta.ticketing ? h('a', { class: 'btn btn--ghost', href: net.meta.ticketing, target: '_blank', rel: 'noopener', style: { textAlign: 'center', textDecoration: 'none' } }, 'Acheter sur m-ticket') : null,
      views.installHint(),
      h('p', { class: 'credits' },
        `Horaires GTFS du ${fmtDate(net.meta.firstDate)} au ${fmtDate(net.meta.lastDate)}. `,
        'Données TaM / Montpellier Méditerranée Métropole (ODbL). Fond de carte © contributeurs ',
        h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'),
        ' · carte Leaflet.'),
    ])
  }
  const fmtDate = (d) => `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`

  function renderAll() {
    if (S.tab === 'around') renderAround()
    if (S.tab === 'trams') renderTrams()
    if (S.tab === 'lines') renderLines()
    if (S.tab === 'data') renderData()
    if (S.tab === 'info') renderInfo()
  }

  // ── Statut ──
  function renderStatus() {
    const mode = displayMode()
    const el = $('status')
    let state = mode
    let text
    if (mode === 'live') {
      const checkedAge = Math.max(0, Math.round((Date.now() - (S.live.fetchedAt ?? S.live.timestamp)) / 1000))
      text = `En direct · ${checkedAge <= 1 ? 'à l\'instant' : `il y a ${checkedAge} s`}`
    } else if (mode === 'snapshot') text = `Instantané · ${formatClock(localParts(S.live.timestamp, net.meta.timezone).secs)}`
    else if (!S.online) { state = 'offline'; text = 'Hors ligne · horaires' }
    else text = 'Horaires théoriques'
    el.dataset.state = state
    $('status-text').textContent = text
  }

  // ── Temps réel ──
  let polling = false
  async function poll() {
    if (polling || S.mode === 'schedule') return
    polling = true
    try {
      const snapshot = S.mode === 'snapshot'
      const result = await fetchRealtime(
        snapshot ? [config.snapshotEndpoint] : config.rtEndpoints,
        { forceOrigin: snapshot ? 'snapshot' : undefined, cacheBust: !snapshot },
      )
      const fetchedAt = Date.now()
      const live = { ...buildLiveState(net, result), fetchedAt }
      set({ live, liveError: null })
      const sampleTime = displayMode() === 'snapshot' ? live.timestamp : fetchedAt
      latestMetrics = computeSnapshotMetrics(net, live, sampleTime)
      observatoryStore = recordSnapshot(observatoryStore, latestMetrics, live.alerts)
      saveObservatoryStore(observatoryStore)
    } catch (error) {
      set({ liveError: error.message || 'erreur réseau' })
    } finally {
      polling = false
    }
    applyTrams()
    renderStatus()
    renderAll()
  }

  function applyTrams() {
    const mode = displayMode()
    mapCtl.setTrams(currentTrams(), { durationMs: mode === 'live' ? config.pollMs : 1000, stale: mode === 'snapshot' })
  }

  // ── Géolocalisation ──
  let stopLocating = null
  let firstFix = true
  $('btn-locate').addEventListener('click', () => {
    if (S.userPos) { mapCtl.flyTo(S.userPos.lat, S.userPos.lon, 16); return }
    if (stopLocating) return
    stopLocating = startLocating({
      onFix(pos) {
        set({ userPos: pos, userError: null })
        mapCtl.setUser(pos)
        $('btn-locate').dataset.active = 'true'
        if (firstFix) {
          firstFix = false
          set({ station: null, query: '' })
          search.value = ''
          sheet.setTab('around')
          mapCtl.flyTo(pos.lat, pos.lon, 15.5)
        }
        if (pendingGeoStart) { pendingGeoStart = false; fromMyPosition(); sheet.setTab('journey') }
        renderAround()
      },
      onError(error) {
        set({ userError: geoErrorMessage(error) })
        stopLocating?.(); stopLocating = null
        sheet.setTab('around'); sheet.setSnap('half')
        renderAround()
      },
    })
  })

  // ── Puces de lignes (barre du haut) : un tram par puce, un bouton « Bus » vers le sélecteur ──
  const chips = $('line-chips')
  const chipFor = new Map()
  for (const route of [...net.routesById.values()].filter((r) => r.mode === 'tram')) {
    const btn = h('button', {
      class: 'chip', type: 'button', style: { '--line': route.color, '--line-ink': route.text },
      'aria-pressed': String(visible(route.id)), 'aria-label': `Ligne de tram ${route.name}`,
      onclick: () => actions.toggleRoute(route.id),
    }, route.name)
    chipFor.set(route.id, btn)
    chips.append(h('li', {}, btn))
  }
  const busCount = h('b', {}, '0')
  const busChip = h('button', { class: 'chip chip--bus', type: 'button', onclick: () => { sheet.setTab('lines'); sheet.setSnap('full') } }, 'Bus', busCount)
  chips.append(h('li', {}, busChip))
  function syncChips() {
    chipFor.forEach((btn, id) => btn.setAttribute('aria-pressed', String(visible(id))))
    const n = [...net.routesById.values()].filter((r) => r.mode === 'bus' && visible(r.id)).length
    busCount.textContent = String(n)
    busChip.setAttribute('aria-pressed', String(n > 0))
    busChip.setAttribute('aria-label', `Choisir les lignes de bus (${n} affichée${n > 1 ? 's' : ''})`)
  }
  syncChips()

  // ── Cycle de vie ──
  setupInstall($('btn-install'), () => { if (S.tab === 'info') renderInfo() })
  window.addEventListener('online', () => { set({ online: true }); poll(); renderStatus() })
  window.addEventListener('offline', () => { set({ online: false }); renderStatus() })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); applyTrams(); renderStatus() } })

  setInterval(() => {
    if (document.hidden) return
    if (displayMode() === 'schedule') applyTrams()
    renderStatus()
    if (!['info', 'lines', 'journey', 'data'].includes(S.tab)) renderAll()
  }, 1000)
  setInterval(() => { if (!document.hidden) poll() }, config.pollMs)

  applyTrams(); renderStatus(); renderAll()
  poll()

  // Pour le débogage et les tests de bout en bout.
  window.__tram = { get state() { return S }, net, displayMode }
}

boot().catch((error) => {
  document.getElementById('status-text').textContent = 'Erreur de chargement'
  console.error(error)
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW', e)))
}
