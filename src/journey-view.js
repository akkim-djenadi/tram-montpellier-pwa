// Onglet « Trajet » : choix d'un arrêt de départ et d'arrivée, heure, puis itinéraires avec heure d'arrivée précise.
import { h } from './dom.js'
import { badge } from './views.js'
import { searchStations, formatDistance } from './domain.js'
import { localParts, formatClock, nextDate } from './time.js'

const pad = (n) => String(n).padStart(2, '0')
const toMinutes = (secs) => Math.max(1, Math.round(secs / 60))

/**
 * deps : { net, router, onShow(journey|null), liveForLeg(leg, date), requestMyStation(), userStation() }
 * Renvoie { setFrom, setTo, update }.
 */
export function createJourneyPanel({ host, net, router, onShow, liveForLeg, requestMyStation }) {
  const state = { from: null, to: null, mode: 'now', time: '', results: null, selected: 0, error: null }
  const tz = net.meta.timezone
  const nameOf = (stopId) => net.stopsById.get(stopId)?.name ?? ''
  const clock = (secs) => formatClock(secs)
  const stationById = (id) => net.stations.find((s) => s.id === id)

  // ── Sélecteur d'arrêt avec suggestions ──
  function picker({ label, pinClass, pinText, placeholder, key, withGeo }) {
    const input = h('input', { class: 'search', type: 'search', autocomplete: 'off', placeholder, 'aria-label': label, 'aria-autocomplete': 'list' })
    const list = h('ul', { class: 'suggest', role: 'listbox', 'aria-label': `Suggestions : ${label}`, hidden: true })
    const clear = h('button', { class: 'jfield__clear', type: 'button', 'aria-label': `Effacer ${label.toLowerCase()}`, hidden: true, onclick: () => { choose(null); input.focus() } }, '×')
    const geo = withGeo
      ? h('button', { class: 'jfield__geo', type: 'button', 'aria-label': 'Partir de ma position', title: 'Partir de ma position', onclick: () => requestMyStation() }, '⌖')
      : h('span', { class: 'jfield__spacer' })
    const el = h('div', { class: 'jfield' },
      h('span', { class: `jfield__pin ${pinClass}`, 'aria-hidden': 'true' }, pinText), h('div', { style: { position: 'relative' } }, input, clear), geo, list)

    function choose(station) {
      state[key] = station
      state.results = null; state.error = null
      input.value = station?.name ?? ''
      clear.hidden = !station
      list.hidden = true
      renderResults(); syncGo(); onShow(null)
      if (station && state.from && state.to) runSearch()
    }
    input.addEventListener('input', () => {
      if (state[key]) { state[key] = null; state.results = null; renderResults(); syncGo() }
      clear.hidden = input.value === ''
      const found = searchStations(net.stations, input.value)
      list.replaceChildren(...found.map((s) => h('li', {}, h('button', { type: 'button', role: 'option', onclick: () => choose(s) },
        h('span', {}, s.name), h('span', { class: 'row__badges' }, s.routes.slice(0, 6).map((r) => badge(net.routesById.get(r), true)))))))
      list.hidden = found.length === 0
    })
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true }, 150))
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') list.querySelector('button')?.click() })
    return { el, choose, geo }
  }

  const from = picker({ label: 'Départ', pinClass: 'jfield__pin--a', pinText: 'A', placeholder: 'Arrêt de départ', key: 'from', withGeo: true })
  const to = picker({ label: 'Arrivée', pinClass: 'jfield__pin--b', pinText: 'B', placeholder: "Arrêt d'arrivée", key: 'to', withGeo: false })

  const swap = h('button', { class: 'jswap', type: 'button', onclick: () => {
    const [a, b] = [state.from, state.to]
    from.choose(null); to.choose(null)
    state.from = b; state.to = a
    from.el.querySelector('input').value = b?.name ?? ''; to.el.querySelector('input').value = a?.name ?? ''
    from.el.querySelector('.jfield__clear').hidden = !b; to.el.querySelector('.jfield__clear').hidden = !a
    syncGo()
    if (a && b) runSearch()
  } }, '⇅ Inverser')

  const timeInput = h('input', { type: 'time', 'aria-label': "Heure de départ", disabled: true, onchange: (e) => { state.time = e.target.value; state.results = null; renderResults() } })
  const radio = (value, text) => h('label', {}, h('input', { type: 'radio', name: 'jmode', value, checked: value === 'now', onchange: () => {
    state.mode = value; timeInput.disabled = value === 'now'
    if (value === 'at' && !timeInput.value) { const p = localParts(Date.now(), tz); timeInput.value = `${pad(Math.floor(p.secs / 3600))}:${pad(Math.floor((p.secs % 3600) / 60))}`; state.time = timeInput.value }
    state.results = null; renderResults()
  } }), text)
  const go = h('button', { class: 'btn jgo', type: 'button', disabled: true, onclick: () => runSearch() }, 'Calculer l\'itinéraire')
  const results = h('div', { class: 'jcards', 'aria-live': 'polite' })

  host.append(h('div', { class: 'jform' }, from.el, to.el, swap,
    h('div', { class: 'jtime', role: 'radiogroup', 'aria-label': 'Heure de départ' }, radio('now', 'Partir maintenant'), radio('at', 'Partir à'), timeInput), go), results)

  const syncGo = () => { go.disabled = !(state.from && state.to) }

  // ── Calcul ──
  function runSearch() {
    if (!state.from || !state.to) return
    if (state.from.id === state.to.id) { state.error = 'Le départ et l\'arrivée sont le même arrêt.'; state.results = null; renderResults(); return }
    const now = localParts(Date.now(), tz)
    let { date, secs } = now
    if (state.mode === 'at' && state.time) {
      const [hh, mm] = state.time.split(':').map(Number)
      secs = hh * 3600 + mm * 60
      if (secs < now.secs) date = nextDate(date) // heure déjà passée aujourd'hui : demain
    }
    if (date < net.meta.firstDate || date > net.meta.lastDate) {
      state.error = `Horaires disponibles du ${fmtDate(net.meta.firstDate)} au ${fmtDate(net.meta.lastDate)}.`
      state.results = null; renderResults(); return
    }
    state.error = null
    state.results = router.plan({ fromStopIds: state.from.stopIds, toStopIds: state.to.stopIds, date, secs, count: 4 })
    state.selected = 0
    state.askedFor = { date, secs, tomorrow: date !== now.date }
    renderResults()
    onShow(state.results[0] ?? null)
    results.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const fmtDate = (d) => `${pad(d % 100)}/${pad(Math.floor(d / 100) % 100)}/${Math.floor(d / 10000)}`

  // ── Rendu des résultats ──
  const dayTag = (secs, base) => (secs >= 86400 || base?.tomorrow ? ' (+1 j)' : '')

  function legRows(journey) {
    const rows = []
    const legs = journey.legs
    legs.forEach((leg, i) => {
      if (leg.type === 'ride') {
        const route = net.routesById.get(leg.route)
        const live = i === legs.findIndex((l) => l.type === 'ride') ? liveForLeg(leg, journey.date) : null
        rows.push(h('li', { class: 'jleg' },
          h('div', { class: 'jleg__time' }, clock(leg.dep), h('small', {}, clock(leg.arr))),
          h('div', { class: 'jleg__what' },
            h('div', { class: 'jleg__title' }, badge(route), `→ ${leg.headsign ?? 'terminus'}`),
            h('div', { class: 'jleg__meta' }, `${nameOf(leg.fromStop)} → ${nameOf(leg.toStop)} · ${leg.stopCount} arrêt${leg.stopCount > 1 ? 's' : ''} · ${toMinutes(leg.arr - leg.dep)} min`),
            live ? h('div', { class: 'jlive', 'data-late': String(live.delay >= 60) }, `Temps réel : départ ${clock(live.secs)}${live.delay >= 60 ? ` (+${toMinutes(live.delay)} min)` : live.delay <= -60 ? ` (${Math.round(live.delay / 60)} min)` : " (à l'heure)"}`) : null)))
        const next = legs[i + 1]
        const nextRide = next?.type === 'ride' ? next : null
        if (nextRide) rows.push(h('li', { class: 'jleg jleg--wait' }, h('div', { class: 'jleg__meta' }, `Correspondance à ${nameOf(leg.toStop)} : ${toMinutes(nextRide.dep - leg.arr)} min d'attente`)))
      } else {
        rows.push(h('li', { class: 'jleg jleg--walk' },
          h('div', { class: 'jleg__time' }, clock(leg.dep)),
          h('div', { class: 'jleg__what' },
            h('div', { class: 'jleg__title' }, '🚶 Marche'),
            h('div', { class: 'jleg__meta' }, `${nameOf(leg.fromStop)} → ${nameOf(leg.toStop)} · ${formatDistance(leg.meters)} · ${toMinutes(leg.secs)} min`))))
        const upcoming = legs[i + 1]
        if (upcoming?.type === 'ride' && upcoming.dep - leg.arr >= 60) {
          rows.push(h('li', { class: 'jleg jleg--wait' }, h('div', { class: 'jleg__meta' }, `Attente à ${nameOf(leg.toStop)} : ${toMinutes(upcoming.dep - leg.arr)} min`)))
        }
      }
    })
    rows.push(h('li', { class: 'jleg' }, h('div', { class: 'jleg__time' }, clock(journey.arrival)),
      h('div', { class: 'jleg__what' }, h('div', { class: 'jleg__title' }, `Arrivée à ${state.to.name}`))))
    return rows
  }

  function renderResults() {
    if (state.error) { results.replaceChildren(h('p', { class: 'notice', 'data-kind': 'warn' }, state.error)); return }
    if (!state.results) { results.replaceChildren(); return }
    if (state.results.length === 0) {
      results.replaceChildren(h('p', { class: 'notice', 'data-kind': 'warn' }, "Aucun itinéraire trouvé dans les 4 heures qui suivent. Essayez une autre heure ou un autre arrêt."))
      return
    }
    const fastest = Math.min(...state.results.map((j) => j.arrival))
    const fewest = Math.min(...state.results.map((j) => j.transfers))
    const base = state.askedFor
    const nowSecs = localParts(Date.now(), tz).secs
    results.replaceChildren(...state.results.map((j, i) => {
      const selected = i === state.selected
      const rides = j.legs.filter((l) => l.type === 'ride')
      const live = rides.length ? liveForLeg(rides[0], j.date) : null
      const estimated = live && j.transfers === 0 && live.delay >= 60 ? j.arrival + live.delay : null
      const inMin = !base?.tomorrow && state.mode === 'now' ? toMinutes(Math.max(0, j.departure - nowSecs)) : null
      return h('article', { class: 'jcard', 'data-selected': String(selected) },
        h('button', { class: 'jcard__head', type: 'button', 'aria-expanded': String(selected), onclick: () => { state.selected = i; renderResults(); onShow(j) } },
          h('div', { class: 'jcard__top' },
            h('span', { class: 'jcard__arrive' }, h('small', {}, 'Arrivée'), clock(j.arrival), dayTag(j.arrival, base) ? h('small', {}, dayTag(j.arrival, base)) : null),
            h('span', { class: 'jcard__dur' }, `${toMinutes(j.arrival - j.departure)} min`)),
          h('div', { class: 'jcard__chain' }, j.legs.map((l, n) => (l.type === 'ride'
            ? [n > 0 ? '›' : null, badge(net.routesById.get(l.route), true)]
            : [n > 0 ? '›' : null, '🚶']))),
          h('p', { class: 'jcard__sub' },
            `Départ ${clock(j.departure)}${dayTag(j.departure, base)}`, inMin !== null ? ` (dans ${inMin} min)` : '', ' · ',
            j.transfers === 0 ? 'direct' : `${j.transfers} correspondance${j.transfers > 1 ? 's' : ''}`,
            estimated ? ` · arrivée estimée ${clock(estimated)} (temps réel)` : ''),
          h('div', {},
            j.arrival === fastest ? h('span', { class: 'jtag jtag--fast' }, 'Le plus rapide') : null,
            j.transfers === fewest && j.arrival !== fastest ? h('span', { class: 'jtag' }, 'Le moins de correspondances') : null)),
        selected ? h('ol', { class: 'jlegs' }, legRows(j)) : null)
    }), h('p', { class: 'sub' }, 'Horaires théoriques (GTFS) ; le premier départ est comparé au temps réel quand il est disponible.'))
  }

  return {
    setFrom(station) { from.choose(stationById(station.id) ?? station) },
    setTo(station) { to.choose(stationById(station.id) ?? station) },
    update() { if (state.results) renderResults() },
    clearMap() { onShow(null) },
    showSelected() { if (state.results?.length) onShow(state.results[state.selected]) },
  }
}
