// Vues du panneau : chaque fonction renvoie des nœuds DOM à partir d'un contexte (ctx).
import { h } from './dom.js'
import { formatEta, formatClock, localParts } from './time.js'
import { formatDistance, walkMinutes, groupDepartures, delayLabel } from './domain.js'
import { installStatus } from './install.js'

export const lineLabel = (route) => (route.mode === 'tram' ? `L${route.name}` : route.name)
const lineVars = (route) => ({ '--line': route.color, '--line-ink': route.text })
export const badge = (route, small = false) => h('span', { class: `badge${small ? ' badge--sm' : ''}`, style: lineVars(route) }, route.name)

function etaText(d) {
  return formatEta(d.inSecs)
}
const clock = (d, tz) => formatClock(localParts(d.epochMs, tz).secs)

function departureTag(d) {
  if (d.source === 'schedule') return h('span', { class: 'tag' }, 'théorique')
  const label = delayLabel(d.delay)
  return label ? h('span', { class: 'tag', 'data-kind': label.kind }, label.text) : null
}

/** Lignes de passages regroupées par destination (page station). */
export function departureRows(ctx, departures) {
  if (departures.length === 0) return h('p', { class: 'empty' }, 'Aucun passage prévu dans les 90 prochaines minutes.')
  return groupDepartures(departures).map((g) => {
    const route = ctx.net.routesById.get(g.route)
    const [first, ...later] = g.times
    return h(
      'div', { class: 'dep' },
      badge(route),
      h('div', { class: 'row__main' },
        h('span', { class: 'row__title' }, `→ ${g.headsign ?? 'Terminus'}`),
        h('span', { class: 'row__meta' }, clock(first, ctx.net.meta.timezone), ' ', departureTag(first))),
      h('div', { class: 'dep__times' },
        h('span', { class: 'dep__next', 'data-soon': String(first.inSecs < 120) }, etaText(first)),
        later.length ? h('span', { class: 'dep__later' }, later.map((t) => Math.max(0, Math.round(t.inSecs / 60))).join(' · ') + ' min') : null),
    )
  })
}

export function stationDetail(ctx, station, departures, actions) {
  return [
    h('div', { class: 'station__head' },
      h('button', { class: 'back', type: 'button', 'data-key': 'back', 'aria-label': 'Retour', onclick: actions.closeStation }, '←'),
      h('div', {},
        h('h2', { class: 'h' }, station.name),
        h('p', { class: 'sub' }, station.routes.map((r) => ctx.net.routesById.get(r)).map((r) => badge(r, true)), station.pmr ? ' · accessible PMR' : '')),
      ),
    ...[departureRows(ctx, departures)].flat(),
    ctx.userPos ? null : h('p', { class: 'sub' }, 'Touchez « Me localiser » pour voir la distance à pied.'),
  ]
}

export function nearbyList(ctx, items, actions) {
  return h('ul', { class: 'list' }, items.map(({ station, meters, departures }) => {
    const next = groupDepartures(departures, 1).slice(0, 2)
    return h('li', {},
      h('button', { class: 'row', type: 'button', 'data-key': `station:${station.id}`, onclick: () => actions.openStation(station) },
        h('div', { class: 'row__badges' }, station.routes.map((r) => badge(ctx.net.routesById.get(r), true))),
        h('div', { class: 'row__main' },
          h('span', { class: 'row__title' }, station.name),
          h('span', { class: 'row__meta' }, [
            meters === undefined ? null : `${formatDistance(meters)} · ${walkMinutes(meters)} min à pied`,
            ...next.map((g) => `${lineLabel(ctx.net.routesById.get(g.route))} → ${g.headsign ?? 'terminus'}`),
          ].filter(Boolean).join(' · '))),
        next.length ? h('span', { class: 'eta', 'data-soon': String(next[0].times[0].inSecs < 120) }, etaText(next[0].times[0]), h('small', {}, lineLabel(ctx.net.routesById.get(next[0].route)))) : h('span', { class: 'eta' }, '–'),
      ))
  }))
}

export function tramList(ctx, actions) {
  const byRoute = [...ctx.net.routesById.values()].sort((a, b) => ctx.net.byRoute(a.id, b.id))
    .map((route) => ({ route, trams: ctx.trams.filter((t) => t.route === route.id) }))
    .filter((g) => g.trams.length)
  if (byRoute.length === 0) return [h('p', { class: 'empty' }, 'Aucun véhicule en circulation sur les lignes sélectionnées.')]
  return byRoute.map(({ route, trams }) =>
    h('section', {},
      h('h2', { class: 'h', style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } }, badge(route), `${trams.length} véhicule${trams.length > 1 ? 's' : ''}`),
      h('ul', { class: 'list' }, trams.map((t) => {
        const next = t.stopId ?? t.nextStopId
        const nextName = next ? ctx.net.stopsById.get(next)?.name : null
        return h('li', {},
          h('button', { class: 'row', type: 'button', 'data-key': `tram:${t.id}`, onclick: () => actions.focusTram(t.id) },
            badge(route, true),
            h('div', { class: 'row__main' },
              h('span', { class: 'row__title' }, `→ ${t.headsign ?? 'direction inconnue'}`),
              h('span', { class: 'row__meta' }, nextName ? `${t.status === 1 ? 'À' : 'Vers'} ${nextName}` : '')),
            t.delay !== null && t.delay !== undefined && delayLabel(t.delay) ? h('span', { class: 'tag', 'data-kind': delayLabel(t.delay).kind }, delayLabel(t.delay).text) : h('span', {}),
          ))
      }))))
}

export function alertCards(ctx) {
  if (ctx.alerts.length === 0) return [h('p', { class: 'notice' }, 'Aucune perturbation signalée sur le tram.')]
  return [...ctx.alerts].sort((a, b) => Number(a.ended) - Number(b.ended)).map((a) => {
    const route = ctx.net.routesById.get(a.routes[0])
    return h('article', { class: 'alert', 'data-ended': String(a.ended), style: route ? lineVars(route) : {} },
      h('div', { class: 'alert__top' }, a.routes.map((r) => badge(ctx.net.routesById.get(r), true)), a.ended ? 'Fin de perturbation' : a.title),
      h('p', {}, a.text))
  })
}

const MODES = [
  ['auto', 'Automatique', 'Temps réel TaM si disponible, sinon horaires théoriques.'],
  ['snapshot', 'Instantané fourni', 'Positions figées issues des fichiers .pb joints au projet.'],
  ['schedule', 'Horaires théoriques', 'Positions calculées depuis le GTFS, même hors ligne.'],
]

export function sourcePicker(ctx, actions) {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Source des positions' },
    MODES.map(([value, title, desc]) =>
      h('label', {},
        h('input', { type: 'radio', name: 'source', value, checked: ctx.mode === value, onchange: () => actions.setMode(value) }),
        h('span', {}, h('b', {}, title), h('span', { class: 'sub' }, desc)))))
}

export function faresList(ctx) {
  return h('dl', { class: 'fares' }, ctx.net.raw.fares.flatMap((f) => [h('dt', {}, f.name), h('dd', {}, `${f.price.toFixed(2).replace('.', ',')} €`)]))
}

export function installHint() {
  const status = installStatus()
  if (status === 'ios') return h('p', { class: 'notice' }, 'Pour installer : touchez Partager puis « Sur l\'écran d\'accueil ».')
  if (status === 'installed') return h('p', { class: 'notice' }, 'Application installée.')
  return null
}

/** Sélecteur de lignes : tram puis bus, avec recherche et raccourcis « tous / aucun ». */
export function lineChooser(ctx, actions) {
  const q = ctx.lineQuery.trim().toLowerCase()
  const matches = (r) => !q || r.name.toLowerCase().includes(q) || r.long.toLowerCase().includes(q)
  const routes = [...ctx.net.routesById.values()].sort((a, b) => ctx.net.byRoute(a.id, b.id))
  return ['tram', 'bus'].map((mode) => {
    const group = routes.filter((r) => r.mode === mode)
    const shown = group.filter(matches)
    const on = group.filter((r) => ctx.active.has(r.id)).length
    return h('section', { class: 'linegroup' },
      h('div', { class: 'linegroup__head' },
        h('h2', { class: 'h' }, mode === 'tram' ? 'Tramways' : 'Bus', h('span', { class: 'sub' }, ` ${on}/${group.length}`)),
        h('div', { class: 'linegroup__btns' },
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-key': `all:${mode}`, onclick: () => actions.setGroup(mode, true) }, 'Tous'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-key': `none:${mode}`, onclick: () => actions.setGroup(mode, false) }, 'Aucun'))),
      shown.length === 0 ? h('p', { class: 'sub' }, 'Aucune ligne.') : h('ul', { class: 'list' }, shown.map((r) =>
        h('li', {},
          h('button', { class: 'linepick', type: 'button', 'data-key': `line:${r.id}`, 'aria-pressed': String(ctx.active.has(r.id)), onclick: () => actions.toggleRoute(r.id) },
            badge(r), h('span', { class: 'linepick__name' }, r.long), h('span', { class: 'linepick__state', 'aria-hidden': 'true' }))))))
  })
}
