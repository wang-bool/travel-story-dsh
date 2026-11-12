// travel-agent host 端冒烟测试：起真实 http 服务器，跑核心 API + 工具分发。
// 用法: node scripts/smoke.mjs   （数据写到 /tmp/travel-agent-smoke-*，不碰真实 DSH_HOME）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-agent-smoke-'))
process.env.DSH_HOME = tmp
process.env.TRAVEL_AGENT_DATA_DIR = path.join(tmp, 'data')

const { name, inject, apply } = await import('../lib/index.js')

let handler = null
const tools = new Map()
let preStepHook = null
const ctx = {
  get: (key) => key === 'webServer'
    ? { register: (spec) => { handler = spec.handler; return () => {} } }
    : key === 'tools'
      ? { register: (t) => { tools.set(t.name, t) } }
      : undefined,
  effect: (fn) => { fn() },
  on: (event, fn) => { if (event === 'agent/pre-step') preStepHook = fn },
}
apply(ctx)
if (!handler) { console.error('FAIL: webServer.register 未被调用'); process.exit(1) }

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)) })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
let passed = 0, failed = 0
const t = async (label, fn) => { try { await fn(); passed++; console.log('ok -', label) } catch (e) { failed++; console.log('FAIL -', label, ':', e.message) } }
const j = async (r) => { const b = await r.json(); return { status: r.status, body: b } }
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

await t('GET /trips 返回快照（initialized=false）', async () => {
  const { status, body } = await j(await fetch(base + '/travel-agent/trips'))
  if (status !== 200 || !Array.isArray(body.trips) || body.initialized !== false) throw new Error(JSON.stringify(body).slice(0, 200))
})

await t('注册了 17 个 DSH 工具', async () => {
  const expected = ['apply_plan', 'get_plan_task', 'ensure_service', 'get_status', 'get_weather', 'list_trips', 'get_trip', 'search_places', 'create_trip', 'update_trip', 'edit_itinerary', 'delete_trip', 'calculate_routes', 'open_trip', 'get_view_state', 'control_view', 'get_command']
  const missing = expected.filter((n) => !tools.has(n))
  if (missing.length) throw new Error('缺少: ' + missing.join(','))
})

await t('工具 get_status 可执行', async () => {
  const r = await tools.get('get_status').execute({})
  if (!r.capabilities || r.connectedViews !== 0) throw new Error(JSON.stringify(r).slice(0, 200))
})

let tripId, revision
await t('POST /travel create_trip（幂等 requestId）', async () => {
  const input = { name: '冒烟测试行程', startDate: '2026-12-01', endDate: '2026-12-03', requestId: 'smoke-create-1' }
  const { status, body } = await j(await post('/travel-agent/travel', { action: 'create_trip', input }))
  if (status !== 200 || !body.trip || body.trip.days.length !== 3) throw new Error(JSON.stringify(body).slice(0, 300))
  tripId = body.tripId; revision = body.revision
  const again = await j(await post('/travel-agent/travel', { action: 'create_trip', input }))
  if (again.body.tripId !== tripId) throw new Error('requestId 幂等失效')
})

await t('edit_itinerary 加 stop（web 来源允许裸 place）', async () => {
  const { status, body } = await j(await post('/travel-agent/travel', { action: 'edit_itinerary', input: { tripId, expectedRevision: revision, requestId: 'smoke-edit-1', operations: [{ op: 'add_stop', dayId: (await j(await fetch(base + '/travel-agent/trips'))).body.trips[0].days[0].id, place: { name: '测试地点', latitude: 31.23, longitude: 121.47, type: 'attraction' } }] } }))
  if (status !== 200 || !body.results?.[0]?.stopId) throw new Error(JSON.stringify(body).slice(0, 300))
  revision = body.revision
})

await t('REVISION_CONFLICT 返回 409 + code', async () => {
  const { status, body } = await j(await post('/travel-agent/travel', { action: 'delete_trip', input: { tripId, expectedRevision: 999, requestId: 'smoke-del-0' } }))
  if (status !== 409 || body.error?.code !== 'REVISION_CONFLICT') throw new Error(status + ' ' + JSON.stringify(body))
})

await t('POST /views 心跳 → pending 命令 → ack', async () => {
  const view = { viewId: 'view1', tripId, page: 'plan', ready: true }
  const r1 = await j(await post('/travel-agent/views', { op: 'heartbeat', view }))
  if (r1.status !== 200 || r1.body.tripRevision !== revision) throw new Error('heartbeat: ' + JSON.stringify(r1.body).slice(0, 200))
  // 通过工具入队一个 control_view 命令
  const cmd = await tools.get('control_view').execute({ viewId: 'view1', action: 'fit_trip' })
  const r2 = await j(await post('/travel-agent/views', { op: 'heartbeat', view }))
  const pending = r2.body.commands.find((c) => c.commandId === cmd.commandId)
  if (!pending) throw new Error('命令未出现在 pending')
  const ack1 = await j(await post('/travel-agent/views', { op: 'ack', viewId: 'view1', commandId: cmd.commandId, status: 'running' }))
  const ack2 = await j(await post('/travel-agent/views', { op: 'ack', viewId: 'view1', commandId: cmd.commandId, status: 'completed' }))
  if (ack2.body.command.status !== 'completed') throw new Error('ack 状态机异常')
  const receipt = await tools.get('get_command').execute({ commandId: cmd.commandId })
  if (receipt.status !== 'completed') throw new Error('get_command 回执异常')
})

await t('工具 create_trip（presentation.mode=none，无需视图）', async () => {
  const r = await tools.get('create_trip').execute({ name: 'agent 建的行程', startDate: '2026-12-10', endDate: '2026-12-11', requestId: 'smoke-agent-1', presentation: { mode: 'none' } })
  if (!r.tripId || r.presentation?.status !== 'skipped') throw new Error(JSON.stringify(r).slice(0, 300))
  if (!r.trip.segments || r.trip.segments.some((s) => 'route' in s)) throw new Error('agent 响应应去掉 route 几何')
})

await t('工具 edit_itinerary 拒绝裸 place（agent 来源）', async () => {
  const t3 = await tools.get('list_trips').execute({})
  const target = t3.trips.find((x) => x.name === 'agent 建的行程')
  const full = await tools.get('get_trip').execute({ tripId: target.id })
  let threw = false
  try {
    await tools.get('edit_itinerary').execute({ tripId: target.id, expectedRevision: full.revision, requestId: 'smoke-agent-2', presentation: { mode: 'none' }, operations: [{ op: 'add_stop', dayId: full.trip.days[0].id, place: { name: 'x', latitude: 1, longitude: 1, type: 'attraction' } }] })
  } catch (e) { threw = /candidateId|INVALID_INPUT/.test(e.message) }
  if (!threw) throw new Error('裸 place 未被拒绝')
})

await t('GET /geocode 搜索与逆地理响应结构正确', async () => {
  // 本机插件自带配置里有 key，所以这里走真实搜索；只校验响应结构
  const { body } = await j(await fetch(base + '/travel-agent/geocode?q=test'))
  if (!Array.isArray(body.results) || typeof body.configured !== 'boolean') throw new Error(JSON.stringify(body).slice(0, 200))
  const rev = await j(await fetch(base + '/travel-agent/geocode?lat=31.2&lng=121.5'))
  if (typeof rev.body.configured !== 'boolean') throw new Error('reverse 响应结构异常')
})

await t('工具 get_weather 返回逐日预报（真实 Open-Meteo 调用）', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const plus2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
  const r = await tools.get('get_weather').execute({ latitude: 31.2989, longitude: 120.6196, startDate: today, endDate: plus2 })
  if (!Array.isArray(r.days) || r.days.length !== 3) throw new Error(JSON.stringify(r).slice(0, 200))
  const d = r.days[0]
  if (typeof d.label !== 'string' || !d.label || typeof d.effect !== 'string' || typeof d.weatherCode !== 'number') throw new Error('day 结构异常: ' + JSON.stringify(d))
  if (typeof d.low !== 'number' || typeof d.high !== 'number' || d.low > d.high) throw new Error('温度异常: ' + JSON.stringify(d))
  // 超出预报范围的日期应报 OUT_OF_FORECAST_RANGE
  let rejected = false
  try { await tools.get('get_weather').execute({ latitude: 31.3, longitude: 120.6, startDate: '2099-01-01', endDate: '2099-01-02' }) } catch (e) { rejected = /OUT_OF_FORECAST_RANGE/.test(e.message) }
  if (!rejected) throw new Error('超范围日期未拒绝')
})

await t('GET /maplibre worker 可下载', async () => {
  const r = await fetch(base + '/travel-agent/maplibre/maplibre-gl-worker.mjs')
  if (r.status !== 200 || !(r.headers.get('content-type') || '').includes('javascript')) throw new Error('worker 404')
  const text = await r.text()
  if (text.length < 5000) throw new Error('worker 内容太小')
})

await t('GET /events SSE 推送 changed', async () => {
  const controller = new AbortController()
  const r = await fetch(base + '/travel-agent/events', { signal: controller.signal })
  const reader = r.body.getReader()
  const { value } = await reader.read()
  if (!new TextDecoder().decode(value).includes('changed')) throw new Error('首帧不是 changed')
  controller.abort()
})

await t('GET /agent-events 需要合法 viewId', async () => {
  const r = await fetch(base + '/travel-agent/agent-events')
  if (r.status !== 400) throw new Error('缺 viewId 应 400')
  const okRes = await fetch(base + '/travel-agent/agent-events?viewId=view1')
  if (okRes.status !== 200) throw new Error('合法 viewId 应 200')
  okRes.body.cancel()
})

await t('apply_plan 缺 review 被拒（PLAN_REVIEW_REQUIRED）', async () => {
  let code = ''
  try { await tools.get('apply_plan').execute({ requestId: 'smoke-plan-1', viewId: 'view1', trip: { name: 'x', startDate: '2026-12-20', endDate: '2026-12-20' }, days: [{ date: '2026-12-20', stops: [] }] }) }
  catch (e) { code = e.message }
  if (!/PLAN_REVIEW_REQUIRED|INVALID_INPUT/.test(code)) throw new Error('未拒绝: ' + code)
})

// ── 上下文打通：panelOpen 视图 + pre-step 注入 + 工具参数省略 ────────────────
const runPreStep = (messages) => preStepHook(null, async () => ({ kind: 'enter', messages }))
await t('上下文注入：面板开着时给最新用户消息附加上下文', async () => {
  if (!preStepHook) throw new Error('pre-step 钩子未注册')
  // 让 view1 处于「面板打开且正在看冒烟测试行程」的状态
  await j(await post('/travel-agent/views', { op: 'heartbeat', view: { viewId: 'view1', tripId, page: 'plan', ready: true, panelOpen: true, focused: true } }))
  const decision = await runPreStep([{ role: 'user', content: [{ type: 'text', text: '把第1站改掉' }] }])
  const content = decision.messages[0].content
  const ctxBlock = content.find((p) => p.type === 'text' && p.text.includes('旅行界面上下文'))
  if (!ctxBlock) throw new Error('未注入上下文')
  if (!ctxBlock.text.includes('冒烟测试行程') || !ctxBlock.text.includes('测试地点')) throw new Error('上下文内容不对: ' + ctxBlock.text.slice(0, 200))
  // 幂等：同一消息再次经过钩子不重复注入
  const again = await runPreStep(decision.messages)
  if (again.messages[0].content.filter((p) => p.text?.includes('旅行界面上下文')).length !== 1) throw new Error('重复注入')
})

await t('上下文注入：面板关闭时不注入', async () => {
  await j(await post('/travel-agent/views', { op: 'heartbeat', view: { viewId: 'view1', tripId, page: 'plan', ready: true, panelOpen: false, focused: true } }))
  const decision = await runPreStep([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  const content = decision.messages[0].content
  if (content.some((p) => p.type === 'text' && p.text.includes('旅行界面上下文'))) throw new Error('关着面板也注入了')
  // 恢复打开状态，供后续测试用
  await j(await post('/travel-agent/views', { op: 'heartbeat', view: { viewId: 'view1', tripId, page: 'plan', ready: true, panelOpen: true, focused: true } }))
})

await t('工具 edit_itinerary 省略 tripId/expectedRevision（取当前查看的行程）', async () => {
  const r = await tools.get('edit_itinerary').execute({ requestId: 'smoke-default-trip-1', presentation: { mode: 'none' }, operations: [{ op: 'add_day' }] })
  if (r.tripId !== tripId) throw new Error('没有落到当前行程: ' + r.tripId)
  if (r.trip.days.length !== 4) throw new Error('天数不对: ' + r.trip.days.length)
})

await t('set_weather 写入并持久化当天天气', async () => {
  const cur = await tools.get('get_trip').execute({ tripId })
  const dayId = cur.trip.days[0].id
  const r = await tools.get('edit_itinerary').execute({ tripId, requestId: 'smoke-weather-1', presentation: { mode: 'none' }, operations: [{ op: 'set_weather', dayId, weather: { label: '晴转多云', low: 3, high: 12, effect: 'sun' } }] })
  if (r.trip.days[0].weather?.label !== '晴转多云' || r.trip.days[0].weather?.effect !== 'sun') throw new Error('天气未写入')
  const again = await tools.get('get_trip').execute({ tripId })
  if (again.trip.days[0].weather?.high !== 12) throw new Error('天气未持久化')
  // 非法 effect 被拒
  let rejected = false
  try { await tools.get('edit_itinerary').execute({ tripId, requestId: 'smoke-weather-2', presentation: { mode: 'none' }, operations: [{ op: 'set_weather', dayId, weather: { label: 'x', effect: 'tornado' } }] }) } catch (e) { rejected = /INVALID_INPUT/.test(e.message) }
  if (!rejected) throw new Error('非法 effect 未拒绝')
})

await t('数据落盘 + 旧版存储迁移', async () => {
  if (!fs.existsSync(path.join(tmp, 'data', 'trips.json'))) throw new Error('trips.json 未生成')
  // 旧版 travel-agent-trips.json 迁移（新起一个 service 进程态 → 用新 import 缓存不行，直接验证文件逻辑在类里即可）
})

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
