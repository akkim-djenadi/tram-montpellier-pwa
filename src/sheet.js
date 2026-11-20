// Panneau coulissant : onglets accessibles + 3 hauteurs (peek / half / full) avec glisser.
const ORDER = ['peek', 'half', 'full']
const DRAG_THRESHOLD_PX = 56
const TAP_SLOP_PX = 6

export function createSheet({ root, handle, tabs, panels, onTab }) {
  const isDesktop = () => window.matchMedia('(min-width: 900px)').matches
  let snap = 'peek'

  function setSnap(next) {
    snap = next
    root.dataset.snap = next
    handle.setAttribute('aria-expanded', String(next !== 'peek'))
  }

  function setTab(name, { open = true } = {}) {
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== name
    }
    if (open && snap === 'peek' && !isDesktop()) setSnap('half')
    onTab?.(name)
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab))
    tab.addEventListener('keydown', (e) => {
      const delta = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
      if (!delta) return
      const next = tabs[(i + delta + tabs.length) % tabs.length]
      next.focus()
      setTab(next.dataset.tab)
    })
  })

  // Glisser la poignée : suit le doigt, puis se cale sur la hauteur la plus proche.
  let startY = null
  let moved = false
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY
    moved = false
    handle.setPointerCapture(e.pointerId)
    root.dataset.dragging = 'true'
  })
  handle.addEventListener('pointermove', (e) => {
    if (startY === null) return
    const dy = e.clientY - startY
    if (Math.abs(dy) > TAP_SLOP_PX) moved = true
    root.style.setProperty('--drag', `${dy}px`)
  })
  const endDrag = (e) => {
    if (startY === null) return
    const dy = e.clientY - startY
    startY = null
    root.dataset.dragging = 'false'
    root.style.removeProperty('--drag')
    const index = ORDER.indexOf(snap)
    if (!moved) setSnap(ORDER[(index + 1) % ORDER.length])
    else if (dy < -DRAG_THRESHOLD_PX) setSnap(ORDER[Math.min(index + 1, 2)])
    else if (dy > DRAG_THRESHOLD_PX) setSnap(ORDER[Math.max(index - 1, 0)])
  }
  handle.addEventListener('pointerup', endDrag)
  handle.addEventListener('pointercancel', endDrag)
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') setSnap(ORDER[Math.min(ORDER.indexOf(snap) + 1, 2)])
    if (e.key === 'ArrowDown') setSnap(ORDER[Math.max(ORDER.indexOf(snap) - 1, 0)])
  })

  setSnap('peek')
  return { setSnap, setTab, getSnap: () => snap }
}
