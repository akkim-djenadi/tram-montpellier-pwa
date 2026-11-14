// Heure locale du réseau (Europe/Paris) à partir d'un timestamp, sans dépendance.

const formatters = new Map()

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    )
  }
  return formatters.get(timeZone)
}

/** { date: 20261114, secs: secondes écoulées depuis minuit local } */
export function localParts(ms, timeZone = 'Europe/Paris') {
  const parts = {}
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) parts[p.type] = Number(p.value)
  return {
    date: parts.year * 10000 + parts.month * 100 + parts.day,
    secs: parts.hour * 3600 + parts.minute * 60 + parts.second,
  }
}

/** Date AAAAMMJJ du jour précédent (calcul calendaire, indépendant du fuseau). */
export function previousDate(date) {
  const d = new Date(Date.UTC(Math.floor(date / 10000), Math.floor((date % 10000) / 100) - 1, date % 100))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** Date AAAAMMJJ du jour suivant. */
export function nextDate(date) {
  const d = new Date(Date.UTC(Math.floor(date / 10000), Math.floor((date % 10000) / 100) - 1, date % 100))
  d.setUTCDate(d.getUTCDate() + 1)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

export function formatClock(secs) {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`
}

/** « 3 min », « À quai », « < 1 min » — pour un délai en secondes avant passage. */
export function formatEta(seconds) {
  if (seconds <= -30) return 'Parti'
  if (seconds < 30) return 'À quai'
  const min = Math.round(seconds / 60)
  return min < 1 ? '< 1 min' : `${min} min`
}
