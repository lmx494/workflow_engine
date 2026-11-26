/**
 * matcher.js — needs 谓词 / task → 候选模型（routes 主模式 + dynamic 旧打分 + legacy）
 *
 * 三种 matchMode（config.matchMode）：
 *  routes   静态路由表 cfg.routes[task] → 有序候选；不足按 cfg.pool 补位。
 *           显式配置可手改，比隐藏加权诚实——v0.7 起的默认主路径。
 *  dynamic  旧加权打分（match.js + 网关能力表），A/B 对比用；只对 catalog provider 有意义。
 *  legacy   planner 直接猜模型名（v0.2 行为）；候选在 planner 里 sanitize。
 *
 * 候选统一形状：{ id: '<provider>/<model>', effort, score, why }
 * exclude：不让分配器兼任自己的执行者（makePlan 传 [plannerModel]）。
 */

import { resolveModelRef } from './config.js'
import { match, candidatesWithEffort } from './match.js'
import { profileOf } from './model-catalog.js'

export const NEEDS_SPEC = {
  task: ['code-gen', 'code-review', 'analyze', 'summarize', 'translate', 'long-output', 'vision', 'general'],
  reason: ['any', 'required', 'strong'],
  modality: ['text', 'image'],
  speed: ['fast', 'normal'],
  cost: ['free', 'x0.1', 'x0.2', 'x0.3', 'x0.5', 'x0.8', 'x1', 'x1.4', 'x2', 'any'],
  timeout: ['short', 'gen', 'analysis'],
}

export function normalizeNeeds(raw, cfg = {}) {
  const n = raw && typeof raw === 'object' ? raw : {}
  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt)
  return {
    task: pick(n.task, NEEDS_SPEC.task, 'general'),
    reason: pick(n.reason, NEEDS_SPEC.reason, 'any'),
    modality: pick(n.modality, NEEDS_SPEC.modality, 'text'),
    speed: pick(n.speed, NEEDS_SPEC.speed, 'normal'),
    max_cost: pick(n.max_cost, NEEDS_SPEC.cost, cfg.maxCost || 'any'),
    timeout_class: pick(n.timeout_class, NEEDS_SPEC.timeout, 'gen'),
    // pack 模式附加字段（routes 模式不用它们选模，但留在 needs 里供记录/展示）
    domain: typeof n.domain === 'string' ? n.domain : '',
    part: typeof n.part === 'string' ? n.part : '',
  }
}

/** ref 是否可用：能解析到 provider 且在 provider.models 白名单内（若声明了） */
export function refAllowed(cfg, ref) {
  const r = resolveModelRef(cfg, ref)
  if (!r) return false
  if (r.provider.models && !r.provider.models.includes(r.model)) return false
  return true
}

/**
 * routes 模式：查表 → provider 白名单过滤 → exclude 过滤 → pool 补位 → 截断。
 * 返回 { id, effort:null, score:0, why } 列表；why 记录来源便于解释。
 */
export function pickRoutes(cfg, task, opt = {}) {
  const exclude = new Set(opt.exclude || [])
  const limit = Math.max(1, Math.trunc(opt.limit ?? cfg.candidatesPerStep ?? 4))
  const table = cfg.routes?.[task] || cfg.routes?.general || []
  const out = []
  const seen = new Set()
  const push = (ref, why) => {
    if (out.length >= limit || seen.has(ref) || exclude.has(ref)) return
    if (!refAllowed(cfg, ref)) return
    seen.add(ref)
    out.push({ id: ref, effort: null, score: 0, why })
  }
  for (const ref of table) push(String(ref), 'routes')
  for (const ref of cfg.pool || []) push(String(ref), 'pool-backfill')
  return out
}

/**
 * dynamic 模式：catalog（网关 /models 原始表）→ 转成以 ref 为 key 的伪目录 → match.js 打分。
 * 非 catalog provider（直连官方 API）的模型没有富元数据，profileOf 给 known:false 诚实未知档。
 */
export function pickDynamic(cfg, catalog, needs, opt = {}) {
  const stats = opt.stats !== undefined ? opt.stats : null
  const exclude = opt.exclude || []
  const limit = Math.max(1, Math.trunc(opt.limit ?? cfg.candidatesPerStep ?? 4))
  const catProvider = (cfg.providers || []).find(p => p.id === cfg.defaultProvider)
  // catalog key 是裸 model id（如 qodercn/qfmodel）；ref 是 provider/model。
  // 只给 defaultProvider 的模型建映射，其他 provider 一律 unknown。
  const catByRef = {}
  for (const ref of cfg.pool || []) {
    const r = resolveModelRef(cfg, ref)
    if (!r || !catProvider || r.provider.id !== catProvider.id) continue
    if (catalog && catalog[r.model]) catByRef[ref] = catalog[r.model]
  }
  const profiles = (cfg.pool || []).map(ref => profileOf(catByRef, ref))
    .filter(p => !exclude.includes(p.id))
  // combo 链序先验：profile.chain 是目录裸 id，翻译回 ref 再喂给 match
  const chainPrior = {}
  if (catProvider) {
    const bareToRef = {}
    for (const ref of cfg.pool || []) {
      const r = resolveModelRef(cfg, ref)
      if (r && r.provider.id === catProvider.id) bareToRef[r.model] = ref
    }
    for (const p of profiles) {
      if (Array.isArray(p.chain)) p.chain.forEach((cid, i) => {
        const ref = cid && bareToRef[cid]
        if (ref && !(ref in chainPrior)) chainPrior[ref] = i
      })
    }
  }
  const cost = needs.max_cost === 'any' ? (cfg.maxCost || 'any') : needs.max_cost
  let m = match(profiles, { ...needs, max_cost: cost }, stats, { limit, exclude, chainPrior })
  if (!m.picked.length) m = match(profiles, { ...needs, max_cost: 'any', reason: 'any' }, stats, { limit, exclude, chainPrior })
  if (!m.picked.length) {
    // 三级放宽的最后一级：池序兜底（why 可辨认）
    return (cfg.pool || []).filter(r => !exclude.includes(r) && refAllowed(cfg, r)).slice(0, limit)
      .map(id => ({ id, effort: null, score: 0, why: 'no-match-pool-order' }))
  }
  return candidatesWithEffort(m.picked, needs)
}

/**
 * 统一入口：按 cfg.matchMode 分发。
 *  legacy 返回 null——候选由 planner 直接给（planner.js 里 sanitizeCandidates 处理）。
 */
export function pickStepCandidates(cfg, needs, opt = {}) {
  if (cfg.matchMode === 'dynamic') return pickDynamic(cfg, opt.catalog || {}, needs, opt)
  if (cfg.matchMode === 'legacy') return null
  return pickRoutes(cfg, needs.task, opt)
}
