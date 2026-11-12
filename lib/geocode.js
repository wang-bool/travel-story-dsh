// 地点搜索（移植自原项目 lib/geocode.ts，服务端详细版 + 逆地理）
// 双源：高德（国内主力，GCJ-02 → WGS-84）+ LocationIQ（全球，OSM 数据）。
// key 由宿主插件配置提供（getKeys 注入），前端不接触 key。
import { gcj02ToWgs84 } from './coord.js'

const GAODE_ENDPOINT = 'https://restapi.amap.com/v3/place/text'
// 实测：eu1 从国内访问最快（~1s），us1 通但慢，ap1 连不上。eu1 优先、us1 兜底。
const LOCATIONIQ_ENDPOINTS = ['https://eu1.locationiq.com/v1/search', 'https://us1.locationiq.com/v1/search']

const CACHE_TTL = 10 * 60 * 1000
const CACHE_MAX = 200
const detailedCache = new Map()

export function createGeocode(getKeys) {
  function hasSearchKeys() { const cfg = getKeys(); return Boolean(cfg.gaodeKey || cfg.locationiqKey) }

  async function searchPlaces(query, signal) { return (await searchPlacesDetailed({ query }, signal)).candidates }

  async function searchPlacesDetailed(input, signal, timing = {}) {
    signal?.throwIfAborted?.()
    const budget = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timing.totalTimeoutMs ?? 10000)])
    const q = input.query?.trim()
    if (!q || q.length > 500 || (input.countryCode && !/^[a-z]{2}$/i.test(input.countryCode)) ||
        (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)) ||
        (input.near && (!Number.isFinite(input.near.latitude) || Math.abs(input.near.latitude) > 90 || !Number.isFinite(input.near.longitude) || Math.abs(input.near.longitude) > 180))) {
      throw Object.assign(new Error('Invalid place search input'), { code: 'INVALID_ARGUMENT' })
    }
    const options = { ...input, query: q, countryCode: input.countryCode?.toLowerCase(), limit: input.limit ?? 8 }
    const cfg = getKeys()
    // 缓存键包含全部上下文与配置标识，早前配置失败的结果不会被缓存成成功。
    const key = JSON.stringify([options, cfg])
    const hit = detailedCache.get(key)
    if (hit && Date.now() - hit.t < CACHE_TTL) return { ...structuredClone(hit.result), cached: true }
    const providerStatus = []
    const lists = []
    await Promise.all(['gaode', 'locationiq'].map(async (provider) => {
      const apiKey = provider === 'gaode' ? cfg.gaodeKey : cfg.locationiqKey
      if (!apiKey) { providerStatus.push({ provider, status: 'not_configured' }); return }
      if (provider === 'gaode' && options.countryCode && options.countryCode !== 'cn') { providerStatus.push({ provider, status: 'not_applicable' }); return }
      try {
        lists.push(await (provider === 'gaode' ? gaodeSearch(q, apiKey, budget, options, timing.attemptTimeoutMs) : locationiqSearch(q, apiKey, budget, options, timing.attemptTimeoutMs)))
        providerStatus.push({ provider, status: 'ok' })
      } catch {
        // Provider errors can contain credential-bearing URLs; never return raw fetch error messages.
        providerStatus.push({ provider, status: 'failed', message: 'Search provider unavailable' })
      }
    }))
    signal?.throwIfAborted?.()
    const ok = providerStatus.filter((p) => p.status === 'ok').length
    const failed = providerStatus.some((p) => p.status === 'failed')
    const result = {
      cached: false,
      query: q, searchContext: options,
      candidates: mergeResults(q, lists).slice(0, options.limit),
      providerStatus,
      status: ok ? (failed ? 'partial' : 'ok') : failed ? 'failed' : 'not_configured',
      expiresAt: new Date(Date.now() + CACHE_TTL).toISOString(),
    }
    if (ok && !failed) {
      if (detailedCache.size >= CACHE_MAX) detailedCache.delete(detailedCache.keys().next().value)
      detailedCache.set(key, { t: Date.now(), result })
    }
    return structuredClone(result)
  }

  async function reverseGeocode(lat, lng, signal) {
    const cfg = getKeys()
    if (cfg.locationiqKey) {
      try { const r = await withTimeout(liqReverse(lat, lng, cfg.locationiqKey, signal), 5000); if (r) return r } catch { /* 掉高德兜底 */ }
    }
    if (cfg.gaodeKey) {
      try { const r = await withTimeout(gaodeReverse(lat, lng, cfg.gaodeKey, signal), 5000); if (r) return r } catch { /* 无结果 */ }
    }
    return null
  }

  return { hasSearchKeys, searchPlaces, searchPlacesDetailed, reverseGeocode, keys: getKeys }
}

/** A deadline aborts the actual request, including body consumption, before regional fallback. */
async function fetchJson(url, signal, timeoutMs = 4000) {
  signal?.throwIfAborted?.()
  const controller = new AbortController()
  let rejectDeadline = () => {}
  const deadline = new Promise((_, reject) => { rejectDeadline = reject })
  const abort = () => { controller.abort(signal?.reason); rejectDeadline(signal?.reason ?? new Error('Aborted')) }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('Search attempt timed out')); rejectDeadline(new Error('Search attempt timed out')) }, timeoutMs)
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url, { signal: controller.signal })
      return { status: response.status, ok: response.ok, data: response.ok ? await response.json() : undefined }
    })(), deadline])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
function validNumericToken(v) { return (typeof v === 'number' || (typeof v === 'string' && v.trim().length > 0)) && Number.isFinite(Number(v)) }
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// ── 合并 / 去重 / 多信号排序 ─────────────────────────────────────────────────
const PROVIDER_BASE = { gaode: -5, locationiq: 0 }
const LANDMARK_TYPES = new Set(['tower', 'skyscraper', 'skyline', 'museum', 'beach', 'mountain', 'temple', 'bridge', 'lake', 'river', 'sea', 'scenic', 'attraction'])
function score(r, q) {
  let w = PROVIDER_BASE[r.source]
  const n = r.name.toLowerCase(), qq = q.toLowerCase()
  if (r.type === 'city') {
    if (n === qq) w -= 40
    else if (n.startsWith(qq)) w -= 25
    else if (n.includes(qq)) w -= 15
    if (r.importance != null) w -= r.importance * 120
    if (r.isLandmark) w -= 60
    w -= 10
    return w
  }
  if (n === qq) w -= 110
  else if (n.startsWith(qq)) w -= 60
  else if (n.includes(qq)) w -= 25
  if (r.importance != null) w -= r.importance * 45
  if (r.isLandmark) w -= 45
  if (LANDMARK_TYPES.has(r.type)) w -= 6
  else if (r.type === 'restaurant' || r.type === 'hotel' || r.type === 'other') w += 8
  return w
}
function mergeResults(q, lists) {
  let order = 0
  const candidates = []
  for (const list of lists) for (const r of list) candidates.push({ ...r, order: order++ })
  const scored = candidates.map((c) => ({ c, w: score(c, q) })).sort((a, b) => a.w - b.w || (a.c.order ?? 0) - (b.c.order ?? 0))
  const out = []
  for (const { c } of scored) {
    if (out.some((x) => nearSameName(x, c))) continue
    const { source, importance, isLandmark, order: _o, ...result } = c
    out.push(result)
  }
  return out
}
function nearSameName(a, b) {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false
  const dLat = (a.latitude - b.latitude) * 111320
  const dLon = (a.longitude - b.longitude) * 111320 * Math.cos((a.latitude * Math.PI) / 180)
  return Math.hypot(dLat, dLon) < 800
}

// ── 高德（place/text） ──────────────────────────────────────────────────────
const str = (v) => (typeof v === 'string' && v ? v : undefined)
async function gaodeSearch(q, key, signal, options, timeoutMs) {
  const url = new URL(GAODE_ENDPOINT)
  url.searchParams.set('key', key)
  url.searchParams.set('keywords', q)
  if (options?.city) { url.searchParams.set('city', options.city); url.searchParams.set('citylimit', 'true') }
  url.searchParams.set('output', 'json')
  url.searchParams.set('offset', '10')
  const res = await fetchJson(url.toString(), signal, timeoutMs)
  if (!res.ok) throw new Error(`gaode ${res.status}`)
  const data = res.data
  if (data.status !== '1') throw new Error(`gaode ${data.info ?? 'error'}`)
  return (data.pois ?? [])
    .filter((p) => {
      if (!p.name || !str(p.location)?.includes(',')) return false
      const tokens = str(p.location).split(',')
      const coords = tokens.map(Number)
      return tokens.every(validNumericToken) && coords.length === 2 && coords.every(Number.isFinite) && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90
    })
    .map((p) => {
      const [lng, lat] = str(p.location).split(',').map(Number)
      const wgs = gcj02ToWgs84(lat, lng)
      const city = str(p.cityname)
      return {
        id: `gd_${p.id ?? `${p.name}_${lat.toFixed(4)}_${lng.toFixed(4)}`}`,
        name: p.name,
        displayName: [p.name, str(p.address), str(p.adname), city, str(p.pname)].filter(Boolean).join('，'),
        latitude: wgs.lat,
        longitude: wgs.lon,
        type: gaodeToStopType(str(p.type) ?? ''),
        city,
        country: undefined,
        source: 'gaode', provider: 'gaode', providerPlaceId: p.id ?? '',
        coordinateSystem: 'WGS84', category: str(p.type), countryCode: undefined,
      }
    })
}
function gaodeToStopType(t) {
  if (t.includes('机场')) return 'airport'
  if (t.includes('火车站') || t.includes('地铁') || t.includes('港口')) return 'station'
  if (t.includes('博物馆') || t.includes('展览馆')) return 'museum'
  if (t.includes('动物园')) return 'zoo'
  if (t.includes('公园')) return 'park'
  if (t.includes('海滩') || t.includes('海滨')) return 'beach'
  if (t.includes('湖泊') || t.includes('水库')) return 'lake'
  if (t.includes('寺庙') || t.includes('教堂') || t.includes('道观')) return 'temple'
  if (t.includes('桥')) return 'bridge'
  if (t.includes('宾馆') || t.includes('酒店') || t.includes('住宿')) return 'hotel'
  if (t.includes('餐饮') || t.includes('餐厅') || t.includes('美食')) return 'restaurant'
  if (t.includes('风景名胜') || t.includes('自然')) return 'scenic'
  if (t.includes('塔') || t.includes('观光')) return 'tower'
  return 'attraction'
}

// ── LocationIQ（Nominatim 托管版） ───────────────────────────────────────────
function zhName(h) {
  const nd = h.namedetails ?? {}
  const zhHans = nd['name:zh-Hans']?.trim()
  if (zhHans) return zhHans.split(/[;；/]/)[0].trim()
  const zh = nd['name:zh'] ?? h.name
  if (zh) return zh.split(/[;；/]/)[0].trim()
  return h.display_name.split(',')[0].trim()
}
async function locationiqSearch(q, key, signal, options, timeoutMs) {
  let lastErr
  for (const endpoint of LOCATIONIQ_ENDPOINTS) {
    try {
      const url = new URL(endpoint)
      url.searchParams.set('key', key)
      url.searchParams.set('q', options?.city ? `${q}, ${options.city}` : q)
      url.searchParams.set('format', 'json')
      url.searchParams.set('limit', String(options?.limit ?? 8))
      url.searchParams.set('addressdetails', '1')
      if (options?.countryCode) url.searchParams.set('countrycodes', options.countryCode)
      if (options?.near) { const { latitude: lat, longitude: lon } = options.near; url.searchParams.set('viewbox', `${Math.max(-180, lon - 0.5)},${Math.min(90, lat + 0.5)},${Math.min(180, lon + 0.5)},${Math.max(-90, lat - 0.5)}`); url.searchParams.set('bounded', '0') }
      url.searchParams.set('extratags', '1')
      url.searchParams.set('namedetails', '1')
      url.searchParams.set('accept-language', options?.language ?? 'zh-CN,en')
      const res = await fetchJson(url.toString(), signal, timeoutMs)
      if (res.status === 404) return []
      if (!res.ok) throw new Error(`locationiq ${res.status}`)
      const hits = res.data
      if (!Array.isArray(hits)) throw new Error('locationiq error')
      return hits
        .filter((h) => validNumericToken(h.lat) && validNumericToken(h.lon) && Math.abs(Number(h.lat)) <= 90 && Math.abs(Number(h.lon)) <= 180)
        .map((h) => ({
          id: `liq_${h.place_id}`,
          name: options?.language && !options.language.startsWith('zh') ? (h.name || h.display_name.split(',')[0]) : zhName(h),
          displayName: h.display_name,
          latitude: Number(h.lat),
          longitude: Number(h.lon),
          type: osmToStopType(h),
          city: h.address?.city || h.address?.town || h.address?.village,
          country: h.address?.country,
          importance: h.importance,
          isLandmark: Boolean(h.extratags?.wikipedia || h.extratags?.wikidata || h.extratags?.historic),
          source: 'locationiq', provider: 'locationiq', providerPlaceId: String(h.place_id),
          coordinateSystem: 'WGS84', countryCode: h.address?.country_code?.toUpperCase(),
          aliases: h.namedetails, category: [h.class, h.type].filter(Boolean).join(':'),
        }))
    } catch (e) {
      signal?.throwIfAborted?.()
      lastErr = e
    }
  }
  throw lastErr ?? new Error('locationiq unreachable')
}
function osmToStopType(h) {
  const cls = h.class ?? '', type = h.type ?? ''
  if (h.name?.includes('动物园')) return 'zoo'
  if (cls === 'tourism') {
    if (type === 'hotel' || type === 'hostel') return 'hotel'
    if (type === 'museum' || type === 'gallery') return 'museum'
    if (type === 'zoo') return 'zoo'
    if (type === 'aquarium') return 'sea'
    return 'attraction'
  }
  if (cls === 'historic') return 'attraction'
  if (cls === 'leisure' && type === 'park') return 'park'
  if (cls === 'leisure' && type === 'garden') return 'garden'
  if (cls === 'aeroway') return 'airport'
  if (cls === 'railway' && (type === 'station' || type === 'halt')) return 'station'
  if (cls === 'natural' && (type === 'water' || type === 'lake')) return 'lake'
  if (cls === 'natural' && (type === 'wood' || type === 'forest')) return 'forest'
  if (cls === 'natural' && (type === 'beach' || type === 'sand')) return 'beach'
  if (cls === 'natural' && (type === 'bay' || type === 'sea' || type === 'coastline')) return 'sea'
  if (cls === 'natural' && (type === 'peak' || type === 'volcano')) return 'mountain'
  if (cls === 'waterway') return 'river'
  if (cls === 'man_made' && (type === 'tower' || type === 'lighthouse')) return 'tower'
  if (cls === 'man_made' && type === 'bridge') return 'bridge'
  if (cls === 'amenity' && type === 'place_of_worship') return 'temple'
  if (cls === 'amenity' && (type === 'restaurant' || type === 'cafe' || type === 'bar')) return 'restaurant'
  if (cls === 'boundary' || cls === 'administrative' || cls === 'place') return 'city'
  if (cls === 'building') return 'attraction'
  return 'other'
}

// ── 逆地理（坐标 → 城市/国家）：足迹统计回填用 ──────────────────────────────
async function liqReverse(lat, lng, key, signal) {
  let lastErr
  for (const endpoint of LOCATIONIQ_ENDPOINTS) {
    try {
      const url = new URL(endpoint.replace(/\/search$/, '/reverse'))
      url.searchParams.set('key', key)
      url.searchParams.set('lat', String(lat))
      url.searchParams.set('lon', String(lng))
      url.searchParams.set('format', 'json')
      url.searchParams.set('accept-language', 'zh-CN,en')
      const res = await fetch(url.toString(), { signal })
      if (!res.ok) throw new Error(`locationiq reverse ${res.status}`)
      const data = await res.json()
      const a = data.address
      if (!a) return null
      // 城市粒度按统计口径取：直辖市的「市」在 state，不能落到街道级
      const city = a.city || a.town || a.state || a.village || a.county
      const clean = (v) => v?.split(/[;；]/)[0].trim() || undefined
      if (!city && !a.country) return null
      return { city: clean(city), country: clean(a.country) }
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('locationiq reverse unreachable')
}
async function gaodeReverse(lat, lng, key, signal) {
  const url = new URL('https://restapi.amap.com/v3/geocode/regeo')
  url.searchParams.set('key', key)
  url.searchParams.set('location', `${lng},${lat}`)
  url.searchParams.set('output', 'json')
  url.searchParams.set('extensions', 'base')
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`gaode regeo ${res.status}`)
  const data = await res.json()
  if (data.status !== '1') throw new Error('gaode regeo error')
  const ac = data.regeocode?.addressComponent
  if (!ac) return null
  const province = str(ac.province)
  const city = str(ac.city) ?? province ?? str(ac.district)
  if (!city && !province) return null
  return { city, country: '中国' }
}
