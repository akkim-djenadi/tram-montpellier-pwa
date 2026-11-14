// Décodeur GTFS-Realtime (protobuf) minimal et sans dépendance.
// Couvre VehiclePosition, TripUpdate et Alert, tels que publiés par TaM.

const decoder = new TextDecoder('utf-8')

function readVarint(buf, pos) {
  let result = 0n
  let shift = 0n
  let i = pos
  for (;;) {
    if (i >= buf.length) throw new RangeError('protobuf tronqué')
    const byte = buf[i]
    i += 1
    result |= BigInt(byte & 0x7f) << shift
    if (byte < 0x80) break
    shift += 7n
  }
  return [result, i]
}

function take(buf, pos, len) {
  if (pos + len > buf.length) throw new RangeError('protobuf tronqué')
  return buf.subarray(pos, pos + len)
}

/** Lit un message en { champ: [valeurs brutes] } (varint → BigInt, len → Uint8Array). */
function readMessage(buf) {
  const fields = new Map()
  let pos = 0
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos)
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    let value
    pos = afterKey
    if (wire === 0) [value, pos] = readVarint(buf, pos)
    else if (wire === 1) { value = take(buf, pos, 8); pos += 8 }
    else if (wire === 2) {
      let len
      ;[len, pos] = readVarint(buf, pos)
      value = take(buf, pos, Number(len))
      pos += Number(len)
    } else if (wire === 5) { value = take(buf, pos, 4); pos += 4 }
    else throw new RangeError(`type de fil protobuf inconnu : ${wire}`)
    if (!fields.has(field)) fields.set(field, [])
    fields.get(field).push(value)
  }
  return fields
}

const first = (m, f) => m.get(f)?.[0]
const all = (m, f) => m.get(f) ?? []
const str = (m, f) => (first(m, f) ? decoder.decode(first(m, f)) : undefined)
const int = (m, f) => (first(m, f) !== undefined ? Number(BigInt.asIntN(64, first(m, f))) : undefined)
const float = (m, f) => {
  const b = first(m, f)
  return b ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true) : undefined
}
const msg = (m, f) => (first(m, f) ? readMessage(first(m, f)) : undefined)

function decodeTrip(m) {
  if (!m) return {}
  return { tripId: str(m, 1), startTime: str(m, 2), startDate: str(m, 3), routeId: str(m, 5), directionId: int(m, 6) }
}

function decodeVehicle(m) {
  const pos = msg(m, 2)
  const veh = msg(m, 8)
  return {
    ...decodeTrip(msg(m, 1)),
    lat: pos && float(pos, 1), lon: pos && float(pos, 2),
    bearing: pos && float(pos, 3), speed: pos && float(pos, 5),
    status: int(m, 4) ?? 2, stopSequence: int(m, 3), stopId: str(m, 7),
    timestamp: int(m, 5), vehicleId: veh && str(veh, 1), label: veh && str(veh, 2),
    occupancy: int(m, 9),
  }
}

function decodeStopEvent(m) {
  if (!m) return undefined
  return { delay: int(m, 1), time: int(m, 2) }
}

function decodeTripUpdate(m) {
  return {
    ...decodeTrip(msg(m, 1)),
    timestamp: int(m, 4), delay: int(m, 5),
    stops: all(m, 2).map(readMessage).map((s) => ({
      sequence: int(s, 1), stopId: str(s, 4),
      arrival: decodeStopEvent(msg(s, 2)), departure: decodeStopEvent(msg(s, 3)),
      relationship: int(s, 5) ?? 0,
    })),
  }
}

function translated(m) {
  if (!m) return undefined
  const translations = all(m, 1).map(readMessage).map((t) => ({ text: str(t, 1), lang: str(t, 2) }))
  return (translations.find((t) => t.lang === 'fr') ?? translations[0])?.text
}

function decodeAlert(m) {
  return {
    periods: all(m, 1).map(readMessage).map((p) => ({ start: int(p, 1), end: int(p, 2) })),
    entities: all(m, 5).map(readMessage).map((e) => ({
      agencyId: str(e, 1), routeId: str(e, 2), routeType: int(e, 3), stopId: str(e, 5),
      tripId: msg(e, 4) ? str(msg(e, 4), 1) : undefined,
    })),
    cause: int(m, 6), effect: int(m, 7), url: translated(msg(m, 8)),
    header: translated(msg(m, 10)), description: translated(msg(m, 11)),
  }
}

/** Décode un flux GTFS-RT complet : { timestamp (s), vehicles, tripUpdates, alerts }. */
export function decodeFeed(bytes) {
  const root = readMessage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const header = msg(root, 1)
  const feed = { timestamp: header ? int(header, 3) : undefined, vehicles: [], tripUpdates: [], alerts: [] }
  for (const raw of all(root, 2)) {
    const entity = readMessage(raw)
    const id = str(entity, 1)
    if (msg(entity, 4)) feed.vehicles.push({ id, ...decodeVehicle(msg(entity, 4)) })
    if (msg(entity, 3)) feed.tripUpdates.push({ id, ...decodeTripUpdate(msg(entity, 3)) })
    if (msg(entity, 5)) feed.alerts.push({ id, ...decodeAlert(msg(entity, 5)) })
  }
  return feed
}
