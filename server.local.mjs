// Serveur de développement / auto-hébergement : fichiers statiques + proxy GTFS-RT.
// Usage : node server.mjs   (PORT=8080, RT_BASE=https://…/ pour changer la source)
// Le proxy évite les blocages CORS ; si la source officielle ne répond pas, il sert
// l'instantané fourni dans fixtures/ en le signalant par l'en-tête X-Feed-Source.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8080)
const RT_BASE = process.env.RT_BASE ?? 'https://gtfsproxy.e-tam.fr/COMMON/'
const UPSTREAM_TIMEOUT_MS = 6000
const FEEDS = new Set(['VehiclePosition', 'TripUpdate', 'Alert'])
const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'config.js', 'src', 'styles', 'data', 'vendor', 'fonts', 'icons', 'fixtures']

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'",
    "img-src 'self' data: https://tile.openstreetmap.org", "font-src 'self'",
    "connect-src 'self' https://gtfsproxy.e-tam.fr", "worker-src 'self'", "manifest-src 'self'",
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

async function proxyFeed(feed, res) {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/x-protobuf' }
  try {
    const upstream = await fetch(new URL(`${feed}.pb`, RT_BASE), { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`)
    const bytes = Buffer.from(await upstream.arrayBuffer())
    return send(res, 200, bytes, { ...headers, 'X-Feed-Source': 'live' })
  } catch (error) {
    console.warn(`[rt] ${feed}: source officielle indisponible (${error.message}) → instantané`)
    const snapshot = await readFile(join(ROOT, 'fixtures', `${feed}.pb`))
    return send(res, 200, snapshot, { ...headers, 'X-Feed-Source': 'snapshot' })
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html'
  const top = rel.split(sep)[0]
  if (rel.includes('..') || !PUBLIC.includes(top)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  const file = join(ROOT, rel)
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    const immutable = ['fonts', 'vendor', 'icons'].includes(top)
    const cache = immutable ? 'public, max-age=86400' : 'no-cache'
    return send(res, 200, await readFile(file), { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache })
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  const match = pathname.match(/^\/api\/rt\/([A-Za-z]+)$/)
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed')
  if (match) return FEEDS.has(match[1]) ? proxyFeed(match[1], res) : send(res, 404, 'Unknown feed')
  return serveStatic(pathname, res)
}).listen(PORT, () => console.log(`Tram PWA → http://localhost:${PORT}  (flux : ${RT_BASE})`))
