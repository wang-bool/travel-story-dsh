// 行程存储服务（移植自原项目 lib/server/travelService.ts + routeCalculation.ts）
// V2 存储：trips.json 带 schemaVersion/requests 幂等日志/initialized 标记/planOwners 租约。
// 启动时自动迁移插件旧版 $DSH_HOME/travel-agent-trips.json（{version:1,trips}）。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyOperations, check, makeTrip, migrateTrip, patchTrip, text, validateTrip, TravelError } from './domain.js'
import { gcj02ToWgs84, wgs84ToGcj02, outOfChina } from './coord.js'
import { resolveCandidate } from './placeSearch.js'

const recoverablePlanErrors = new Set(['VIEW_NOT_CONNECTED', 'VIEW_NOT_READY', 'VIEW_FAILED', 'COMMAND_EXPIRED', 'PRESENTATION_FAILED', 'TASK_INTERRUPTED', 'TASK_FAILED'])
export const isRecoverablePlanError = (code) => recoverablePlanErrors.has(code ?? '')
const empty = () => ({ schemaVersion: 2, trips: [], requests: {}, initialized: false })
function pruneRequests(db) {
  const disposable = Object.keys(db.requests).filter((id) => !db.requests[id].retained)
  for (const id of disposable.slice(0, Math.max(0, disposable.length - 1000))) delete db.requests[id]
}
const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v))

// ── 路线计算（routeCalculation.ts） ─────────────────────────────────────────
function validPoint(p) { return Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 }
function unavailable(transport, warning) { return { route: null, requestedTransport: transport, actualProfile: null, provider: null, geometryKind: 'none', quality: 'unavailable', warnings: [warning] } }
function segDistance(from, to) { const rad = Math.PI / 180; const a = Math.sin((to.latitude - from.latitude) * rad / 2) ** 2 + Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.sin((to.longitude - from.longitude) * rad / 2) ** 2; return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) }
function greatCircle(from, to) {
  const rad = Math.PI / 180
  const vector = (p) => [Math.cos(p.latitude * rad) * Math.cos(p.longitude * rad), Math.cos(p.latitude * rad) * Math.sin(p.longitude * rad), Math.sin(p.latitude * rad)]
  const a = vector(from), b = vector(to)
  const omega = Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, x, i) => sum + x * b[i], 0))))
  if (Math.abs(Math.sin(omega)) < 1e-8) return [[from.longitude, from.latitude], [to.longitude, to.latitude]]
  return Array.from({ length: 65 }, (_, i) => { const t = i / 64; const p = a.map((x, j) => (Math.sin((1 - t) * omega) * x + Math.sin(t * omega) * b[j]) / Math.sin(omega)); return [Math.atan2(p[1], p[0]) / rad, Math.atan2(p[2], Math.hypot(p[0], p[1])) / rad] })
}
function numericMetric(value) { if (!(typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0))) return undefined; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : undefined }
function parsePolyline(polyline) { return polyline.split(';').flatMap((pair) => { const tokens = pair.split(','); if (tokens.length !== 2 || tokens.some((t) => !t.trim())) return []; const [lon, lat] = tokens.map(Number); if (!validPoint({ latitude: lat, longitude: lon })) return []; const p = gcj02ToWgs84(lat, lon); return [[p.lon, p.lat]] }) }
export function createRouteCalculator(getKeys) {
  return async function calculateSegmentRoute(from, to, transport) {
    if (!validPoint(from) || !validPoint(to)) throw Object.assign(new Error('Invalid route coordinates'), { code: 'INVALID_ARGUMENT' })
    if (['plane', 'ufo', 'rocket', 'ship', 'kayak', 'swim'].includes(transport)) {
      const air = ['plane', 'ufo', 'rocket'].includes(transport)
      return { route: { type: 'LineString', coordinates: air ? greatCircle(from, to) : [[from.longitude, from.latitude], [to.longitude, to.latitude]] }, distance: segDistance(from, to), requestedTransport: transport, actualProfile: null, provider: 'geodesic', geometryKind: air ? 'great_circle' : 'straight_line', quality: 'schematic', warnings: ['Illustrative connection only; distance is geodesic, not a navigable route. No schedule or travel-time estimate.'] }
    }
    const profile = transport === 'walk' ? 'walking' : transport === 'bicycle' ? 'cycling' : transport === 'car' ? 'driving' : null
    if (!profile) return unavailable(transport, 'No transport-specific route provider configured; driving estimates will not be substituted.')
    const gaodeKey = (getKeys().gaodeKey || '').trim()
    if (profile !== 'driving' && (outOfChina(from.latitude, from.longitude) || outOfChina(to.latitude, to.longitude))) return unavailable(transport, 'Walking/cycling provider supports domestic China only.')
    if (profile !== 'driving' && !gaodeKey) return unavailable(transport, 'GAODE_KEY is not configured for walking/cycling routes.')
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000)
    try {
      let route, meters, seconds, provider
      if (profile === 'driving') {
        provider = 'osrm'
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`, { signal: controller.signal })
        if (!res.ok) throw new Error('OSRM request failed')
        const json = await res.json()
        if (json.code !== 'Ok' || !json.routes?.length) throw new Error('No route')
        const r = json.routes[0]; route = { type: 'LineString', coordinates: r.geometry?.coordinates }; meters = r.distance; seconds = r.duration
      } else {
        provider = 'gaode'
        const a = wgs84ToGcj02(from.latitude, from.longitude), b = wgs84ToGcj02(to.latitude, to.longitude)
        const url = new URL(profile === 'walking' ? 'https://restapi.amap.com/v3/direction/walking' : 'https://restapi.amap.com/v4/direction/bicycling')
        url.searchParams.set('key', gaodeKey); url.searchParams.set('origin', `${a.lon},${a.lat}`); url.searchParams.set('destination', `${b.lon},${b.lat}`)
        const res = await fetch(url, { signal: controller.signal }); if (!res.ok) throw new Error('Gaode request failed')
        const json = await res.json()
        if (profile === 'walking' ? json.status !== '1' : json.errcode !== 0) throw new Error('Gaode route failed')
        const p = (profile === 'walking' ? json.route?.paths : json.data?.paths)?.[0]; if (!p) throw new Error('No route')
        route = { type: 'LineString', coordinates: (p.steps ?? []).flatMap((s) => (s.polyline ? parsePolyline(s.polyline) : [])) }; meters = numericMetric(p.distance); seconds = numericMetric(p.duration)
      }
      if (!Array.isArray(route.coordinates) || route.coordinates.length < 2 || !route.coordinates.every((p) => Array.isArray(p) && p.length >= 2 && validPoint({ latitude: p[1], longitude: p[0] })) || typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0 || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid route result')
      return { route, distance: meters, duration: seconds, requestedTransport: transport, actualProfile: profile, provider, geometryKind: 'road', quality: 'routed', warnings: [] }
    } catch { return unavailable(transport, 'Route provider failed or returned no valid route; no substituted duration.') }
    finally { clearTimeout(timer) }
  }
}

// ── TravelService ────────────────────────────────────────────────────────────
export class TravelService {
  constructor(directory, calculator, legacyFile) {
    this.directory = path.resolve(directory)
    this.calculator = calculator
    this.legacyFile = legacyFile // 插件旧版单文件存储（travel-agent-trips.json），仅首次迁移用
    this.tail = Promise.resolve()
    this.listeners = new Set()
    this.planOwners = new Map()
  }
  onChange(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  claimPlanTask(taskId, tripId) {
    return this.serial(async () => {
      const db = await this.read(), owner = db.planOwners?.[tripId]
      check(!owner || owner === taskId, 'PLAN_TASK_BUSY', 'Another plan task is editing this trip')
      check(db.trips.some((trip) => trip.id === tripId), 'TRIP_NOT_FOUND', 'Trip not found')
      if (owner !== taskId) { (db.planOwners ??= {})[tripId] = taskId; await this.write(db); this.notify() }
    })
  }
  releasePlanTask(taskId, tripId) {
    return this.serial(async () => {
      const db = await this.read()
      if (tripId && db.planOwners?.[tripId] === taskId) { delete db.planOwners[tripId]; await this.write(db); this.notify() }
    })
  }
  isPlanTaskActive(tripId) { return this.planOwners.has(tripId) }
  notify() { for (const fn of this.listeners) { try { fn() } catch {} } }
  async reconcilePlanOwners(db) {
    let changed = false
    for (const [tripId, taskId] of Object.entries(db.planOwners ?? {})) {
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.directory, 'agent-plans', `${taskId}.json`), 'utf8'))
        // A crash can happen after the terminal journal rename but before lease cleanup.
        if (job.status === 'completed' || (job.status === 'failed' && !isRecoverablePlanError(job.error?.code))) { delete db.planOwners[tripId]; changed = true }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    this.planOwners = new Map(Object.entries(db.planOwners ?? {}))
    return changed
  }
  serial(work) { const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next }
  async read() {
    const file = path.join(this.directory, 'trips.json')
    let raw
    try { raw = await fs.readFile(file, 'utf8') } catch (e) {
      if (e.code !== 'ENOENT') throw e
      // 迁移插件旧版存储（$DSH_HOME/travel-agent-trips.json，{version:1,trips}）
      if (this.legacyFile) {
        try {
          const legacy = JSON.parse(await fs.readFile(this.legacyFile, 'utf8'))
          if (legacy && Array.isArray(legacy.trips)) {
            const db = { schemaVersion: 2, trips: legacy.trips, requests: {}, initialized: legacy.trips.length > 0 }
            for (const trip of db.trips) validateTrip(trip)
            await this.write(db)
            await fs.rename(this.legacyFile, this.legacyFile + '.migrated').catch(() => {})
            this.legacyFile = null
            return db
          }
        } catch {}
        this.legacyFile = null
      }
      return empty()
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
      check(parsed && Array.isArray(parsed.trips), 'STORAGE_CORRUPT', 'Invalid trips database')
    } catch (e) {
      if (e instanceof TravelError) throw e
      throw new TravelError('STORAGE_CORRUPT', 'Cannot parse trips.json; original file has been preserved')
    }
    check(parsed.schemaVersion === undefined || parsed.schemaVersion === 1 || parsed.schemaVersion === 2, 'STORAGE_CORRUPT', 'Unsupported data schema version')
    if (parsed.schemaVersion === 2) {
      try {
        check(parsed.requests && typeof parsed.requests === 'object' && !Array.isArray(parsed.requests) && typeof parsed.initialized === 'boolean', 'STORAGE_CORRUPT', 'Invalid request journal')
        check(parsed.planOwners === undefined || (parsed.planOwners && typeof parsed.planOwners === 'object' && !Array.isArray(parsed.planOwners) && Object.values(parsed.planOwners).every((owner) => typeof owner === 'string' && /^plan_[a-f0-9]{32}$/.test(owner))), 'STORAGE_CORRUPT', 'Invalid plan owners')
        check(new Set(parsed.trips.map((t) => t.id)).size === parsed.trips.length, 'STORAGE_CORRUPT', 'Duplicate trips')
        for (const trip of parsed.trips) validateTrip(trip)
        for (const entry of Object.values(parsed.requests)) check(entry && typeof entry.fingerprint === 'string' && entry.result && typeof entry.result === 'object', 'STORAGE_CORRUPT', 'Invalid journal entry')
      } catch (e) {
        if (e instanceof TravelError && e.code !== 'STORAGE_CORRUPT') throw e
        throw new TravelError('STORAGE_CORRUPT', 'Invalid V2 database; original file has been preserved')
      }
      if (await this.reconcilePlanOwners(parsed)) { await this.write(parsed); this.notify() }
      return parsed
    }
    const migrated = []
    try { for (const original of parsed.trips) migrated.push(migrateTrip(original)) } catch {
      throw new TravelError('STORAGE_CORRUPT', 'Legacy data failed validation; original file has been preserved')
    }
    await fs.mkdir(this.directory, { recursive: true })
    await fs.writeFile(path.join(this.directory, 'trips.v1-backup.json'), raw, { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e })
    const db = { schemaVersion: 2, trips: migrated, requests: {}, initialized: true }
    await this.write(db)
    return db
  }
  async write(db) {
    for (const trip of db.trips) validateTrip(trip)
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, 'trips.json'), tmp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(db))
      await fs.rename(tmp, file)
      this.planOwners = new Map(Object.entries(db.planOwners ?? {}))
    } finally { await fs.unlink(tmp).catch(() => {}) }
  }
  snapshot() { return this.serial(async () => { const db = await this.read(); return { trips: db.trips.map((trip) => ({ ...trip, ...(this.isPlanTaskActive(trip.id) ? { agentTaskActive: true } : {}) })), initialized: db.initialized } }) }
  releaseTaskReceipts(taskId) {
    check(/^plan_[a-f0-9]{32}$/.test(taskId), 'INVALID_INPUT', 'Invalid task ID')
    return this.serial(async () => {
      const db = await this.read(); let changed = false
      for (const [id, record] of Object.entries(db.requests)) if (id.startsWith(`${taskId}:`) && record.retained) { delete record.retained; changed = true }
      if (changed) { pruneRequests(db); await this.write(db) }
    })
  }
  async calculateRoutes(input, source, retainRequest = false) {
    const requestId = text(input.requestId, 'requestId', 200), fingerprint = canonical({ action: 'calculate_routes', input, source })
    const prepared = await this.serial(async () => {
      const db = await this.read(), existing = Object.hasOwn(db.requests, requestId) ? db.requests[requestId] : undefined
      check(source !== 'web' || retainRequest || !db.planOwners?.[input.tripId], 'PLAN_TASK_ACTIVE', 'Plan task owns route calculation')
      if (existing) {
        check(existing.fingerprint === fingerprint, 'REQUEST_ID_REUSED', 'requestId reused')
        return { existing: structuredClone(existing.result) }
      }
      const trip = db.trips.find((t) => t.id === input.tripId)
      check(trip, 'TRIP_NOT_FOUND', 'Trip not found')
      check(input.expectedRevision === trip.revision, 'REVISION_CONFLICT', 'Reload trip before calculating routes')
      check(input.segmentIds === undefined || (Array.isArray(input.segmentIds) && input.segmentIds.length > 0 && input.segmentIds.length <= 100 && input.segmentIds.every((id) => trip.segments.some((s) => s.id === id))), 'INVALID_INPUT', 'Invalid segmentIds')
      const segments = trip.segments.filter((s) => !input.segmentIds || input.segmentIds.includes(s.id))
      check(segments.length <= 100, 'INVALID_INPUT', 'Calculate at most 100 segments per request')
      return { trip: structuredClone(trip), segments: structuredClone(segments) }
    })
    if (prepared.existing) return prepared.existing
    const trip = prepared.trip, segments = prepared.segments
    const calculated = []
    for (let i = 0; i < segments.length; i += 4) {
      calculated.push(...await Promise.all(segments.slice(i, i + 4).map(async (segment) => ({ segment, result: await this.calculator(trip.stops.find((s) => s.id === segment.fromStopId), trip.stops.find((s) => s.id === segment.toStopId), segment.transport) }))))
    }
    return this.serial(async () => {
      const db = await this.read(), existing = Object.hasOwn(db.requests, requestId) ? db.requests[requestId] : undefined
      check(source !== 'web' || retainRequest || !db.planOwners?.[input.tripId], 'PLAN_TASK_ACTIVE', 'Plan task owns route calculation')
      if (existing) {
        check(existing.fingerprint === fingerprint, 'REQUEST_ID_REUSED', 'requestId reused')
        return structuredClone(existing.result)
      }
      const current = db.trips.find((t) => t.id === input.tripId)
      check(current && current.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Trip changed while routes were calculating; reload and retry')
      for (const { segment, result } of calculated) {
        const target = current.segments.find((s) => s.id === segment.id)
        target.route = result.route
        target.distance = result.distance
        target.duration = result.duration
        const { route: _g, distance: _d, duration: _t, ...info } = result
        target.routeInfo = info
      }
      if (calculated.length) current.revision = (current.revision ?? 0) + 1
      const result = { tripId: current.id, revision: current.revision, routes: calculated.map(({ segment, result }) => { const { route: _g, ...summary } = result; return { segmentId: segment.id, ...summary } }) }
      db.initialized = true
      if (retainRequest) {
        const taskId = requestId.match(/^(plan_[a-f0-9]{32}):/)?.[1]
        check(taskId, 'INVALID_INPUT', 'Retained requests require a plan task ID')
        const owner = db.planOwners?.[input.tripId]
        check(!owner || owner === taskId, 'PLAN_TASK_BUSY', 'Another plan task is editing this trip')
        ;(db.planOwners ??= {})[input.tripId] = taskId
      } else if (db.planOwners) { delete db.planOwners[input.tripId] }
      Object.defineProperty(db.requests, requestId, { value: { fingerprint, result, ...(retainRequest ? { retained: true } : {}) }, writable: true, enumerable: true, configurable: true })
      pruneRequests(db)
      await this.write(db)
      this.notify()
      return result
    })
  }
  execute(action, input = {}, source = 'agent', options = {}) {
    if (action === 'calculate_routes') return this.calculateRoutes(input, source, options.retainRequest === true)
    return this.serial(async () => {
      const db = await this.read()
      if (action === 'list_trips') {
        const limit = input.limit === undefined ? 20 : input.limit
        check(Number.isInteger(limit) && limit > 0 && limit <= 100, 'INVALID_INPUT', 'limit must be 1-100')
        const cursor = input.cursor === undefined ? 0 : Number(input.cursor)
        check(Number.isInteger(cursor) && cursor >= 0, 'INVALID_INPUT', 'Invalid cursor')
        const q = typeof input.query === 'string' ? input.query.toLowerCase() : ''
        const items = db.trips.filter((t) => `${t.name} ${t.region ?? ''}`.toLowerCase().includes(q))
        return { trips: items.slice(cursor, cursor + limit).map((t) => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate, region: t.region, days: t.days.length, stops: t.stops.length, revision: t.revision })), nextCursor: cursor + limit < items.length ? String(cursor + limit) : null }
      }
      if (action === 'get_trip') {
        const t = db.trips.find((t) => t.id === input.tripId)
        check(t, 'TRIP_NOT_FOUND', 'Trip not found')
        return { trip: structuredClone(t), tripId: t.id, revision: t.revision }
      }
      check(['create_trip', 'update_trip', 'delete_trip', 'edit_itinerary', 'import_legacy'].includes(action), 'INVALID_INPUT', 'Unknown action')
      const requestId = text(input.requestId, 'requestId', 200), fingerprint = canonical({ action, input, source })
      if (Object.hasOwn(db.requests, requestId)) {
        check(db.requests[requestId].fingerprint === fingerprint, 'REQUEST_ID_REUSED', 'Use a new requestId for different arguments')
        return structuredClone(db.requests[requestId].result)
      }
      let result
      if (action === 'create_trip') {
        const trip = makeTrip(input)
        db.trips.unshift(trip)
        result = { tripId: trip.id, revision: trip.revision, trip }
      } else if (action === 'import_legacy') {
        check(source === 'web' && !db.initialized && db.trips.length === 0, 'IMPORT_CONFLICT', 'Import is only allowed into an uninitialized empty store')
        check(Array.isArray(input.trips) && input.trips.length <= 100, 'INVALID_INPUT', 'Invalid legacy import')
        const migrated = []
        for (const old of input.trips) migrated.push(migrateTrip(old))
        check(new Set(migrated.map((t) => t.id)).size === migrated.length, 'INVALID_INPUT', 'Duplicate trip IDs')
        db.trips = migrated
        result = { imported: migrated.length }
      } else {
        const trip = db.trips.find((t) => t.id === input.tripId)
        check(trip, 'TRIP_NOT_FOUND', 'Trip not found')
        check(Number.isInteger(input.expectedRevision) && input.expectedRevision === trip.revision, 'REVISION_CONFLICT', `Trip changed; reload before editing (current revision ${trip.revision})`)
        if (action === 'delete_trip') {
          db.trips = db.trips.filter((t) => t.id !== trip.id)
          result = { tripId: trip.id, deleted: true, revision: trip.revision }
        } else {
          let extra = {}
          if (action === 'update_trip') patchTrip(trip, input.patch)
          else {
            const ops = structuredClone(input.operations)
            check(Array.isArray(ops), 'INVALID_INPUT', 'operations must be an array')
            for (const op of ops) {
              check(op && typeof op === 'object', 'INVALID_INPUT', 'Invalid operation')
              if (source === 'agent') {
                check(!op.place, 'INVALID_INPUT', 'Use a search candidateId')
                check(!['add_media', 'remove_media', 'set_route'].includes(op.op), 'INVALID_INPUT', 'Internal web operation')
              }
              if (op.candidateId) {
                check(['add_stop', 'update_stop'].includes(op.op), 'INVALID_INPUT', 'Unexpected candidateId')
                op.place = await resolveCandidate(op.candidateId)
              }
            }
            // Raw agent places and internal operations were rejected before resolving trusted candidates.
            extra = applyOperations(trip, ops, true)
          }
          trip.revision = (trip.revision ?? 0) + 1
          result = { tripId: trip.id, revision: trip.revision, trip, ...extra }
        }
      }
      db.initialized = true
      if (options.retainRequest) {
        const taskId = requestId.match(/^(plan_[a-f0-9]{32}):/)?.[1]
        check(taskId, 'INVALID_INPUT', 'Retained requests require a plan task ID')
        const owner = db.planOwners?.[result.tripId]
        check(!owner || owner === taskId, 'PLAN_TASK_BUSY', 'Another plan task is editing this trip')
        ;(db.planOwners ??= {})[result.tripId] = taskId
      } else if (input.tripId && db.planOwners) {
        // A deliberate successful edit supersedes the suspended plan's revision.
        delete db.planOwners[input.tripId]
      }
      Object.defineProperty(db.requests, requestId, { value: { fingerprint, result: structuredClone(result), ...(options.retainRequest ? { retained: true } : {}) }, writable: true, enumerable: true, configurable: true })
      pruneRequests(db)
      await this.write(db)
      this.notify()
      return structuredClone(result)
    })
  }
}
