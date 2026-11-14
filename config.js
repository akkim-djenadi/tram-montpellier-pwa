// Configuration de l'application. Modifiez rtEndpoints pour pointer vers votre propre source.
// Chaque gabarit est essayé dans l'ordre ; {feed} = VehiclePosition | TripUpdate | Alert.
export const config = {
  rtEndpoints: [
    '/api/rt/{feed}', // proxy de server.mjs (évite le CORS, repli sur l'instantané fourni)
    'https://gtfsproxy.e-tam.fr/COMMON/{feed}.pb', // source officielle TaM (échoue dans un navigateur : pas d'en-tête CORS)
  ],
  snapshotEndpoint: '/fixtures/{feed}.pb',
  pollMs: 10_000,
  center: [43.6108, 3.8767],
  zoom: 13,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  // Fond de secours (données OpenStreetMap, rendu CARTO) si le serveur OSM est injoignable.
  tileFallback: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a> © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  },
}
