// Fonction serverless Vercel : relaie les flux GTFS-RT de TaM (qui n'envoient pas d'en-tête CORS).
// GET /api/rt/VehiclePosition | TripUpdate | Alert
const RT_BASE = process.env.RT_BASE ?? 'https://gtfsproxy.e-tam.fr/COMMON/'
const FEEDS = new Set(['VehiclePosition', 'TripUpdate', 'Alert'])
const UPSTREAM_TIMEOUT_MS = 6000

export default async function handler(req, res) {
  const feed = String(req.query.feed ?? '')
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end()
  if (!FEEDS.has(feed)) return res.status(404).send('Unknown feed')
  try {
    const upstream = await fetch(new URL(`${feed}.pb`, RT_BASE), { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`)
    res.setHeader('Content-Type', 'application/x-protobuf')
    res.setHeader('X-Feed-Source', 'live')
    // Cache partagé de 10 s côté CDN : aligné sur le cycle d'actualisation client (10 s).
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=5')
    return res.status(200).send(Buffer.from(await upstream.arrayBuffer()))
  } catch (error) {
    console.warn(`[rt] ${feed}: ${error.message}`)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(502).send('Upstream unavailable') // le client bascule sur les horaires théoriques
  }
}
