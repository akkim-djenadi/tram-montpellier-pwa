// Construction DOM sans innerHTML : tout texte passe par createTextNode (anti-XSS).

/** h('div', { class: 'x', 'aria-label': 'y', onclick: fn, style: { '--c': '#f00' } }, enfant, …) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'style') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v)
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export const clear = (el) => el.replaceChildren()
