// Point d'entrée de la page dédiée /data.html : observatoire plein écran actualisé toutes les 10 s.
import { config } from '../config.js'
import { createNetwork } from './schedule.js'
import { fetchRealtime, buildLiveState, isFresh } from './realtime.js'
import {
  computeSnapshotMetrics,
  loadObservatoryStore,
  saveObservatoryStore,
  recordSnapshot,
  createEmptyStore,
} from './analytics.js'
import { createDataPanel } from './data-view.js'
import { formatClock, localParts } from './time.js'

const $ = (id) => document.getElementById(id)

async function bootDataPage() {
  const raw = await (await fetch('/data/network.json')).json()
  const net = createNetwork(raw)

  let store = loadObservatoryStore()
  let live = null
  let latestMetrics = computeSnapshotMetrics(net, null, Date.now())

  const panel = createDataPanel({
    host: $('data-root'),
    net,
    standalone: true,
    onClearHistory() {
      store = createEmptyStore()
      if (live) {
        latestMetrics = computeSnapshotMetrics(net, live, Date.now())
        store = recordSnapshot(store, latestMetrics, live.alerts)
      }
      saveObservatoryStore(store)
      render()
    },
  })

  function displayMode() {
    if (!live) return 'schedule'
    return isFresh(live, Date.now()) ? 'live' : 'snapshot'
  }

  function renderStatus() {
    const mode = displayMode()
    const el = $('status')
    el.dataset.state = mode
    if (mode === 'live') {
      const checkedAge = Math.max(0, Math.round((Date.now() - (live.fetchedAt ?? live.timestamp)) / 1000))
      $('status-text').textContent = `En direct · ${checkedAge <= 1 ? "à l'instant" : `il y a ${checkedAge} s`}`
    } else if (mode === 'snapshot') {
      $('status-text').textContent = `Instantané · ${formatClock(localParts(live.timestamp, net.meta.timezone).secs)}`
    } else {
      $('status-text').textContent = 'Horaires théoriques'
    }
  }

  function render() {
    panel.render({ metrics: latestMetrics, store, displayMode: displayMode() })
  }

  let polling = false
  async function poll() {
    if (polling) return
    polling = true
    try {
      const result = await fetchRealtime(config.rtEndpoints, { cacheBust: true })
      const fetchedAt = Date.now()
      live = { ...buildLiveState(net, result), fetchedAt }
      const sampleTime = isFresh(live, fetchedAt) ? fetchedAt : live.timestamp
      latestMetrics = computeSnapshotMetrics(net, live, sampleTime)
      store = recordSnapshot(store, latestMetrics, live.alerts)
      saveObservatoryStore(store)
    } catch {
      try {
        const result = await fetchRealtime([config.snapshotEndpoint], { forceOrigin: 'snapshot' })
        live = { ...buildLiveState(net, result), fetchedAt: Date.now() }
        latestMetrics = computeSnapshotMetrics(net, live, live.timestamp)
        store = recordSnapshot(store, latestMetrics, live.alerts)
        saveObservatoryStore(store)
      } catch {
        /* repli sur théorique seul */
      }
    } finally {
      polling = false
    }
    renderStatus()
    render()
  }

  renderStatus()
  render()
  await poll()

  setInterval(() => {
    if (!document.hidden) renderStatus()
  }, 1000)
  setInterval(() => {
    if (!document.hidden) poll()
  }, config.pollMs)
}

bootDataPage().catch((error) => {
  $('status-text').textContent = 'Erreur de chargement'
  console.error(error)
})
