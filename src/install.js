// Installation de la PWA : bouton natif (Chrome/Edge/Android) ou consigne (iOS Safari).

let deferred = null

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream

export function setupInstall(button, onChange) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event
    button.hidden = isStandalone()
    onChange?.()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    button.hidden = true
    onChange?.()
  })
  button.addEventListener('click', async () => {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice
    deferred = null
    button.hidden = true
    onChange?.()
  })
}

/** 'installed' | 'prompt' | 'ios' | 'none' */
export const installStatus = () => (isStandalone() ? 'installed' : deferred ? 'prompt' : isIos() ? 'ios' : 'none')
