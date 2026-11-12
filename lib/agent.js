// Agent 桥与工具分发（移植自原项目 lib/server/viewRegistry.ts、appNavigator.ts、
// mutationPresentation.ts、planTasks.ts、mcp/planReview.mjs、mcp/tools.mjs、
// lib/server/toolDispatcher.ts）。原 MCP stdio 桥在 DSH 里由 ctx.tools 取代。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { check, date, dayCount, place, TravelError } from './domain.js'
import { isRecoverablePlanError } from './service.js'
import { getAgentActivityStore } from './placeSearch.js'

// ── 视图注册表（viewRegistry.ts） ────────────────────────────────────────────
export class ViewError extends Error {
  constructor(code) { super(code); this.code = code }
}
const viewFail = (code) => { throw new ViewError(code) }
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const terminal = (status) => ['completed', 'failed', 'expired'].includes(status)
const copy = (value) => structuredClone(value)
export function createViewRegistry(options = {}) {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? 30000
  const views = new Map()
  const commands = new Map()
  function expireView(id) {
    views.delete(id)
    for (const command of commands.values()) if (command.viewId === id && !terminal(command.status)) command.status = 'expired'
  }
  function sweep() {
    const time = now()
    for (const view of views.values()) if (time - view.lastSeen >= ttl) expireView(view.viewId)
    for (const command of commands.values()) if (time >= command.expiresAt && !terminal(command.status)) command.status = 'expired'
    // Keep recent receipts, but bound memory even if a client never queries them.
    for (const [id, command] of commands) if (terminal(command.status) && time - command.expiresAt > 5 * ttl) commands.delete(id)
  }
  function target(id) { sweep(); return views.get(id) ?? viewFail('VIEW_NOT_CONNECTED') }
  return {
    heartbeat(input) {
      sweep()
      if (!input || !identifier(input.viewId) || (input.tripId !== undefined && !identifier(input.tripId)) || !['home', 'plan', 'play', 'record', 'unknown'].includes(input.page) || typeof input.ready !== 'boolean') viewFail('INVALID_ARGUMENT')
      if (['plan', 'play', 'record'].includes(input.page) && !identifier(input.tripId)) viewFail('INVALID_ARGUMENT')
      if (input.appBridge !== undefined && typeof input.appBridge !== 'boolean') viewFail('INVALID_ARGUMENT')
      if (input.host !== undefined && !['browser', 'desktop'].includes(input.host)) viewFail('INVALID_ARGUMENT')
      if (input.launchId !== undefined && !identifier(input.launchId)) viewFail('INVALID_ARGUMENT')
      if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) viewFail('INVALID_ARGUMENT')
      if (input.visibility !== undefined && !['visible', 'hidden'].includes(input.visibility)) viewFail('INVALID_ARGUMENT')
      if (input.focused !== undefined && typeof input.focused !== 'boolean') viewFail('INVALID_ARGUMENT')
      for (const field of [input.mapState, input.selection, input.playback])
        if (field !== undefined && (!field || typeof field !== 'object' || Array.isArray(field) || JSON.stringify(field).length > 8192)) viewFail('INVALID_ARGUMENT')
      const previous = views.get(input.viewId)
      if (previous && (previous.tripId !== input.tripId || previous.page !== input.page))
        for (const command of commands.values()) if (command.viewId === input.viewId && command.action !== 'navigate' && !terminal(command.status)) command.status = 'expired'
      if (!views.has(input.viewId) && views.size >= (options.maxViews ?? 32)) viewFail('VIEW_LIMIT')
      const state = copy({ ...input, lastSeen: now() })
      views.set(input.viewId, state)
      return copy(state)
    },
    list() { sweep(); return copy([...views.values()]) },
    enqueue(viewId, action, args = {}) {
      const view = target(viewId)
      if (!['show_day', 'focus_stop', 'fit_trip', 'play', 'restart', 'stop', 'present_change', 'navigate'].includes(action)) viewFail('INVALID_ACTION')
      if (action !== 'navigate' && !['plan', 'play'].includes(view.page)) viewFail('INCOMPATIBLE_VIEW')
      if (!view.ready && action !== 'navigate') viewFail('VIEW_NOT_READY')
      if (['play', 'restart', 'stop'].includes(action) && view.page !== 'play') viewFail('INCOMPATIBLE_VIEW')
      if (!args || typeof args !== 'object' || Array.isArray(args)) viewFail('INVALID_ARGUMENT')
      if (action === 'present_change' && view.page !== 'plan') viewFail('INCOMPATIBLE_VIEW')
      const required = action === 'show_day' ? 'dayId' : action === 'focus_stop' ? 'stopId' : null
      if (required && !identifier(args[required])) viewFail('INVALID_ARGUMENT')
      if (action === 'navigate') {
        if (!identifier(args.tripId) || !['plan', 'play'].includes(String(args.page))) viewFail('INVALID_ARGUMENT')
        for (const key of ['stopId', 'dayId']) if (args[key] !== undefined && !identifier(args[key])) viewFail('INVALID_ARGUMENT')
        if (args.stopId && args.dayId) viewFail('INVALID_ARGUMENT')
        if (args.revision !== undefined && (!Number.isInteger(args.revision) || Number(args.revision) < 1)) viewFail('INVALID_ARGUMENT')
        if (Object.keys(args).some((k) => !['tripId', 'page', 'stopId', 'dayId', 'revision'].includes(k))) viewFail('INVALID_ARGUMENT')
      } else if (action === 'present_change') {
        if (!Number.isInteger(args.revision) || Number(args.revision) < 1 || typeof args.message !== 'string' || args.message.length > 500) viewFail('INVALID_ARGUMENT')
        if (args.fitTrip !== undefined && typeof args.fitTrip !== 'boolean') viewFail('INVALID_ARGUMENT')
        if (args.stopId !== undefined && !identifier(args.stopId)) viewFail('INVALID_ARGUMENT')
        if (args.dayId !== undefined && !identifier(args.dayId)) viewFail('INVALID_ARGUMENT')
        if (args.addedStopIds !== undefined && (!Array.isArray(args.addedStopIds) || args.addedStopIds.length > 100 || !args.addedStopIds.every(identifier))) viewFail('INVALID_ARGUMENT')
        if (Object.keys(args).some((k) => !['revision', 'message', 'stopId', 'dayId', 'addedStopIds', 'fitTrip'].includes(k))) viewFail('INVALID_ARGUMENT')
      } else if (Object.keys(args).some((key) => key !== required)) viewFail('INVALID_ARGUMENT')
      if ([...commands.values()].filter((c) => c.viewId === viewId && !terminal(c.status)).length >= (options.maxPending ?? 32)) viewFail('COMMAND_QUEUE_FULL')
      if (commands.size >= (options.maxCommands ?? 1024)) {
        const receipt = [...commands.values()].find((c) => terminal(c.status))
        if (receipt) commands.delete(receipt.commandId)
        else viewFail('COMMAND_QUEUE_FULL')
      }
      const command = { commandId: randomUUID(), viewId, tripId: action === 'navigate' ? String(args.tripId) : view.tripId, action, args: copy(args), status: 'queued', createdAt: now(), expiresAt: now() + (action === 'navigate' ? 120000 : ttl) }
      commands.set(command.commandId, command)
      return copy(command)
    },
    getCommand(id) { sweep(); return copy(commands.get(id) ?? viewFail('COMMAND_NOT_FOUND')) },
    pending(viewId) { target(viewId); return copy([...commands.values()].filter((c) => c.viewId === viewId && c.status === 'queued')) },
    acknowledge(viewId, commandId, status, error) {
      target(viewId)
      const command = commands.get(commandId) ?? viewFail('COMMAND_NOT_FOUND')
      if (command.viewId !== viewId) viewFail('COMMAND_TARGET_MISMATCH')
      if (!['running', 'completed', 'failed'].includes(status) || terminal(command.status) || (status === 'completed' && command.status !== 'running')) viewFail('INVALID_COMMAND_STATE')
      command.status = status
      if (status === 'failed') command.error = String(error ?? 'Page command failed').slice(0, 1000)
      return copy(command)
    },
    remove(viewId) { sweep(); expireView(viewId) },
  }
}

// ── 视图选择 + 打开（appNavigator.ts） ───────────────────────────────────────
// DSH 里没有独立应用窗口可启动：无已连接视图时返回失败回执，提示用户打开面板。
export function chooseAppView(registry, target) {
  const views = registry.list()
  if (target.viewId) return views.find((v) => v.viewId === target.viewId) ?? (() => { throw new ViewError('VIEW_NOT_CONNECTED') })()
  for (const candidates of [views.filter((v) => v.focused), views.filter((v) => v.visibility === 'visible'), views.filter((v) => v.tripId === target.tripId && v.page === target.page), views]) {
    if (candidates.length === 1) return candidates[0]
  }
  if (views.length) throw new ViewError('AMBIGUOUS_VIEW')
  return undefined
}
export function createAppNavigator(options) {
  const { registry, launch } = options, now = options.now ?? Date.now
  const launches = new Map()
  let starting
  function getCommand(id) {
    const receipt = launches.get(id)
    if (!receipt) return registry.getCommand(id)
    if (['queued', 'running'].includes(receipt.status) && now() >= receipt.expiresAt) receipt.status = 'expired'
    if (['queued', 'running'].includes(receipt.status)) {
      const view = registry.list().find((v) => v.launchId === id && v.tripId === receipt.tripId && v.page === receipt.page)
      if (view) {
        receipt.viewId = view.viewId
        if (view.mapState?.status === 'failed') { receipt.status = 'failed'; receipt.error = String(view.mapState.error || 'Map initialization failed') }
        else receipt.status = view.ready && (!receipt.revision || Number(view.revision) >= receipt.revision) && (!receipt.stopId || view.selection?.stopId === receipt.stopId) && (!receipt.dayId || view.selection?.dayId === receipt.dayId) ? 'completed' : 'running'
      }
      if (now() >= receipt.expiresAt && !['completed', 'failed'].includes(receipt.status)) receipt.status = 'expired'
    }
    return { ...receipt }
  }
  return {
    getCommand,
    async open(target, base) {
      const url = new URL(`/trip/${encodeURIComponent(target.tripId)}${target.page === 'play' ? '/play' : ''}`, base)
      if (target.stopId) url.searchParams.set('stopId', target.stopId)
      if (target.dayId) url.searchParams.set('dayId', target.dayId)
      if (target.page === 'play') url.searchParams.set('autoplay', '0')
      const view = chooseAppView(registry, target)
      if (view) {
        const { viewId: _, ...args } = target
        const command = registry.enqueue(view.viewId, 'navigate', args)
        return { ...command, url: url.toString(), reused: true }
      }
      const key = JSON.stringify([base, target])
      if (starting && !['failed', 'expired', 'completed'].includes(String(getCommand(starting.receipt.commandId).status))) {
        if (starting.key !== key) throw new ViewError('APP_STARTING')
        await starting.task
        return { ...starting.receipt }
      }
      const receipt = { ...target, commandId: randomUUID(), status: 'queued', createdAt: now(), expiresAt: now() + 120000, url: '', reused: false }
      url.searchParams.set('openCommandId', receipt.commandId)
      receipt.url = url.toString()
      launches.set(receipt.commandId, receipt)
      while (launches.size > 200) launches.delete(launches.keys().next().value)
      const task = Promise.resolve().then(() => launch(receipt.url)).then(() => {}, () => { receipt.status = 'failed'; receipt.error = '没有在运行的旅行计划面板；请在 DSH 页面点「🧳 旅行计划」打开后重试。' })
      starting = { key, receipt, task }
      await task
      return { ...receipt }
    },
  }
}

// ── 变更展示（mutationPresentation.ts） ──────────────────────────────────────
export function describeMutation(name, result) {
  const args = { revision: result.revision, message: 'Agent 已更新行程', fitTrip: name !== 'update_trip' }
  if (name === 'create_trip') args.message = `Agent 已创建行程：${result.trip.name}`
  if (name === 'update_trip') args.message = `Agent 已更新：${result.trip.name}`
  if (name === 'calculate_routes') args.message = result.routes?.some((r) => r.quality === 'unavailable') ? 'Agent 已计算路线，部分交通方式暂无可用路线' : 'Agent 已更新路线'
  if (name === 'edit_itinerary') {
    const results = result.results ?? [], stops = result.trip?.stops ?? [], days = result.trip?.days ?? []
    const target = [...results].reverse().find((r) => (r.stopId && stops.some((s) => s.id === r.stopId)) || (r.dayId && days.some((d) => d.id === r.dayId)))
    const selected = target?.stopId && stops.some((s) => s.id === target.stopId) ? target : undefined
    if (selected) args.stopId = selected.stopId
    else if (target?.dayId) args.dayId = target.dayId
    args.addedStopIds = results.filter((r) => r.op === 'add_stop' && stops.some((s) => s.id === r.stopId)).map((r) => r.stopId)
    const last = results.at(-1), stop = stops.find((s) => s.id === selected?.stopId)
    const labels = { add_stop: '添加', update_stop: '更新', move_stop: '移动', remove_stop: '删除地点', add_day: '添加一天', remove_day: '删除一天', set_transport: '调整交通方式', set_weather: '更新天气' }
    args.message = results.length === 1 ? `Agent 已${labels[last?.op] ?? '更新行程'}${stop ? `：${stop.name}` : ''}` : `Agent 已更新行程（${results.length} 项操作）`
  }
  args.message = String(args.message).slice(0, 500)
  return args
}
export function createMutationPresenter(options) {
  const { registry } = options, waitMs = options.waitMs ?? 30000, ackWaitMs = options.ackWaitMs ?? 10000, pollMs = options.pollMs ?? 150
  const sleep = () => new Promise((resolve) => setTimeout(resolve, pollMs))
  const receipts = new Map()
  const openings = new Map()
  async function ready(view, deadline = Date.now() + waitMs) {
    while (Date.now() < deadline) {
      const current = registry.list().find((v) => v.viewId === view.viewId && v.tripId === view.tripId && v.page === 'plan')
      if (!current) throw Object.assign(new Error('行程页面已断开'), { code: 'VIEW_NOT_CONNECTED' })
      if (current.mapState?.status === 'failed') throw Object.assign(new Error(String(current.mapState.error || '地图加载失败')), { code: 'VIEW_FAILED' })
      if (current.ready) return current
      await sleep()
    }
    throw Object.assign(new Error('行程已保存，但地图尚未就绪；请打开页面后重试展示'), { code: 'VIEW_NOT_READY' })
  }
  async function ensureView(tripId, viewId, open) {
    const existing = chooseAppView(registry, { tripId, page: 'plan', viewId })
    if (existing?.tripId === tripId && existing.page === 'plan') return ready(existing)
    const key = `${viewId ?? existing?.viewId ?? 'launch'}:${tripId}`
    if (!openings.has(key)) {
      const pending = (async () => {
        const receipt = await open()
        if (receipt.status === 'failed') throw Object.assign(new Error(receipt.error || '浏览器无法打开'), { code: 'BROWSER_OPEN_FAILED', openCommandId: receipt.commandId, url: receipt.url })
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const view = registry.list().find((v) => v.tripId === tripId && v.page === 'plan' && (receipt.viewId ? v.viewId === receipt.viewId : v.launchId === receipt.commandId))
          if (receipt.viewId) {
            const navigation = registry.getCommand(receipt.commandId)
            if (['failed', 'expired'].includes(navigation.status)) throw Object.assign(new Error(navigation.error || 'Navigation failed'), { code: 'NAVIGATION_FAILED' })
            if (navigation.status !== 'completed') { await sleep(); continue }
          }
          if (view) return ready(view, deadline)
          await sleep()
        }
        throw Object.assign(new Error('行程已保存，但未收到浏览器页面连接，请手动打开返回地址'), { code: 'VIEW_NOT_CONNECTED', openCommandId: receipt.commandId, url: receipt.url })
      })()
      openings.set(key, pending)
      pending.finally(() => openings.delete(key)).catch(() => {})
    }
    return openings.get(key)
  }
  async function deliver(name, input, result, open) {
    try {
      const view = await ensureView(result.tripId, input.presentation?.viewId, open)
      const command = registry.enqueue(view.viewId, 'present_change', describeMutation(name, result))
      const deadline = Date.now() + ackWaitMs
      while (Date.now() < deadline) {
        const receipt = registry.getCommand(command.commandId)
        if (receipt.status === 'completed') return { status: 'completed', commandId: command.commandId, viewId: view.viewId }
        if (receipt.status === 'failed' || receipt.status === 'expired') return { status: 'failed', commandId: command.commandId, viewId: view.viewId, code: receipt.status === 'expired' ? 'COMMAND_EXPIRED' : 'VIEW_FAILED', error: receipt.error || '页面未及时完成展示' }
        await sleep()
      }
      return { status: 'pending', commandId: command.commandId, viewId: view.viewId }
    } catch (e) {
      return { status: 'failed', code: e.code ?? 'PRESENTATION_FAILED', error: e.message ?? '页面展示失败；行程已保存', ...(e.openCommandId ? { openCommandId: e.openCommandId } : {}), ...(e.url ? { url: e.url } : {}) }
    }
  }
  return {
    present(name, input, result, open) {
      if (input.presentation?.mode === 'none') return Promise.resolve({ status: 'skipped' })
      const key = JSON.stringify([name, input.requestId, result.tripId, result.revision, input.presentation ?? {}])
      if (!receipts.has(key)) {
        const task = deliver(name, input, result, open)
        receipts.set(key, task)
        if (receipts.size > 1000) receipts.delete(receipts.keys().next().value)
      }
      return receipts.get(key)
    },
  }
}

// ── 计划审查（mcp/planReview.mjs，去掉 zod 依赖） ────────────────────────────
const reviewFail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const isMinutes = (v) => Number.isInteger(v) && v >= 0 && v <= 1440
const isExplanation = (v) => typeof v === 'string' && v.trim().length >= 1 && v.length <= 5000
export function validatePlanReview(days, review) {
  if (!review) reviewFail('PLAN_REVIEW_REQUIRED', 'New apply_plan tasks require review: spatialNotes and one daily time budget per submitted date. Check real visit scope, transport, meals/rest and buffer first; do not bypass this check with lower-level tools.')
  if (typeof review !== 'object' || Array.isArray(review)) reviewFail('INVALID_PLAN_REVIEW', 'review must be an object')
  if (!isExplanation(review.spatialNotes)) reviewFail('INVALID_PLAN_REVIEW', 'spatialNotes: required nonempty string (max 5000)')
  if (!Array.isArray(review.days) || review.days.length < 1 || review.days.length > 366) reviewFail('INVALID_PLAN_REVIEW', 'review.days: required array (1-366)')
  for (const day of review.days) {
    if (!day || typeof day !== 'object') reviewFail('INVALID_PLAN_REVIEW', 'review.days[]: must be objects')
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) reviewFail('INVALID_PLAN_REVIEW', 'review.days[].date: use YYYY-MM-DD')
    if (!Number.isInteger(day.availableMinutes) || day.availableMinutes < 1 || day.availableMinutes > 1440) reviewFail('INVALID_PLAN_REVIEW', `${day.date}: availableMinutes must be 1-1440`)
    for (const k of ['travelMinutes', 'visitMinutes', 'mealRestMinutes', 'bufferMinutes']) if (!isMinutes(day[k])) reviewFail('INVALID_PLAN_REVIEW', `${day.date}: ${k} must be 0-1440`)
    if (!isExplanation(day.basis)) reviewFail('INVALID_PLAN_REVIEW', `${day.date}: basis: required nonempty string (max 5000)`)
  }
  const dates = new Set(days.map((day) => day.date)), reviewed = review.days
  if (reviewed.length !== dates.size || new Set(reviewed.map((day) => day.date)).size !== reviewed.length || reviewed.some((day) => !dates.has(day.date)))
    reviewFail('INVALID_PLAN_REVIEW', 'review.days must cover every submitted plan date exactly once, with no extra dates.')
  for (const day of reviewed) {
    const total = day.travelMinutes + day.visitMinutes + day.mealRestMinutes + day.bufferMinutes
    if (total > day.availableMinutes) reviewFail('PLAN_TIME_EXCEEDED', `${day.date}: travel ${day.travelMinutes} + visits ${day.visitMinutes} + meals/rest ${day.mealRestMinutes} + buffer ${day.bufferMinutes} = ${total} minutes, exceeding the available ${day.availableMinutes}. Reduce or reorder activities and review actual constraints; do not inflate availability, compress unsupported visit times, or bypass with lower-level tools.`)
  }
  return review
}

// ── 计划任务（planTasks.ts，持久化执行日志在 DATA_DIR/agent-plans） ──────────
const stable = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const idPattern = /^plan_[a-f0-9]{32}$/
const safeError = (error) => { const code = typeof error?.code === 'string' ? error.code : 'TASK_FAILED'; return { code, message: ({ VIEW_NOT_CONNECTED: '页面已断开，请恢复页面后重试同一任务', VIEW_NOT_READY: '页面尚未就绪，请恢复页面后重试同一任务', VIEW_FAILED: '页面展示失败，请恢复页面后重试同一任务', REVISION_CONFLICT: '行程已被其他操作修改，请核对后调整计划', TASK_FAILED: '计划执行中断，请恢复页面后重试同一任务' })[code] ?? `计划执行未完成（${code}）` } }

/** Durable task journal: saved data and acknowledged presentation advance independently. */
export function createPlanTaskRunner(options) {
  const directory = path.join(options.directory, 'agent-plans')
  const running = new Map(), locks = new Map()
  const activity = getAgentActivityStore()
  const file = (taskId) => { check(idPattern.test(taskId), 'INVALID_INPUT', 'Invalid task ID'); return path.join(directory, `${taskId}.json`) }
  async function load(taskId) { try { return JSON.parse(await fs.readFile(file(taskId), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return; throw error } }
  async function save(job) { await fs.mkdir(directory, { recursive: true }); job.updatedAt = Date.now(); const target = file(job.taskId), temporary = `${target}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await fs.rename(temporary, target) }
  const summary = (job) => ({ taskId: job.taskId, status: job.status, ...(job.tripId ? { tripId: job.tripId, url: `/trip/${job.tripId}` } : {}), ...(job.revision ? { revision: job.revision } : {}), progress: { completed: job.completed, total: job.total, label: job.label }, ...(job.error ? { error: job.error } : {}), resumable: job.status === 'failed' && isRecoverablePlanError(job.error?.code) })
  async function readTrip(job) { check(job.tripId, 'TRIP_NOT_FOUND', 'Task has no saved trip'); return options.service.execute('get_trip', { tripId: job.tripId }) }
  async function validate(input) {
    const start = date(input.trip.startDate), end = date(input.trip.endDate); dayCount(start, end)
    const days = input.days
    check(Array.isArray(days) && days.length > 0 && days.length <= 366, 'INVALID_INPUT', 'Plan days required')
    check(days.every((d, i) => date(d.date) >= start && d.date <= end && (!i || d.date > days[i - 1].date)), 'INVALID_INPUT', 'Plan dates must be unique, ordered and inside trip range')
    const flat = days.flatMap((d) => d.stops.map((s, position) => ({ ...s, date: d.date, position })))
    check(flat.length > 0 && flat.length <= 100, 'INVALID_INPUT', 'Plan requires 1-100 stops')
    check(flat.every((s) => Boolean(s.candidateId) !== Boolean(s.stopId)), 'INVALID_INPUT', 'Use exactly one of candidateId or stopId per stop')
    const missingTransport = flat.slice(0, -1).find((s) => !s.transportToNext)
    // Build the message only when a stop actually lacks transport: reading `.position` on `undefined` here used to
    // throw a TypeError for every otherwise-valid plan, so apply_plan could never complete.
    if (missingTransport) check(false, 'INVALID_INPUT', `Stop ${missingTransport.position + 1} on ${missingTransport.date} requires transportToNext; every non-final flattened stop (including each day last stop) needs one`)
    check(!flat[flat.length - 1].transportToNext, 'INVALID_INPUT', 'The final flattened stop must not have transportToNext')
    const existingIds = flat.filter((s) => s.stopId).map((s) => s.stopId)
    check(new Set(existingIds).size === existingIds.length, 'INVALID_INPUT', 'Duplicate existing stop')
    if (input.tripId) {
      check(Number.isInteger(input.expectedRevision), 'INVALID_INPUT', 'Existing trip requires expectedRevision')
      const current = await options.service.execute('get_trip', { tripId: input.tripId })
      check(current.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Trip changed before plan execution')
      const ids = new Set(current.trip.stops.map((s) => s.id))
      check(existingIds.every((id) => ids.has(id)), 'STOP_NOT_FOUND', 'Existing stop is not in target trip')
      check(ids.size === existingIds.length, 'PLAN_OMITS_EXISTING_STOPS', 'Include all existing stopIds; remove stops only with explicit low-level deletion')
    } else check(existingIds.length === 0 && !input.expectedRevision, 'INVALID_INPUT', 'New trips require candidate references')
    validatePlanReview(days, input.review)
    // Freeze only server-registered candidates, before long-running visible steps can expire.
    return flat.map((s) => (s.candidateId ? { ...s, place: place(options.resolveCandidate(s.candidateId)) } : s))
  }
  function steps(job) {
    const result = [{ key: 'metadata', label: job.tripId ? '更新行程信息' : '创建行程' }]
    job.stops.forEach((s, i) => result.push({ key: `stop:${i}`, label: `录入地点 ${i + 1}/${job.stops.length}` }))
    job.stops.slice(0, -1).forEach((s, i) => result.push({ key: `transport:${i}`, label: `设置交通 ${i + 1}/${job.stops.length - 1}` }))
    if (job.input.calculateRoutes) result.push({ key: 'routes', label: '计算并展示路线' })
    result.push({ key: 'verify', label: '核验地点顺序和交通' }, { key: 'finish', label: job.input.finish === 'play' && job.stops.length > 1 ? '打开并播放行程' : '展示行程地图' })
    return result
  }
  async function prepare(job, key) {
    const requestId = `${job.taskId}:${key}`
    if (key === 'metadata') return job.input.tripId ? { key, name: 'update_trip', input: { tripId: job.input.tripId, expectedRevision: job.input.expectedRevision, requestId, patch: job.input.trip } } : { key, name: 'create_trip', input: { ...job.input.trip, requestId } }
    const current = await readTrip(job)
    check(current.revision === job.revision, 'REVISION_CONFLICT', 'Trip changed during plan task')
    if (key === 'routes') return { key, name: 'calculate_routes', input: { tripId: job.tripId, expectedRevision: job.revision, requestId } }
    const [kind, rawIndex] = key.split(':'), index = Number(rawIndex), stop = job.stops[index]
    let op
    if (kind === 'stop') {
      const day = current.trip.days.find((d) => d.date === stop.date); check(day, 'INVALID_INPUT', 'Plan day is missing')
      op = stop.stopId ? { op: 'move_stop', stopId: stop.stopId, targetDayId: day.id, position: stop.position } : { op: 'add_stop', dayId: day.id, position: stop.position, place: stop.place }
    } else op = { op: 'set_transport', fromStopId: stop.stopId, toStopId: job.stops[index + 1].stopId, transport: stop.transportToNext }
    return { key, name: 'edit_itinerary', input: { tripId: job.tripId, expectedRevision: job.revision, requestId, operations: [op] } }
  }
  async function verify(job) {
    const { trip, revision } = await readTrip(job); check(revision === job.revision, 'REVISION_CONFLICT', 'Trip changed before verification')
    check(trip.stops.length === job.stops.length && trip.stops.every((s, i) => s.id === job.stops[i].stopId && trip.days.find((d) => d.id === s.dayId)?.date === job.stops[i].date), 'PLAN_VERIFICATION_FAILED', 'Saved stop order does not match plan')
    check(trip.segments.every((s, i) => s.transport === job.stops[i].transportToNext), 'PLAN_VERIFICATION_FAILED', 'Saved transport does not match plan')
  }
  async function run(job) {
    const activityId = activity.start({ viewId: job.input.viewId, kind: 'plan', title: job.input.trip.name, step: { index: job.completed, total: job.total, label: job.label } })
    try {
      if (job.tripId) await options.service.claimPlanTask(job.taskId, job.tripId)
      const sequence = steps(job)
      while (job.completed < sequence.length) {
        const step = sequence[job.completed]; job.label = step.label
        activity.update(activityId, { step: { index: job.completed + 1, total: job.total, label: step.label }, message: step.label })
        await options.assertView(job.input.viewId)
        if (step.key === 'verify') await verify(job)
        else if (step.key === 'finish') {
          await verify(job)
          await options.finish({ tripId: job.tripId, revision: job.revision, viewId: job.input.viewId, finish: job.input.finish, stops: job.stops, base: job.base })
          await verify(job)
        } else {
          if (!job.current) { job.current = await prepare(job, step.key); await save(job) }
          const prepared = job.current
          if (!prepared.saved) {
            // Request ID + immutable prepared arguments make crash-after-commit retries idempotent.
            const result = await options.service.execute(prepared.name, prepared.input, 'web', { retainRequest: true })
            prepared.saved = { tripId: result.tripId, revision: result.revision, ...(result.results ? { results: result.results } : {}), ...(result.routes ? { routes: result.routes } : {}) }
            job.tripId = result.tripId; job.revision = result.revision
            await options.service.claimPlanTask(job.taskId, result.tripId)
            if (step.key.startsWith('stop:')) {
              const stop = job.stops[Number(step.key.split(':')[1])]
              if (!stop.stopId) stop.stopId = result.results.find((r) => r.op === 'add_stop')?.stopId
            }
            await save(job)
          }
          const saved = prepared.saved
          // A different editor must not be overwritten by replaying an old task result.
          const fresh = await readTrip(job); check(fresh.revision === saved.revision, 'REVISION_CONFLICT', 'Trip changed while task display was interrupted')
          await options.present(prepared.name, { ...saved, trip: fresh.trip }, job.input.viewId, `${prepared.input.requestId}:show:${job.attempt}`, job.base)
          if (step.key.startsWith('stop:')) { const stop = job.stops[Number(step.key.split(':')[1])]; if (stop.candidateId) options.adopted?.(stop.candidateId, job.input.viewId) }
        }
        job.completed++; job.current = undefined; await save(job)
      }
      job.status = 'completed'; job.label = '计划已展示'; job.error = undefined; await save(job)
      await options.service.releaseTaskReceipts(job.taskId).catch(() => {})
      activity.update(activityId, { status: 'completed', message: job.label, step: { index: job.total, total: job.total, label: job.label } })
    } catch (error) {
      job.status = 'failed'; job.error = safeError(error); await save(job)
      activity.update(activityId, { status: 'failed', error: job.error.message, message: `停在：${job.label}` })
    } finally {
      if (job.status === 'completed' || (job.status === 'failed' && !isRecoverablePlanError(job.error?.code))) await options.service.releasePlanTask(job.taskId, job.tripId)
    }
  }
  return {
    async apply(raw, base) {
      const input = { ...raw, finish: raw.finish ?? 'play', calculateRoutes: raw.calculateRoutes ?? true }
      const taskId = `plan_${digest(input.requestId).slice(0, 32)}`
      const { viewId: _view, ...identity } = input
      const fingerprint = digest(stable(identity))
      const previous = locks.get(taskId) ?? Promise.resolve()
      const operation = previous.catch(() => {}).then(async () => {
        let job = await load(taskId)
        if (job) check(job.fingerprint === fingerprint, 'REQUEST_ID_REUSED', 'Use the same confirmed plan to resume')
        if (job && running.has(taskId)) return summary(job)
        if (job?.status === 'completed') { await options.service.releasePlanTask(job.taskId, job.tripId); await options.service.releaseTaskReceipts(job.taskId).catch(() => {}); return summary(job) }
        await options.assertView(input.viewId)
        if (!job) { const stops = await validate(input); job = { taskId, fingerprint, input, base, status: 'running', tripId: input.tripId, revision: input.expectedRevision, stops, completed: 0, total: 0, label: '准备执行', attempt: 0, updatedAt: Date.now() }; job.total = steps(job).length }
        job.input.viewId = input.viewId; job.status = 'running'; job.error = undefined; job.attempt++; await save(job)
        const task = run(job).finally(() => running.delete(taskId)); running.set(taskId, task); void task.catch(() => {})
        return summary(job)
      })
      locks.set(taskId, operation)
      try { return await operation } finally { if (locks.get(taskId) === operation) locks.delete(taskId) }
    },
    async get(taskId, waitMs = 15000) {
      check(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 20000, 'INVALID_INPUT', 'waitMs must be 0-20000')
      let job = await load(taskId); check(job, 'TASK_NOT_FOUND', 'Plan task not found')
      const task = running.get(taskId)
      if (task && waitMs) { let timer; await Promise.race([task, new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })]); if (timer) clearTimeout(timer); job = await load(taskId) }
      if (job.status === 'running' && !running.has(taskId)) {
        const previous = locks.get(taskId) ?? Promise.resolve()
        const transition = previous.catch(() => {}).then(async () => {
          const fresh = await load(taskId)
          if (fresh.status === 'running' && !running.has(taskId)) { fresh.status = 'failed'; fresh.error = { code: 'TASK_INTERRUPTED', message: '服务重启中断了任务，请用相同 requestId 和计划恢复' }; await save(fresh) }
          return summary(fresh)
        })
        locks.set(taskId, transition)
        try { return await transition } finally { if (locks.get(taskId) === transition) locks.delete(taskId) }
      }
      return summary(job)
    },
  }
}

// ── 工具分发（toolDispatcher.ts） ────────────────────────────────────────────
export function createToolDispatcher(options) {
  const { service, registry, placeSearch, weather } = options
  // DSH 插件形态没有可启动的独立应用窗口；无连接视图时 open 走 launch 并失败提示。
  const launch = options.launch ?? (async () => { throw new Error('no standalone app') })
  const navigator = createAppNavigator({ registry, launch })
  const presenter = createMutationPresenter({ registry })

  // 当前正在查看的行程（用户对着页面说话时「这个行程」的指向）：
  // 聚焦的 > 可见的 > 任意已连接的带行程视图
  const activeView = () => {
    const views = registry.list().filter((v) => v.tripId)
    return views.find((v) => v.focused) ?? views.find((v) => v.visibility === 'visible') ?? views[0]
  }
  const activeTripId = () => activeView()?.tripId

  // tripId/expectedRevision 可省略：默认取用户正在查看的行程及其当前版本
  async function resolveTripRef(name, input) {
    const out = { ...input }
    if (out.tripId === undefined) {
      const id = activeTripId()
      check(id, 'NO_ACTIVE_TRIP', 'No trip specified and no trip is open in the travel panel; pass tripId or ask the user to open one')
      out.tripId = id
    }
    if (out.expectedRevision === undefined && ['update_trip', 'edit_itinerary', 'delete_trip', 'calculate_routes'].includes(name)) {
      const { revision } = await service.execute('get_trip', { tripId: out.tripId })
      out.expectedRevision = revision
    }
    return out
  }

  const requireReadyView = (viewId) => {
    const view = registry.list().find((v) => v.viewId === viewId)
    check(view, 'VIEW_NOT_CONNECTED', 'Target page is not connected')
    check(view.ready && view.mapState?.status !== 'failed', 'VIEW_NOT_READY', 'Target page is not ready')
  }
  async function waitCommand(receipt) {
    let current = receipt
    while (true) {
      if (current.status === 'completed') return current
      check(!['failed', 'expired'].includes(current.status), 'VIEW_FAILED', String(current.error || 'Page did not acknowledge the command'))
      check(Date.now() < Number(current.expiresAt), 'VIEW_FAILED', 'Page command expired')
      await new Promise((resolve) => setTimeout(resolve, 150))
      current = navigator.getCommand(current.commandId)
    }
  }
  async function waitReadyView(viewId, tripId, page) {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const view = registry.list().find((v) => v.viewId === viewId)
      check(view, 'VIEW_NOT_CONNECTED', 'Target page disconnected')
      check(view.mapState?.status !== 'failed', 'VIEW_FAILED', 'Target map failed')
      if (view.tripId === tripId && view.page === page && view.ready) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new TravelError('VIEW_NOT_READY', 'Target page did not publish readiness')
  }
  const planTasks = createPlanTaskRunner({
    directory: service.directory, service, assertView: requireReadyView, resolveCandidate: options.resolveCandidate, adopted: options.markCandidateAdopted,
    present: async (name, result, viewId, requestId, base) => {
      const shown = await presenter.present(name, { requestId, presentation: { viewId } }, result, async () => dispatch('open_trip', { tripId: result.tripId, page: 'plan', viewId }, base))
      if (shown.status === 'pending' && shown.commandId) { await waitCommand(navigator.getCommand(shown.commandId)); await waitReadyView(viewId, result.tripId, 'plan'); return }
      check(shown.status === 'completed', shown.code || 'VIEW_FAILED', shown.error || 'Page did not present saved changes')
      await waitReadyView(viewId, result.tripId, 'plan')
    },
    finish: async (job) => {
      requireReadyView(job.viewId)
      const page = job.finish === 'play' && job.stops.length > 1 ? 'play' : 'plan'
      await waitCommand(await dispatch('open_trip', { tripId: job.tripId, page, viewId: job.viewId }, job.base))
      await waitReadyView(job.viewId, job.tripId, page)
      if (page === 'play') await waitCommand(await dispatch('control_view', { viewId: job.viewId, action: 'play' }, job.base))
    },
  })
  // base 仅用于生成返回给模型的 URL 字符串；面板内地址用伪源。
  const BASE = 'http://travel-agent.panel'
  const urlFor = (tripId, page = 'plan') => new URL(`/trip/${encodeURIComponent(tripId)}${page === 'play' ? '/play' : ''}`, BASE).toString()
  async function dispatch(name, args) {
    let input = validateTool(name, args)
    if (['get_trip', 'update_trip', 'edit_itinerary', 'delete_trip', 'calculate_routes', 'open_trip'].includes(name)) input = await resolveTripRef(name, input)
    if (name === 'ensure_service') return { status: 'running', url: BASE, launched: false }
    if (name === 'get_status')
      return { version: '0.3.0', search: placeSearch.getSearchStatus(), connectedViews: registry.list().length, url: BASE, views: registry.list(), capabilities: { planReview: true, planTasks: true, searchActivity: true, manualEditing: true, mcp: false, dsh: true, visibleEdits: true, singleWindow: true, pages: ['plan', 'play'], playback: ['play', 'restart', 'stop'], videoExportViaMcp: false, weather: 'open-meteo' } }
    if (name === 'get_weather') return weather.getForecast(input)
    if (name === 'apply_plan') return planTasks.apply(input, BASE)
    if (name === 'get_plan_task') return planTasks.get(input.taskId, input.waitMs ?? 15000)
    if (name === 'search_places') {
      const view = registry.list().length || input.viewId ? chooseAppView(registry, { tripId: '', page: 'plan', viewId: input.viewId }) : undefined
      const { viewId: _viewId, ...query } = input
      return placeSearch.searchForAgent(query, { viewId: view?.viewId })
    }
    if (name === 'get_view_state') {
      const views = registry.list().filter((v) => !input.viewId || v.viewId === input.viewId)
      if (input.viewId) check(views.length, 'VIEW_NOT_CONNECTED', 'Requested page is not connected')
      return { views }
    }
    if (name === 'get_command') return navigator.getCommand(input.commandId)
    if (name === 'control_view') {
      const view = registry.list().find((v) => v.viewId === input.viewId)
      check(view, 'VIEW_NOT_CONNECTED', 'Page is not connected')
      const { trip } = await service.execute('get_trip', { tripId: view.tripId })
      const args = {}
      if (input.action === 'show_day') {
        check(trip.days.some((d) => d.id === input.dayId), 'DAY_NOT_FOUND', 'Day not found')
        args.dayId = input.dayId
      }
      if (input.action === 'focus_stop') {
        check(trip.stops.some((s) => s.id === input.stopId), 'STOP_NOT_FOUND', 'Stop not found')
        args.stopId = input.stopId
      }
      check(!input.dayId || input.action === 'show_day', 'INVALID_INPUT', 'dayId is only accepted for show_day')
      check(!input.stopId || input.action === 'focus_stop', 'INVALID_INPUT', 'stopId is only accepted for focus_stop')
      return registry.enqueue(input.viewId, input.action, args)
    }
    if (name === 'open_trip') {
      const { trip } = await service.execute('get_trip', { tripId: input.tripId })
      if (input.dayId) check(trip.days.some((d) => d.id === input.dayId), 'DAY_NOT_FOUND', 'Day not found')
      if (input.stopId) check(trip.stops.some((s) => s.id === input.stopId), 'STOP_NOT_FOUND', 'Stop not found')
      check(!(input.dayId && input.stopId), 'INVALID_INPUT', 'Choose dayId or stopId')
      return navigator.open({ tripId: input.tripId, page: input.page ?? 'plan', ...(input.viewId ? { viewId: input.viewId } : {}), ...(input.stopId ? { stopId: input.stopId } : {}), ...(input.dayId ? { dayId: input.dayId } : {}) }, BASE)
    }
    const { presentation: _presentation, ...dataInput } = input
    const result = await service.execute(name, dataInput, 'agent')
    if (['create_trip', 'update_trip', 'edit_itinerary', 'calculate_routes'].includes(name)) {
      result.presentation = await presenter.present(name, input, result, async () => dispatch('open_trip', { tripId: result.tripId, page: 'plan', ...(input.presentation?.viewId ? { viewId: input.presentation.viewId } : {}) }))
    }
    if (name === 'edit_itinerary') for (const op of input.operations) { if (op.candidateId) options.markCandidateAdopted(op.candidateId, input.presentation?.viewId ?? result.presentation?.viewId) }
    if (name === 'delete_trip') result.presentation = { status: 'skipped' }
    if (result.trip) {
      result.trip = { ...result.trip, segments: result.trip.segments.map(({ route, ...segment }) => ({ ...segment, hasGeometry: !!route })) }
      result.url = urlFor(result.tripId)
    }
    if (name === 'list_trips') result.trips = result.trips.map((t) => ({ ...t, url: urlFor(t.id) }))
    return result
  }
  return dispatch
}

// ── 工具入参校验（mcp/tools.mjs 的无 zod 移植） ──────────────────────────────
const tId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200
const tDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const TRANSPORTS = ['car', 'bus', 'train', 'subway', 'plane', 'ship', 'kayak', 'motorcycle', 'bicycle', 'scooter', 'walk', 'horse', 'ufo', 'swim', 'rocket']
function invalid(msg) { throw new TravelError('INVALID_INPUT', msg) }
function validateTool(name, args) {
  const a = args ?? {}
  if (typeof a !== 'object' || Array.isArray(a)) invalid('arguments must be an object')
  const req = (cond, msg) => { if (!cond) invalid(msg) }
  switch (name) {
    case 'ensure_service': case 'get_status': return {}
    case 'get_weather': {
      const hasCoords = a.latitude !== undefined || a.longitude !== undefined
      req(hasCoords ? (Number.isFinite(a.latitude) && Math.abs(a.latitude) <= 90 && Number.isFinite(a.longitude) && Math.abs(a.longitude) <= 180) : (typeof a.city === 'string' && a.city.trim().length >= 1 && a.city.length <= 200), 'provide latitude+longitude or city (max 200)')
      req(tDate(a.startDate) && tDate(a.endDate) && a.startDate <= a.endDate, 'startDate/endDate: YYYY-MM-DD, start <= end')
      req((Date.parse(a.endDate) - Date.parse(a.startDate)) / 86400000 < 16, 'date range: max 16 days')
      return a
    }
    case 'list_trips':
      req(a.query === undefined || (typeof a.query === 'string' && a.query.length <= 200), 'query: string (max 200)')
      req(a.limit === undefined || (Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 100), 'limit: integer 1-100')
      req(a.cursor === undefined || typeof a.cursor === 'string', 'cursor: string')
      return a
    case 'get_trip': req(a.tripId === undefined || tId(a.tripId), 'tripId: string (省略 = 用户当前查看的行程)'); return a
    case 'get_plan_task':
      req(tId(a.taskId), 'taskId required')
      req(a.waitMs === undefined || (Number.isInteger(a.waitMs) && a.waitMs >= 0 && a.waitMs <= 20000), 'waitMs: integer 0-20000')
      return a
    case 'search_places': {
      req(typeof a.query === 'string' && a.query.trim().length >= 1 && a.query.length <= 500, 'query required (max 500)')
      req(a.countryCode === undefined || (typeof a.countryCode === 'string' && /^[A-Za-z]{2}$/.test(a.countryCode)), 'countryCode: 2 letters')
      req(a.city === undefined || (typeof a.city === 'string' && a.city.length <= 200), 'city: string (max 200)')
      req(a.language === undefined || (typeof a.language === 'string' && a.language.length <= 100), 'language: string (max 100)')
      req(a.near === undefined || (a.near && typeof a.near === 'object' && Number.isFinite(a.near.latitude) && Math.abs(a.near.latitude) <= 90 && Number.isFinite(a.near.longitude) && Math.abs(a.near.longitude) <= 180), 'near: {latitude, longitude}')
      req(a.limit === undefined || (Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 20), 'limit: integer 1-20')
      req(a.viewId === undefined || tId(a.viewId), 'viewId: string')
      return a
    }
    case 'create_trip': {
      req(typeof a.name === 'string' && a.name.trim().length >= 1 && a.name.length <= 200, 'name required (max 200)')
      req(tDate(a.startDate) && tDate(a.endDate), 'startDate/endDate: YYYY-MM-DD')
      for (const k of ['origin', 'region', 'description']) req(a[k] === undefined || (typeof a[k] === 'string' && a[k].length <= 5000), `${k}: string (max 5000)`)
      req(tId(a.requestId), 'requestId required')
      validatePresentation(a.presentation)
      return a
    }
    case 'update_trip': {
      validateMutation(a)
      req(a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch), 'patch required')
      return a
    }
    case 'delete_trip': validateMutation(a); return a
    case 'calculate_routes': {
      validateMutation(a)
      req(a.segmentIds === undefined || (Array.isArray(a.segmentIds) && a.segmentIds.length >= 1 && a.segmentIds.length <= 100 && a.segmentIds.every(tId)), 'segmentIds: 1-100 ids')
      return a
    }
    case 'edit_itinerary': {
      validateMutation(a)
      req(Array.isArray(a.operations) && a.operations.length >= 1 && a.operations.length <= 100, 'operations: 1-100 items')
      for (const op of a.operations) validateOperation(op)
      return a
    }
    case 'open_trip': {
      req(a.tripId === undefined || tId(a.tripId), 'tripId: string（省略 = 用户当前查看的行程）')
      req(a.viewId === undefined || tId(a.viewId), 'viewId: string')
      req(a.page === undefined || ['plan', 'play'].includes(a.page), 'page: plan|play')
      req(a.dayId === undefined || tId(a.dayId), 'dayId: string')
      req(a.stopId === undefined || tId(a.stopId), 'stopId: string')
      return a
    }
    case 'get_view_state': req(a.viewId === undefined || tId(a.viewId), 'viewId: string'); return a
    case 'control_view': {
      req(tId(a.viewId), 'viewId required')
      req(['show_day', 'focus_stop', 'fit_trip', 'play', 'restart', 'stop'].includes(a.action), 'action: show_day|focus_stop|fit_trip|play|restart|stop')
      req(a.dayId === undefined || tId(a.dayId), 'dayId: string')
      req(a.stopId === undefined || tId(a.stopId), 'stopId: string')
      return a
    }
    case 'get_command': req(tId(a.commandId), 'commandId required'); return a
    case 'apply_plan': {
      req(tId(a.requestId), 'requestId required')
      req(tId(a.viewId), 'viewId required (a connected, ready plan/play page; see get_view_state)')
      req(a.tripId === undefined || tId(a.tripId), 'tripId: string')
      req(a.expectedRevision === undefined || (Number.isInteger(a.expectedRevision) && a.expectedRevision >= 1), 'expectedRevision: positive integer')
      const t = a.trip
      req(t && typeof t === 'object', 'trip required')
      req(typeof t.name === 'string' && t.name.trim().length >= 1 && t.name.length <= 200, 'trip.name required (max 200)')
      req(tDate(t.startDate) && tDate(t.endDate), 'trip.startDate/endDate: YYYY-MM-DD')
      for (const k of ['origin', 'region', 'description']) req(t[k] === undefined || (typeof t[k] === 'string' && t[k].length <= 5000), `trip.${k}: string (max 5000)`)
      req(Array.isArray(a.days) && a.days.length >= 1 && a.days.length <= 366, 'days: 1-366 items')
      for (const d of a.days) {
        req(d && typeof d === 'object' && tDate(d.date), 'days[].date: YYYY-MM-DD')
        req(Array.isArray(d.stops) && d.stops.length <= 100, 'days[].stops: array (max 100)')
        for (const s of d.stops) {
          req(s && typeof s === 'object' && (tId(s.candidateId) || tId(s.stopId)) && !(s.candidateId && s.stopId), 'days[].stops[]: choose candidateId or stopId')
          req(s.transportToNext === undefined || TRANSPORTS.includes(s.transportToNext), 'days[].stops[].transportToNext: invalid transport')
        }
      }
      req(a.finish === undefined || ['plan', 'play'].includes(a.finish), 'finish: plan|play')
      req(a.calculateRoutes === undefined || typeof a.calculateRoutes === 'boolean', 'calculateRoutes: boolean')
      return a
    }
    default: throw new TravelError('UNKNOWN_TOOL', 'Unknown tool')
  }
}
function validatePresentation(p) {
  if (p === undefined) return
  if (!p || typeof p !== 'object' || Array.isArray(p)) invalid('presentation: object')
  if (p.mode !== undefined && !['auto', 'none'].includes(p.mode)) invalid('presentation.mode: auto|none')
  if (p.viewId !== undefined && !tId(p.viewId)) invalid('presentation.viewId: string')
}
function validateMutation(a) {
  if (a.tripId !== undefined && !tId(a.tripId)) invalid('tripId: string')
  if (a.expectedRevision !== undefined && (!Number.isInteger(a.expectedRevision) || a.expectedRevision < 1)) invalid('expectedRevision: latest revision from get_trip（可省略 = 当前版本）')
  if (!tId(a.requestId)) invalid('requestId required')
  validatePresentation(a.presentation)
}
function validateOperation(op) {
  if (!op || typeof op !== 'object') invalid('operation must be an object')
  const pos = (v, required) => { if (v === undefined) { if (required) invalid('position required'); return } if (!Number.isInteger(v) || v < 0) invalid('position: non-negative integer') }
  switch (op.op) {
    case 'add_day': pos(op.position); break
    case 'remove_day':
      if (!tId(op.dayId)) invalid('remove_day: dayId required')
      if (op.stopHandling !== undefined && !['delete', 'move'].includes(op.stopHandling)) invalid('stopHandling: delete|move')
      if (op.targetDayId !== undefined && !tId(op.targetDayId)) invalid('targetDayId: string')
      break
    case 'add_stop':
      if (!tId(op.dayId)) invalid('add_stop: dayId required')
      if (!tId(op.candidateId)) invalid('add_stop: candidateId required (from search_places)')
      pos(op.position)
      if (op.clientRef !== undefined && !tId(op.clientRef)) invalid('clientRef: string')
      break
    case 'update_stop':
      if (!tId(op.stopId)) invalid('update_stop: stopId required')
      if (op.candidateId !== undefined && !tId(op.candidateId)) invalid('candidateId: string')
      if (op.patch !== undefined) {
        if (!op.patch || typeof op.patch !== 'object' || Array.isArray(op.patch)) invalid('patch: object')
        if (op.patch.name !== undefined && (typeof op.patch.name !== 'string' || !op.patch.name.trim() || op.patch.name.length > 300)) invalid('patch.name: nonempty string (max 300)')
        for (const k of ['city', 'country']) if (op.patch[k] !== undefined && (typeof op.patch[k] !== 'string' || op.patch[k].length > 500)) invalid(`patch.${k}: string (max 500)`)
      }
      break
    case 'remove_stop': if (!tId(op.stopId)) invalid('remove_stop: stopId required'); break
    case 'move_stop':
      if (!tId(op.stopId) || !tId(op.targetDayId)) invalid('move_stop: stopId and targetDayId required')
      pos(op.position, true)
      break
    case 'set_transport':
      if (!tId(op.fromStopId) || !tId(op.toStopId)) invalid('set_transport: fromStopId and toStopId required')
      if (!TRANSPORTS.includes(op.transport)) invalid('set_transport: invalid transport')
      break
    case 'set_weather': {
      if (!tId(op.dayId)) invalid('set_weather: dayId required')
      if (op.weather === null) break // null = 清除当天天气
      const w = op.weather
      if (!w || typeof w !== 'object' || Array.isArray(w)) invalid('set_weather: weather must be an object or null')
      if (typeof w.label !== 'string' || !w.label.trim() || w.label.length > 100) invalid('set_weather: weather.label required (max 100)')
      for (const k of ['low', 'high']) if (w[k] !== undefined && (typeof w[k] !== 'number' || !Number.isFinite(w[k]))) invalid(`set_weather: weather.${k} must be a number`)
      if (w.effect !== undefined && !['sun', 'cloud', 'overcast', 'fog', 'drizzle', 'rain', 'heavy-rain', 'snow', 'heavy-snow', 'breeze', 'wind', 'storm'].includes(w.effect)) invalid('set_weather: invalid effect')
      break
    }
    default: invalid(`unknown operation ${op.op}`)
  }
}

// ── DSH 工具注册 ─────────────────────────────────────────────────────────────
const S = {
  id: { type: 'string', description: 'ID（1-200 字符）' },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' },
  requestId: { type: 'string', description: 'Unique mutation ID. Reuse exactly the same ID and arguments for retries; keep IDs unique across tools.' },
  presentation: {
    type: 'object',
    description: 'Browser presentation is automatic by default. Set mode:none only for intentional background work; use viewId to select among multiple application windows.',
    properties: { mode: { type: 'string', enum: ['auto', 'none'] }, viewId: { type: 'string' } },
  },
  expectedRevision: { type: 'integer', description: 'Latest revision from get_trip. Reload after REVISION_CONFLICT.' },
  transport: { type: 'string', enum: TRANSPORTS },
}
const mutationProps = { tripId: S.id, expectedRevision: S.expectedRevision, requestId: S.requestId, presentation: S.presentation }
const opSchema = {
  type: 'array', minItems: 1, maxItems: 100,
  description: 'Itinerary operations, applied atomically in order.',
  items: {
    type: 'object',
    description: 'One of: {op:add_day, position?} | {op:remove_day, dayId, stopHandling?: delete|move, targetDayId?} | {op:add_stop, dayId, candidateId, position?, clientRef?} | {op:update_stop, stopId, candidateId?, patch?{name?,city?,country?}} | {op:remove_stop, stopId} | {op:move_stop, stopId, targetDayId, position} | {op:set_transport, fromStopId, toStopId, transport} | {op:set_weather, dayId, weather: {label, low?, high?, effect?} | null}',
    properties: {
      op: { type: 'string', enum: ['add_day', 'remove_day', 'add_stop', 'update_stop', 'remove_stop', 'move_stop', 'set_transport', 'set_weather'] },
      dayId: S.id, targetDayId: S.id, stopId: S.id, fromStopId: S.id, toStopId: S.id, candidateId: S.id, clientRef: S.id,
      position: { type: 'integer', minimum: 0 },
      stopHandling: { type: 'string', enum: ['delete', 'move'] },
      transport: S.transport,
      patch: { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' } } },
      weather: { type: ['object', 'null'], description: '当日天气：label 必填（如「晴转多云」），low/high 为摄氏气温，effect 供地图特效：sun/cloud/overcast/fog/drizzle/rain/heavy-rain/snow/heavy-snow/breeze/wind/storm；null 清除', properties: { label: { type: 'string' }, low: { type: 'number' }, high: { type: 'number' }, effect: { type: 'string', enum: ['sun', 'cloud', 'overcast', 'fog', 'drizzle', 'rain', 'heavy-rain', 'snow', 'heavy-snow', 'breeze', 'wind', 'storm'] } } },
    },
    required: ['op'],
  },
}
const planStopSchema = {
  type: 'object',
  description: 'Choose exactly one of candidateId (from search_places) or existing stopId. transportToNext required on every non-final flattened stop.',
  properties: { candidateId: S.id, stopId: S.id, transportToNext: S.transport },
}
const reviewSchema = {
  type: 'object',
  description: 'Required for every NEW task: geographical rationale and complete daily time budgets with duration/scope evidence.',
  properties: {
    spatialNotes: { type: 'string', description: 'Explain geographical grouping and any necessary returns due to lodging, reservations or weather. Do not invent constraints.' },
    days: {
      type: 'array', minItems: 1, maxItems: 366,
      items: {
        type: 'object',
        properties: {
          date: S.date,
          availableMinutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Real usable day window, respecting departure/return constraints. Count each transport segment once.' },
          travelMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          visitMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          mealRestMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          bufferMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          basis: { type: 'string', description: 'Summarize day window, visit scope and duration sources, transfers/queues and which values are estimates. A place coordinate is not a visit duration.' },
        },
        required: ['date', 'availableMinutes', 'travelMinutes', 'visitMinutes', 'mealRestMinutes', 'bufferMinutes', 'basis'],
      },
    },
  },
  required: ['spatialNotes', 'days'],
}
export const TOOL_DEFS = [
  { name: 'apply_plan', timeoutMs: 60000, description: 'Submit one feasible confirmed plan using valid candidateIds or existing stopIds. NEW tasks require review with geographical grouping/necessary-return rationale and a time budget for every submitted date: availableMinutes, travelMinutes, visitMinutes, mealRestMinutes, bufferMinutes, basis. Check actual visit scope and sources before estimating; coordinates and driving durations do not establish visit duration. Overfull days are rejected before writing. Requires an already-rendered ready viewId. The server freezes candidates, journals steps, waits for visible acknowledgements, calculates routes and optionally plays. Use get_plan_task with long wait. Resume with the same requestId and unchanged plan; only viewId may change. Existing trips require expectedRevision and all existing stopIds. Provide transportToNext on every non-final flattened stop. Do not fall back to low-level tools after review or version errors.', parameters: { type: 'object', properties: { requestId: S.requestId, viewId: { type: 'string', description: 'A connected, already-rendered ready viewId (see get_view_state)' }, tripId: S.id, expectedRevision: S.expectedRevision, trip: { type: 'object', properties: { name: { type: 'string' }, startDate: S.date, endDate: S.date, origin: { type: 'string' }, region: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'startDate', 'endDate'] }, days: { type: 'array', minItems: 1, maxItems: 366, items: { type: 'object', properties: { date: S.date, stops: { type: 'array', maxItems: 100, items: planStopSchema } }, required: ['date', 'stops'] } }, review: reviewSchema, finish: { type: 'string', enum: ['plan', 'play'] }, calculateRoutes: { type: 'boolean' } }, required: ['requestId', 'viewId', 'trip', 'days'] } },
  { name: 'get_plan_task', timeoutMs: 30000, readOnly: true, description: 'Read compact plan task progress, optionally wait up to 20 seconds for completion. Prefer waitMs=15000 over repeated short polls. On recoverable failure restore the page and resubmit apply_plan with the same requestId and plan, not a new trip.', parameters: { type: 'object', properties: { taskId: S.id, waitMs: { type: 'integer', minimum: 0, maximum: 20000 } }, required: ['taskId'] } },
  { name: 'ensure_service', timeoutMs: 10000, description: 'Ensure the travel panel service is running. In the DSH plugin form the service is always available; returns the panel URL. If views are needed, ask the user to open the 「🧳 旅行计划」 panel in the DSH page.', parameters: { type: 'object', properties: {} } },
  { name: 'get_status', timeoutMs: 10000, readOnly: true, description: 'First call: check running app URL, search providers, capabilities, connected views and bridge compatibility. Do not fall back to lower-level writes or browser forms. compatible confirms protocol support, not itinerary feasibility.', parameters: { type: 'object', properties: {} } },
  { name: 'get_weather', timeoutMs: 20000, readOnly: true, description: 'Daily weather forecast (Open-Meteo, no key needed). Prefer latitude/longitude from search_places candidates; city name works when search keys are configured. Covers roughly the past 7 days through 16 days ahead; out-of-range dates are truncated with a note or rejected with OUT_OF_FORECAST_RANGE. Each day returns label/low/high/effect ready for edit_itinerary set_weather, plus precipitation and wind. This forecast does not replace official severe-weather warnings; verify those via web sources.', parameters: { type: 'object', properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, city: { type: 'string', description: 'City name, geocoded via the search providers; coordinates are more reliable' }, startDate: S.date, endDate: S.date }, required: ['startDate', 'endDate'] } },
  { name: 'list_trips', timeoutMs: 10000, readOnly: true, description: 'List trip summaries with opaque pagination cursor.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } } } },
  { name: 'get_trip', timeoutMs: 10000, readOnly: true, description: 'Read current trip, days, stops, route summaries, media metadata, revision and URL. Route geometry excluded. tripId 可省略：默认读取用户当前在旅行面板里查看的行程。', parameters: { type: 'object', properties: { tripId: S.id } } },
  { name: 'search_places', timeoutMs: 30000, readOnly: true, description: 'Search real places. Use trip country/city context. If Chinese query yields insufficient matches, retry English, local names or aliases. Compare address, country, type and coordinates; never assume the first candidate is correct. Select clearly matching candidate; ask the user if ambiguous. Search failures are not evidence a place does not exist. city is a search hint for LocationIQ, not an exact boundary filter. Candidate IDs expire. Reuse valid candidates instead of repeating searches. Set viewId to show live search inputs/results in that connected page.', parameters: { type: 'object', properties: { query: { type: 'string' }, countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$' }, city: { type: 'string' }, language: { type: 'string' }, near: { type: 'object', properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 } } }, limit: { type: 'integer', minimum: 1, maximum: 20 }, viewId: S.id }, required: ['query'] } },
  { name: 'create_trip', timeoutMs: 90000, description: 'Create a trip and one day for every date in the inclusive date range (max 366 days). Automatically opens and presents the trip unless presentation.mode is none.', parameters: { type: 'object', properties: { name: { type: 'string' }, startDate: S.date, endDate: S.date, origin: { type: 'string' }, region: { type: 'string' }, description: { type: 'string' }, requestId: S.requestId, presentation: S.presentation }, required: ['name', 'startDate', 'endDate', 'requestId'] } },
  { name: 'update_trip', timeoutMs: 90000, description: 'tripId/expectedRevision 可省略：默认修改用户当前查看的行程。Edit trip metadata/dates. Moving startDate alone shifts all days. Shortening occupied days fails; move/remove their stops first. Automatically presents the change in the browser.', parameters: { type: 'object', properties: { ...mutationProps, patch: { type: 'object', properties: { name: { type: 'string' }, origin: { type: 'string' }, region: { type: 'string' }, description: { type: 'string' }, startDate: S.date, endDate: S.date, isPublic: { type: 'boolean' } } } }, required: ['requestId', 'patch'] } },
  { name: 'edit_itinerary', timeoutMs: 90000, description: 'tripId/expectedRevision 可省略：默认修改用户当前正在查看的行程及其最新版本。Apply 1-100 operations atomically. Use search candidateId to add/replace places, never invent coordinates. Position is zero-based within a day; omitted means append. clientRef references a newly added stop later in this batch. Changing endpoints/transport invalidates routes. Removing an occupied day requires stopHandling. Automatically opens/reuses the trip page, synchronizes its revision and focuses the changed stop/day. Check presentation.status; a presentation failure does not undo saved data and should not trigger another data mutation.', parameters: { type: 'object', properties: { ...mutationProps, operations: opSchema }, required: ['requestId', 'operations'] } },
  { name: 'delete_trip', timeoutMs: 30000, description: 'tripId/expectedRevision 可省略：默认删除用户当前查看的行程（务必先确认）。Delete a trip after explicit user intent to delete it. Media files are retained.', parameters: { type: 'object', properties: mutationProps, required: ['requestId'] } },
  { name: 'calculate_routes', timeoutMs: 120000, description: 'tripId/expectedRevision 可省略：默认作用于用户当前查看的行程。Calculate and persist requested segments (or all segments). Read quality and warnings: unsupported modes have no duration; flights/water connections are illustrative, not schedules. Geometry stays in the app. Automatically presents updated routes unless presentation.mode is none.', parameters: { type: 'object', properties: { ...mutationProps, segmentIds: { type: 'array', minItems: 1, maxItems: 100, items: S.id } }, required: ['requestId'] } },
  { name: 'open_trip', timeoutMs: 60000, description: 'tripId 可省略：默认操作用户当前查看的行程。Navigate the connected application window to a trip, reusing its current window across pages. Launch the application only if none is connected. Specify viewId if multiple windows exist. Query get_command for readiness; browser foreground focus is best effort.', parameters: { type: 'object', properties: { tripId: S.id, viewId: S.id, page: { type: 'string', enum: ['plan', 'play'] }, dayId: S.id, stopId: S.id }, } },
  { name: 'get_view_state', timeoutMs: 10000, readOnly: true, description: 'List connected application windows, current routes, map readiness, selection and playback state. Use viewId to target a specific window.', parameters: { type: 'object', properties: { viewId: S.id } } },
  { name: 'control_view', timeoutMs: 30000, description: 'Control a connected ready page. show_day/focus_stop/fit_trip work on plan and play pages; play/restart/stop require a play page. Returns a receipt, not execution success; query get_command. No pause/resume.', parameters: { type: 'object', properties: { viewId: S.id, action: { type: 'string', enum: ['show_day', 'focus_stop', 'fit_trip', 'play', 'restart', 'stop'] }, dayId: S.id, stopId: S.id }, required: ['viewId', 'action'] } },
  { name: 'get_command', timeoutMs: 10000, readOnly: true, description: 'Read browser-open or page-command receipt. completed means page acknowledged execution/connection; expired means no timely confirmation.', parameters: { type: 'object', properties: { commandId: S.id }, required: ['commandId'] } },
]

// DSH 以 lossless JSON 快照校验每个工具结果：树中任一 undefined 属性或非有限数
// 都会让整条结果被判为非法（"value is not lossless JSON"）。搜索上下文、候选地点
// 和行程字段都带可选属性（如 country/language/near），因此在工具边界统一剥离，
// 而不是指望每个返回点各自记得。
function losslessToolValue(value) {
  if (Array.isArray(value)) return value.map((item) => losslessToolValue(item))
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = losslessToolValue(item)
    return out
  }
  return value
}

export function registerAgentTools(ctx, dispatch) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return false
  for (const def of TOOL_DEFS) {
    tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: { schema: {}, render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => def.readOnly === true,
      timeoutMs: def.timeoutMs,
      async execute(args) {
        try {
          return losslessToolValue(await dispatch(def.name, args ?? {}))
        } catch (e) {
          const code = e && typeof e.code === 'string' ? e.code : 'ERROR'
          throw new Error(`${code}: ${e && e.message ? e.message : String(e)}`)
        }
      },
    })
  }
  return true
}
