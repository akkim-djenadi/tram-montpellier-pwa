// Géolocalisation (suivi continu). Nécessite un contexte sécurisé (HTTPS ou localhost).

export function geoErrorMessage(error) {
  if (error?.code === 1) return "Localisation refusée. Autorisez-la dans les réglages du navigateur pour voir les arrêts proches."
  if (error?.code === 3) return 'La localisation met trop de temps à répondre. Réessayez à ciel ouvert.'
  if (error?.code === 2) return 'Position indisponible pour le moment.'
  return "La localisation n'est pas disponible sur cet appareil."
}

/** Démarre le suivi ; renvoie une fonction d'arrêt, ou null si indisponible. */
export function startLocating({ onFix, onError }) {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    onError({ code: 0 })
    return null
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.max(p.coords.accuracy, 5), at: p.timestamp }),
    onError,
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
