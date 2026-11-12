// travel-agent 全局插件（Host 端）—— 自包含的 Travel Story 服务端 + Agent 桥
//
// 为打包进 DSH 客户端的 Travel Story 前端提供：
//   GET  /travel-agent/trips            行程快照（{trips, initialized}）
//   POST /travel-agent/travel           行程动作（create/update/delete/edit_itinerary/import_legacy）
//   POST /travel-agent/routes           路线计算（calculate_routes）
//   GET  /travel-agent/geocode          地点搜索（?q=）与逆地理（?lat=&lng=）
//   GET  /travel-agent/route            步行/骑行路线代理（高德）
//   POST /travel-agent/views            Agent 桥：心跳 / 命令回执 / 注销
//   GET  /travel-agent/agent-events     Agent 活动流（SSE，按 viewId）
//   GET  /travel-agent/events           行程变更推送（SSE，跨视图同步）
//   GET  /travel-agent/tiles/*          矢量瓦片/字体代理（磁盘缓存 → 回源）
//   GET  /travel-agent/maplibre/*       MapLibre worker 静态文件
//   *    /travel-agent/media|recordings 素材与录像
// 并向 DSH 注册 18 个旅行工具（原 MCP 工具集：create_trip … apply_plan，另有 get_weather 天气预报）。
// 数据持久化到 $DSH_HOME/travel-agent-data/（旧版 travel-agent-trips.json 自动迁移）；
// 搜索密钥读自 $DSH_HOME/travel-agent.config.json（其次环境变量、插件自带配置）。
// 全部 HTTP 接口只响应回环地址。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from './server.js'
import { wgs84ToGcj02, gcj02ToWgs84 } from './coord.js'
import { createGeocode } from './geocode.js'
import { createWeather } from './weather.js'
import { createPlaceSearch, resolveCandidate, markCandidateAdopted, getAgentActivityStore, validActivityViewId } from './placeSearch.js'
import { TravelService, createRouteCalculator } from './service.js'
import { createViewRegistry, createToolDispatcher, registerAgentTools, ViewError } from './agent.js'
import { TravelError } from './domain.js'

const name = 'travel-agent'
const inject = ['webServer', 'tools']

const DSH_HOME = process.env.DSH_HOME || os.homedir() + '/.dsh'
const CONFIG_PATH = DSH_HOME + '/travel-agent.config.json'
const LEGACY_TRIPS_PATH = DSH_HOME + '/travel-agent-trips.json'
const PLUGIN_CONFIG_PATH = (() => { try { return fileURLToPath(new URL('../config/travel-agent.config.json', import.meta.url)) } catch (e) { return '' } })()

function readJson(p) { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : null } catch (e) { return null } }
function getConfig() {
  const env = { gaodeKey: (process.env.GAODE_KEY || '').trim(), locationiqKey: (process.env.LOCATIONIQ_KEY || '').trim() }
  const home = readJson(CONFIG_PATH) || {}
  const plugin = readJson(PLUGIN_CONFIG_PATH) || {}
  return { gaodeKey: env.gaodeKey || home.gaodeKey || plugin.gaodeKey || '', locationiqKey: env.locationiqKey || home.locationiqKey || plugin.locationiqKey || '' }
}

// ── 服务实例（进程内单例） ───────────────────────────────────────────────────
const geocode = createGeocode(getConfig)
const weather = createWeather({ geocode })
const placeSearch = createPlaceSearch(geocode)
const service = new TravelService(S.DATA_DIR, createRouteCalculator(getConfig), LEGACY_TRIPS_PATH)
const registry = createViewRegistry()
const dispatch = createToolDispatcher({ service, registry, placeSearch, weather, resolveCandidate, markCandidateAdopted })

// ── 错误 → HTTP 响应（与原项目 localAccess.errorResponse 一致） ──────────────
function errorStatus(code) {
  if (code === 'ACCESS_DENIED') return 403
  if (code === 'REVISION_CONFLICT' || code === 'IMPORT_CONFLICT') return 409
  if (code.endsWith('NOT_FOUND')) return 404
  if (code === 'STORAGE_CORRUPT' || code === 'INTERNAL_ERROR') return 500
  return 400
}

// 地点搜索简单全局限流：最近 10s 内最多 40 次（保护免费配额）
const hits = []
function allow() { const now = Date.now(); while (hits.length && now - hits[0] > 10000) hits.shift(); if (hits.length >= 40) return false; hits.push(now); return true }

// ── 插件主体 ───────────────────────────────────────────────────────────────
const mask = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : null)
function registerConfigTool(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return false
  tools.register({
    name: 'travel_configure',
    description: '查看或更新 travel-agent 的地点搜索密钥（写入 $DSH_HOME/travel-agent.config.json：gaodeKey 为高德 Web 服务 key，locationiqKey 为 LocationIQ key）。不传任何参数表示查看当前配置状态（密钥只显示头尾几位）；传入字段表示更新，传空字符串表示清除该字段。未配置密钥时搜索/逆地理/步行骑行路线不可用。',
    parameters: {
      type: 'object',
      properties: {
        gaodeKey: { type: 'string', description: '高德 Web 服务 API Key（明文写入配置文件）。' },
        locationiqKey: { type: 'string', description: 'LocationIQ API Key（明文写入配置文件）。' },
      },
    },
    output: { schema: {}, render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => false,
    timeoutMs: 10000,
    async execute(args) {
      const current = readJson(CONFIG_PATH) || {}
      const hasUpdate = (args && typeof args.gaodeKey === 'string') || (args && typeof args.locationiqKey === 'string')
      if (!hasUpdate) {
        const cfg = getConfig()
        return { configPath: CONFIG_PATH, gaodeKey: mask(cfg.gaodeKey), locationiqKey: mask(cfg.locationiqKey), configured: Boolean(cfg.gaodeKey || cfg.locationiqKey) }
      }
      const next = { ...current }
      for (const k of ['gaodeKey', 'locationiqKey']) if (typeof args[k] === 'string') { const v = args[k].trim(); if (v) next[k] = v; else delete next[k] }
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n')
      const cfg = getConfig()
      return { ok: true, configPath: CONFIG_PATH, gaodeKey: mask(cfg.gaodeKey), locationiqKey: mask(cfg.locationiqKey) }
    },
  })
  return true
}

// ── 「旅行模式」预设：复制 standard 预设为 travel，客户端据它整页接管 ─────────
// 并把插件自带的 travel-story-planner skill 同步进预设目录 + 注册到预设的 skill 目录列表
function syncTravelSkill(presetDir) {
  const src = fileURLToPath(new URL('../skills/travel-story-planner', import.meta.url))
  if (!fs.existsSync(src)) { console.error('travel-agent: 插件包内缺少 skills/travel-story-planner，skill 未同步'); return false }
  const dst = path.join(presetDir, 'skills', 'travel-story-planner')
  fs.cpSync(src, dst, { recursive: true })
  const comp = path.join(presetDir, 'agent.cordis.yml')
  try {
    const text = fs.readFileSync(comp, 'utf8')
    if (!text.includes('customSkillDirs')) {
      const row = "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'"
      if (text.includes(row)) fs.writeFileSync(comp, text.replace(row, row + '\n  config:\n    customSkillDirs:\n      - !!js "process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'skills/\', baseUrl))"'))
    }
  } catch (e) {}
  return true
}
function ensureTravelPreset(ctx) {
  const agentPresets = ctx.get('agentPresets')
  if (agentPresets === undefined) return
  ;(async () => {
    const list = await agentPresets.list()
    if (!list.some((p) => p.id === 'travel')) {
      await agentPresets.copy('standard', 'travel', '旅行模式')
      // copy 只保留源描述；把名称/描述改成旅行模式自己的
      try {
        const preset = await agentPresets.resolve('travel')
        const meta = path.join(path.dirname(preset.path), 'preset.yml')
        fs.writeFileSync(meta, 'name: 旅行模式\ndescription: 旅行规划模式：进入 Travel Story 全屏界面，模型直接调用旅行工具帮你规划行程、驱动地图。选择其它模式即可返回对话界面。\norder: 5\n')
      } catch (e) {}
      console.log('travel-agent: 已创建「旅行模式」预设（复制自 standard）')
    }
    // skill 每次启动都同步（保持与插件版本一致）
    const preset = await agentPresets.resolve('travel')
    if (syncTravelSkill(path.dirname(preset.path))) console.log('travel-agent: travel-story-planner skill 已同步到旅行模式预设')
  })().catch((e) => console.error('travel-agent: 旅行模式预设/skill 同步失败 ' + (e && e.message)))
}

const isLoopbackAddr = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

// ── 「当前旅行上下文」：面板开着时，给模型看见用户正在看什么 ──────────────────
// 视图心跳里带 panelOpen（客户端面板展开才为 true），只有开着面板才注入，不污染其它对话。
function getActiveTravelView() {
  const views = registry.list().filter((v) => v.panelOpen === true)
  return views.find((v) => v.focused) ?? views.find((v) => v.visibility === 'visible') ?? views[0]
}
const PAGE_NAMES = { plan: '计划页', play: '播放页', record: '录制页', home: '首页', unknown: '未知页' }
async function buildTravelContext() {
  const view = getActiveTravelView()
  if (!view) return null
  const lines = []
  if (!view.tripId) {
    lines.push('[旅行界面上下文] 用户正在旅行面板（首页）中，未打开具体行程。可用 list_trips 列出全部行程，get_trip/open_trip 查看与打开。')
    return lines.join('\n')
  }
  try {
    const { trip } = await service.execute('get_trip', { tripId: view.tripId })
    lines.push(`[旅行界面上下文] 用户正在查看行程「${trip.name}」(tripId: ${trip.id})，页面：${PAGE_NAMES[view.page] || view.page}。`)
    if (trip.stops.length) {
      const list = trip.stops.map((s, i) => `${i + 1}. ${s.name}(第${s.day}天, ${s.id})`).join('；')
      lines.push(`站点顺序：${list}。`)
    } else {
      lines.push('该行程还没有站点。')
    }
    const sel = view.selection || {}
    if (sel.stopId) { const s = trip.stops.find((x) => x.id === sel.stopId); if (s) lines.push(`当前选中：第${trip.stops.indexOf(s) + 1}站「${s.name}」(${s.id})。`) }
    if (sel.dayId) { const d = trip.days.find((x) => x.id === sel.dayId); if (d) lines.push(`当前选中：第${d.day}天(${d.id})。`) }
    lines.push('用户说的「这个行程/当前行程」指上述行程；「第N站/第N天/这一站」对应上表。查看用 get_trip，修改用 edit_itinerary（tripId 可省略，默认为该行程），打开/播放用 open_trip、control_view。')
    return lines.join('\n')
  } catch (e) { return null }
}

function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) { console.error('travel-agent: webServer 不可用'); return }
  const toolsOk = registerAgentTools(ctx, dispatch)
  const configToolOk = registerConfigTool(ctx)
  ensureTravelPreset(ctx)
  // 旅行上下文注入：面板开着时，把「用户正在看的行程 + 站点表」附到最新用户消息上。
  // 走 agent/pre-step 钩子（/api/session.prompt 已被 visual-review 占用，且钩子天然幂等）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    let context = null
    try { context = await buildTravelContext() } catch (e) { return decision }
    if (!context) return decision
    const msgs = decision.messages
    let idx = -1
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user') { idx = i; break } }
    if (idx === -1) return decision
    const msg = msgs[idx]
    const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : null)
    if (!content) return decision
    if (content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('[旅行界面上下文]'))) return decision
    const nextMsgs = msgs.slice()
    nextMsgs[idx] = { ...msg, content: [...content, { type: 'text', text: context }] }
    return { ...decision, messages: nextMsgs }
  })
  console.log('travel-agent: 旅行上下文注入已启用 (agent/pre-step)')
  const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  const handler = async (req, res) => {
    const remote = req.socket && req.socket.remoteAddress
    if (!isLoopback(remote)) { res.writeHead(403); res.end('forbidden'); return }
    const url = req.url || ''; const qi = url.indexOf('?'); const path = qi === -1 ? url : url.slice(0, qi)
    const writeJson = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    const failRes = (e) => { const code = (e && typeof e.code === 'string' && e.code) || 'INTERNAL_ERROR'; writeJson(errorStatus(code), { error: { code, message: e && e.message ? e.message : 'Request failed' } }) }
    async function readJsonBody(max) { const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); if (ct !== 'application/json') throw new TravelError('INVALID_INPUT', 'content type must be application/json'); const raw = await S.readBody(req, max); let body = {}; try { body = JSON.parse(raw.toString('utf8')) } catch (e) {} return body && typeof body === 'object' ? body : {} }

    // 行程快照（{trips, initialized}；agent 任务进行中的行程带 agentTaskActive）
    if (path === '/travel-agent/trips' && req.method === 'GET') {
      try { writeJson(200, await service.snapshot()) } catch (e) { failRes(e) }
      return
    }
    // 行程变更推送（SSE）：store 订阅它做多视图同步
    if (path === '/travel-agent/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' })
      const send = () => { try { res.write('data: {"type":"changed"}\n\n') } catch (e) {} }
      const off = service.onChange(send)
      const timer = setInterval(() => { try { res.write(': heartbeat\n\n') } catch (e) {} }, 15000)
      send()
      req.on('close', () => { off(); clearInterval(timer) })
      return
    }
    // 地点搜索（?q=）与逆地理（?lat=&lng=，足迹统计回填用）
    if (path === '/travel-agent/geocode' && req.method === 'GET') {
      const sp = new URL(url, 'http://x').searchParams
      if (sp.has('lat') && sp.has('lng')) {
        if (!geocode.hasSearchKeys()) { writeJson(200, { configured: false }); return }
        if (!allow()) { writeJson(429, { error: 'rate-limited' }); return }
        const lat = Number(sp.get('lat')), lng = Number(sp.get('lng'))
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) { writeJson(200, { configured: true }); return }
        try { const r = await geocode.reverseGeocode(lat, lng); writeJson(200, { configured: true, city: r?.city, country: r?.country }) }
        catch (e) { writeJson(502, { configured: true, error: 'reverse-failed' }) }
        return
      }
      const q = (sp.get('q') || '').trim()
      if (!q || q.length > 60) { writeJson(200, { results: [], configured: geocode.hasSearchKeys() }); return }
      if (!geocode.hasSearchKeys()) { writeJson(200, { results: [], configured: false }); return }
      if (!allow()) { writeJson(429, { results: [], error: 'rate-limited' }); return }
      try { const results = await geocode.searchPlaces(q); writeJson(200, { results, configured: true }) }
      catch (e) { writeJson(502, { results: [], error: 'search-failed' }) }
      return
    }
    // 路线计算
    if (path === '/travel-agent/routes' && req.method === 'POST') {
      try { const body = await readJsonBody(32768); writeJson(200, await service.execute('calculate_routes', body, 'web')) } catch (e) { failRes(e) }
      return
    }
    // 行程动作（web 界面来源）
    if (path === '/travel-agent/travel' && req.method === 'POST') {
      try {
        const body = await readJsonBody(S.getLimitBytes(process.env.MAX_TRIPS_BODY_MB, 10))
        if (!['create_trip', 'update_trip', 'delete_trip', 'edit_itinerary', 'import_legacy'].includes(body.action)) throw new TravelError('INVALID_INPUT', 'Unsupported web action')
        writeJson(200, await service.execute(body.action, body.input, 'web'))
      } catch (e) { failRes(e) }
      return
    }
    // Agent 桥：心跳 / 命令回执 / 注销（客户端 AppAgentBridge 协议）
    if (path === '/travel-agent/views' && req.method === 'POST') {
      try {
        const input = await readJsonBody(32768)
        if (input.op === 'remove') {
          if (typeof input.viewId !== 'string') throw new ViewError('INVALID_ARGUMENT')
          registry.remove(input.viewId)
          writeJson(200, { ok: true }); return
        }
        if (input.op === 'ack') {
          if (typeof input.viewId !== 'string' || typeof input.commandId !== 'string') throw new ViewError('INVALID_ARGUMENT')
          writeJson(200, { command: registry.acknowledge(input.viewId, input.commandId, input.status, input.error) }); return
        }
        if (input.op !== 'heartbeat') throw new ViewError('INVALID_ARGUMENT')
        const view = registry.heartbeat(input.view)
        let tripRevision = null
        try { if (view.tripId) tripRevision = (await service.execute('get_trip', { tripId: view.tripId })).revision } catch (e) { if (e?.code !== 'TRIP_NOT_FOUND') throw e }
        writeJson(200, { view, commands: registry.pending(view.viewId), tripRevision })
      } catch (e) { failRes(e) }
      return
    }
    // Agent 活动流（SSE，按 viewId；AgentActivityPanel 订阅）
    if (path === '/travel-agent/agent-events' && req.method === 'GET') {
      const viewId = new URL(url, 'http://x').searchParams.get('viewId')
      if (!validActivityViewId(viewId)) { writeJson(400, { error: { code: 'INVALID_ARGUMENT', message: '有效的 viewId 为必填项' } }); return }
      const store = getAgentActivityStore()
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' })
      const send = () => { try { res.write(`data: ${JSON.stringify({ type: 'snapshot', activities: store.list(viewId) })}\n\n`) } catch (e) {} }
      const off = store.subscribe(viewId, send)
      const timer = setInterval(() => { try { res.write(': heartbeat\n\n') } catch (e) {} }, 15000)
      send()
      req.on('close', () => { off(); clearInterval(timer) })
      return
    }
    // MapLibre worker 静态文件（setWorkerUrl 指向这里，代替原项目的 public/maplibre）
    if (path.startsWith('/travel-agent/maplibre/') && req.method === 'GET') {
      const file = path.slice('/travel-agent/maplibre/'.length)
      if (!/^[\w.-]+\.mjs$/.test(file)) { writeJson(404, { error: 'not found' }); return }
      let data = null
      try { data = fs.readFileSync(fileURLToPath(new URL('./static/maplibre/' + file, import.meta.url))) } catch (e) {}
      if (!data) { writeJson(404, { error: 'not found' }); return }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }); res.end(data); return
    }
    // 瓦片代理（TileJSON）
    if (path === '/travel-agent/tiles/planet' && req.method === 'GET') {
      const origin = 'http://' + (req.headers.host || 'localhost:3080')
      const json = await S.serveTileJSON(origin)
      if (!json) { writeJson(502, { error: 'upstream failed' }); return }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }); res.end(json); return
    }
    // 瓦片 / 字体
    if (path.startsWith('/travel-agent/tiles/') && req.method === 'GET') {
      const rel = path.slice('/travel-agent/tiles/'.length)
      if (!rel || rel.includes('..') || rel.includes('\\') || !rel.endsWith('.pbf')) { writeJson(404, { error: 'not found' }); return }
      const data = await S.servePbf(rel)
      if (!data) { writeJson(502, { error: 'upstream failed' }); return }
      res.writeHead(200, S.H_PBF); res.end(data); return
    }
    // 素材上传
    if (path === '/travel-agent/media' && req.method === 'POST') {
      const sp = new URL(url, 'http://x').searchParams
      const id = sp.get('id'), name = sp.get('name')
      if (!S.isMediaId(id)) { writeJson(400, { error: 'invalid-media-id' }); return }
      const ct = String(req.headers['content-type'] || 'application/octet-stream')
      if (!S.isAllowedMediaType(ct)) { writeJson(400, { error: 'unsupported-media-type' }); return }
      try { const buf = await S.readBody(req, S.getLimitBytes(process.env.MAX_MEDIA_UPLOAD_MB, 250)); if (!buf.length) { writeJson(400, { error: 'empty-file' }); return } await S.writeMedia(id, buf, { contentType: ct, name: (name || '未命名') }); writeJson(200, { ok: true, id, size: buf.length }) } catch (e) { writeJson(e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'request-too-large' : 'upload-failed' }) }
      return
    }
    // 素材读取 / 删除
    if (path.startsWith('/travel-agent/media/') && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = decodeURIComponent(path.slice('/travel-agent/media/'.length))
      if (req.method === 'DELETE') { await S.deleteMedia(id).catch(() => {}); writeJson(200, { ok: true }); return }
      const found = await S.readMedia(id).catch(() => null)
      if (!found) { writeJson(404, { error: '素材不存在' }); return }
      const total = found.buf.length, range = req.headers.range
      if (range) { const m = /^bytes=(\d*)-(\d*)$/.exec(range); if (m) { const start = m[1] ? parseInt(m[1], 10) : 0; const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1; if (start <= end && start < total) { res.writeHead(206, { 'content-type': found.meta.contentType, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + total, 'content-length': String(end - start + 1) }); res.end(found.buf.subarray(start, end + 1)); return } } }
      res.writeHead(200, { 'content-type': found.meta.contentType, 'accept-ranges': 'bytes', 'content-length': String(total) }); res.end(found.buf); return
    }
    // 录像上传
    if (path === '/travel-agent/recordings' && req.method === 'POST') {
      const sp = new URL(url, 'http://x').searchParams
      const trip = sp.get('trip') || '纪录片', ext = sp.get('ext')
      if (ext !== 'mp4' && ext !== 'webm') { writeJson(400, { error: 'invalid-video-extension' }); return }
      try { const buf = await S.readBody(req, S.getLimitBytes(process.env.MAX_RECORDING_UPLOAD_MB, 512)); if (!buf.length) { writeJson(400, { error: 'empty-video' }); return } const r = await S.saveRecording(buf, trip, ext); writeJson(200, Object.assign({ ok: true }, r)) } catch (e) { writeJson(e.code === 422 ? 422 : e.code === 413 ? 413 : 500, { error: e.message || 'recording-failed' }) }
      return
    }
    // 帧上传 / 合成 / 取消
    if (path === '/travel-agent/recordings/frames' && (req.method === 'POST' || req.method === 'DELETE')) {
      const sp = new URL(url, 'http://x').searchParams
      const session = sp.get('session') || ''
      if (!S.isSessionId(session)) { writeJson(400, { error: 'invalid-session' }); return }
      if (req.method === 'DELETE') { await S.deleteFrames(session); writeJson(200, { ok: true }); return }
      if (sp.get('finalize') === '1') { try { const fpsRaw = Number(sp.get('fps')); const r = await S.finalizeFrames(session, sp.get('trip') || '纪录片', fpsRaw); writeJson(200, Object.assign({ ok: true }, r)) } catch (e) { writeJson(e.code === 400 ? 400 : 500, { error: e.message || 'frame-processing-failed' }) } return }
      try { const raw = await S.readBody(req, S.getLimitBytes(process.env.MAX_FRAME_BATCH_MB, 64)); const ct = String(req.headers['content-type'] || ''); const bm = /boundary=([^;]+)/i.exec(ct); if (!bm) { writeJson(400, { error: 'no boundary' }); return } const parts = S.parseMultipart(raw, bm[1].trim()); const files = parts.filter((p) => p.filename && S.isFrameName(p.filename) && p.type.toLowerCase() === 'image/jpeg'); if (!files.length) { writeJson(400, { error: 'empty-frame-batch' }); return } const count = await S.saveFrames(session, files); writeJson(200, { ok: true, count }) } catch (e) { writeJson(500, { error: 'frame-processing-failed' }) }
      return
    }
    // 录像下载
    if (path.startsWith('/travel-agent/recordings/') && req.method === 'GET') {
      const file = decodeURIComponent(path.slice('/travel-agent/recordings/'.length))
      if (file === 'frames') { writeJson(404, { error: 'not found' }); return }
      const dl = new URL(url, 'http://x').searchParams.get('download') === '1'
      const r = await S.readRecording(file, dl)
      if (!r) { writeJson(404, { error: '文件不存在' }); return }
      res.writeHead(200, r.headers); res.end(r.buf); return
    }
    // 步行/骑行路线代理（客户端 routing.ts 用）
    if (path === '/travel-agent/route' && req.method === 'GET') {
      const sp = new URL(url, 'http://x').searchParams
      const from = (sp.get('from') || '').split(',').map(Number), to = (sp.get('to') || '').split(',').map(Number)
      const profile = sp.get('profile')
      const cfg = getConfig()
      if (profile !== 'walking' && profile !== 'cycling') { writeJson(400, { error: 'invalid profile' }); return }
      if (!cfg.gaodeKey) { writeJson(503, { error: 'GAODE_KEY not configured' }); return }
      try {
        const a = wgs84ToGcj02(from[1], from[0]), b = wgs84ToGcj02(to[1], to[0])
        const u = new URL(profile === 'walking' ? 'https://restapi.amap.com/v3/direction/walking' : 'https://restapi.amap.com/v4/direction/bicycling')
        u.searchParams.set('key', cfg.gaodeKey); u.searchParams.set('origin', a.lon + ',' + a.lat); u.searchParams.set('destination', b.lon + ',' + b.lat)
        const r = await fetchJson(u.toString(), 12000)
        if (!r.ok || !r.json) throw new Error('gaode')
        const p = (profile === 'walking' ? r.json.route && r.json.route.paths : r.json.data && r.json.data.paths); const p0 = p && p[0]
        if (!p0) throw new Error('no route')
        const coords = (p0.steps || []).flatMap((st) => st.polyline ? st.polyline.split(';').map((x) => x.split(',').map(Number)).filter((q) => q.length === 2).map((q) => { const w = gcj02ToWgs84(q[1], q[0]); return [w.lon, w.lat] }) : [])
        writeJson(200, { route: { type: 'LineString', coordinates: coords }, distance: Number(p0.distance) || 0, duration: Number(p0.duration) || 0 })
      } catch (e) { writeJson(502, { error: 'gaode route failed' }) }
      return
    }
    res.writeHead(404); res.end()
  }
  async function fetchJson(url, timeoutMs = 8000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const res = await fetch(url, { signal: c.signal }); const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch (e) {} return { ok: res.ok, status: res.status, json } } finally { clearTimeout(t) } }
  try { const dispose = webServer.register({ kind: 'prefix', path: '/travel-agent', handler }); console.log('travel-agent: /travel-agent API 已注册'); ctx.effect(() => () => { try { dispose() } catch (e) {} }) } catch (e) { console.error('travel-agent: 路由注册失败 ' + (e && e.message)) }
  console.log('travel-agent: 插件已加载 (data=' + S.DATA_DIR + ', tools=' + (toolsOk ? '18' : 'unavailable') + ', configTool=' + (configToolOk ? 'yes' : 'no') + ')')
}

export { name, inject, apply }
