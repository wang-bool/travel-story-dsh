// 搜索候选登记 + agent 搜索活动（移植自原项目 lib/server/placeSearch.ts + agentActivity.ts）
// 候选在进程内登记并随搜索缓存过期；edit_itinerary/apply_plan 用 candidateId 换回坐标。
import { randomUUID } from 'node:crypto'

// ── agent 活动流（agent-events SSE 的数据源） ────────────────────────────────
export const validActivityViewId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
export function createAgentActivityStore() {
  const views = new Map()
  const listeners = new Map()
  const emit = (viewId) => { for (const callback of listeners.get(viewId) ?? []) { try { callback() } catch {} } }
  return {
    start(input) {
      if (!validActivityViewId(input.viewId)) throw new Error('Invalid activity view')
      if (!views.has(input.viewId) && views.size >= 64) {
        const oldest = [...views.keys()].find((key) => !listeners.get(key)?.size)
        if (oldest) views.delete(oldest)
      }
      const now = Date.now()
      const record = { ...structuredClone(input), id: randomUUID(), status: 'running', startedAt: now, updatedAt: now }
      views.set(input.viewId, [...(views.get(input.viewId) ?? []), record].slice(-30))
      emit(input.viewId)
      return record.id
    },
    update(id, patch) {
      for (const [viewId, records] of views) {
        const record = records.find((item) => item.id === id)
        if (!record) continue
        const durationMs = record.durationMs ?? (patch.status && patch.status !== 'running' ? Math.max(0, Date.now() - record.startedAt) : undefined)
        Object.assign(record, structuredClone(patch), { id: record.id, viewId: record.viewId, startedAt: record.startedAt, updatedAt: Date.now() })
        if (durationMs !== undefined) record.durationMs = durationMs
        emit(viewId)
        return
      }
    },
    list(viewId) { return structuredClone(views.get(viewId) ?? []) },
    subscribe(viewId, listener) {
      if (!validActivityViewId(viewId)) throw new Error('Invalid activity view')
      const set = listeners.get(viewId) ?? new Set()
      set.add(listener)
      listeners.set(viewId, set)
      return () => { set.delete(listener); if (!set.size) listeners.delete(viewId) }
    },
  }
}
const activityRoot = globalThis
export const getAgentActivityStore = () => activityRoot.__travelAgentActivityStore ??= createAgentActivityStore()

// ── 候选登记 ─────────────────────────────────────────────────────────────────
const registryRoot = globalThis
const registry = registryRoot.__travelCandidates ??= new Map()

export function createPlaceSearch(geocode) {
  const activity = getAgentActivityStore()
  function getSearchStatus() {
    const cfg = geocode.keys()
    const providers = { gaode: Boolean(cfg.gaodeKey), locationiq: Boolean(cfg.locationiqKey) }
    return { configured: Object.values(providers).some(Boolean), providers }
  }
  async function searchForAgent(input, options = {}) {
    // Explicit projection prevents presentation metadata entering provider requests/cache keys.
    const providerInput = { query: input.query, countryCode: input.countryCode, city: input.city, language: input.language, near: input.near, limit: input.limit }
    const activityId = options.viewId ? activity.start({ viewId: options.viewId, kind: 'search', title: '地点搜索', query: { ...providerInput } }) : undefined
    try {
      const result = await geocode.searchPlacesDetailed(providerInput)
      const now = Date.now()
      for (const [id, entry] of registry) if (entry.expiresAt <= now) registry.delete(id)
      const candidates = result.candidates.map((candidate) => {
        const existing = [...registry.entries()].find(([, entry]) => entry.expiresAt === Date.parse(result.expiresAt) && JSON.stringify(entry.candidate) === JSON.stringify(candidate))
        const candidateId = existing?.[0] ?? `candidate_${randomUUID()}`
        registry.set(candidateId, { candidate: structuredClone(candidate), expiresAt: Date.parse(result.expiresAt) })
        return { ...candidate, candidateId }
      })
      while (registry.size > 4000) registry.delete(registry.keys().next().value)
      if (activityId) activity.update(activityId, { status: result.status === 'failed' || result.status === 'not_configured' ? 'failed' : 'completed', candidates, providerStatus: result.providerStatus, cached: result.cached, message: result.status === 'not_configured' ? '未配置可用的地点搜索来源' : result.status === 'failed' ? '搜索来源暂时不可用，请重试' : result.status === 'partial' ? '部分来源不可用，已保留可用结果' : candidates.length ? `找到 ${candidates.length} 个候选地点` : '搜索完成，未找到候选地点' })
      return { ...result, candidates, contextHandling: {
        countryCode: 'LocationIQ country restriction; Gaode skipped for non-CN',
        city: 'Gaode city restriction; LocationIQ city appended to query (not an exact administrative boundary filter)',
        language: 'LocationIQ accept-language; Gaode does not offer language selection',
        near: 'LocationIQ viewbox preference, not radius restriction; Gaode place/text does not support near',
      } }
    } catch (error) {
      if (activityId) activity.update(activityId, { status: 'failed', error: '地点搜索失败，请检查输入或稍后重试' })
      throw error
    }
  }
  return { getSearchStatus, searchForAgent }
}

export function markCandidateAdopted(candidateId, viewId) {
  if (!viewId) return
  const store = getAgentActivityStore()
  for (const activity of store.list(viewId)) {
    if (activity.kind !== 'search' || !activity.candidates?.some((candidate) => candidate.candidateId === candidateId)) continue
    store.update(activity.id, { selectedCandidateIds: [...new Set([...(activity.selectedCandidateIds ?? []), candidateId])] })
  }
}
export function resolveCandidate(candidateId) {
  const entry = registry.get(candidateId)
  if (!entry || entry.expiresAt <= Date.now()) {
    registry.delete(candidateId)
    throw Object.assign(new Error('Place candidate expired or unknown; search again'), { code: 'CANDIDATE_EXPIRED' })
  }
  return structuredClone(entry.candidate)
}
