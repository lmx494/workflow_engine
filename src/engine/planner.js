/**
 * planner.js — 拆步（plan 阶段）
 *
 * 职责：把总目标拆成 1..maxSteps 步；pack on 时注入清单+零件目录，
 * 步骤做"零件选型"（part/domain/自由拆分原因），must_have 合入 acceptance。
 * planner 自身有 1 层兜底（plannerFallback），两个都挂 → 降级单步直发。
 *
 * 计划级检查（覆盖+接口对齐）不在这里做——dispatch 拿到 plan 后调
 * planChecks()，失败带 critique 重拆一次（见 dispatch.js）。
 */

import { chat as defaultChat, Fail } from './channel.js'
import { plannerInject, checkCoverage, checkInterfaces } from './domain-pack.js'
import { normalizeNeeds, pickStepCandidates, refAllowed, NEEDS_SPEC } from './matcher.js'

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const src = (fence ? fence[1] : text).trim()
  try { return JSON.parse(src) } catch { /* fall through */ }
  const a = src.indexOf('{'), b = src.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(src.slice(a, b + 1)) } catch { /* fall through */ } }
  const ca = src.indexOf('['), cb = src.lastIndexOf(']')
  if (ca >= 0 && cb > ca) { try { return { steps: JSON.parse(src.slice(ca, cb + 1)) } } catch { /* ignore */ } }
  return null
}

export function normalizeAcceptance(raw) {
  if (typeof raw === 'string') {
    const s = raw.trim()
    return { must_have: s, quality_bar: '', legacy: true }
  }
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    must_have: String(o.must_have || o.required || '').trim(),
    quality_bar: String(o.quality_bar || o.quality || o.suggestions || '').trim(),
    legacy: false,
  }
}

/** legacy 模式：planner 给的候选名 → 合法 ref 列表（pool 白名单 + provider 可解析） */
export function sanitizeCandidates(raw, cfg) {
  const pool = new Set(cfg.pool || [])
  const seen = []
  for (const m of Array.isArray(raw) ? raw : []) {
    const id = String(m || '').trim()
    if (pool.has(id) && !seen.includes(id) && refAllowed(cfg, id)) seen.push(id)
  }
  for (const m of cfg.pool || []) { if (seen.length >= cfg.candidatesPerStep) break; if (!seen.includes(m) && refAllowed(cfg, m)) seen.push(m) }
  return seen.slice(0, cfg.candidatesPerStep)
}

/** pack 步骤字段归一化：part 绑定 / 拒选 / 自由拆分原因 / must_have 合入 */
function bindPart(step, raw, pack) {
  const usable = new Map((pack.parts || []).filter(p => !p.incomplete).map(p => [p.id, p]))
  const all = new Map((pack.parts || []).map(p => [p.id, p]))
  const partId = String(raw.part || raw['零件'] || '').trim()
  step.planViolations = step.planViolations || []
  if (partId) {
    const p = usable.get(partId)
    if (p) {
      step.part = p.id
      step.domain = p.domain || step.domain
      step.needs.part = p.id
      step.needs.domain = p.domain || step.needs.domain
      // 零件 must_have 合入 acceptance（硬性验收来自目录，不是 planner 猜）
      const extra = (p.must_have || []).map(x => String(x).trim()).filter(Boolean)
      if (extra.length) {
        const cur = step.acceptance.must_have || ''
        step.acceptance.must_have = [cur, ...extra.map(x => `- ${x}`)].filter(Boolean).join('\n')
      }
      return
    }
    const known = all.get(partId)
    step.partRejected = known ? `零件 ${partId} incomplete（缺契约/手册条目），按自由拆分处理` : `零件 ${partId} 不在目录内，按自由拆分处理`
    step.planViolations.push('part-rejected')
  }
  // 自由拆分：目录外步骤必须写原因（铁律 3 的机械执行面）
  const reason = String(raw['自由拆分'] || raw.free_reason || raw.reason || '').trim()
  if (reason) step.freePartReason = reason
  else if ((pack.parts || []).length || Object.keys(pack.checklists || {}).length) {
    step.planViolations.push('missing-free-reason')
  }
}

/**
 * planner 拆步。
 * deps: { chat, catalog, stats, pack }——全注入，离线可测。
 * 返回 { plannerModel, summary, matchMode, steps, plannerError? }
 */
export async function makePlan(cfg, goal, context, maxSteps, signal, deps = {}) {
  const _chat = deps.chat || defaultChat
  const catalog = deps.catalog || {}
  const stats = deps.stats !== undefined ? deps.stats : null
  const pack = deps.pack || null
  const packOn = !!(pack && !pack.empty)
  const metaDriven = cfg.matchMode === 'dynamic' && Object.keys(catalog).length > 0
  const taskKey = cfg.checklistTask || Object.keys(pack?.checklists || {})[0] || ''

  // pack 注入块（清单 + 零件目录 + 铁律），plannerInject 内部做预算截断
  const packBlock = packOn ? plannerInject(pack, taskKey) : ''

  const selectBlock = cfg.matchMode === 'legacy'
    ? [
        `每个步骤给 candidates：从下面模型池中选最多 ${cfg.candidatesPerStep} 个，按「最适合→次适合」排序；第 1 个是首选，后面是它不稳定时的备用。只能使用池内 id，不得杜撰。`,
        '模型池：',
        (cfg.pool || []).map(m => '- ' + m).join('\n'),
      ]
    : [
        '每个步骤给 needs：说明这一步需要什么样的执行模型。**禁止出现任何模型名或模型 id**——模型选择由本地路由表完成，你猜的名字不会被采用，只会拉低质量。',
        `  task: ${NEEDS_SPEC.task.join('|')}（这一步在做什么）`,
        `  reason: any=不假思考；required=要能深入推理；strong=必须强推理（审查/证明/找 bug）`,
        `  modality: text|image`,
        `  speed: fast=要秒回的轻任务；normal=常规`,
        `  max_cost: free|x0.1|x0.5|x1|x2|any（这一步的预算上限）`,
        `  timeout_class: short=几十句内；gen=常规产出；analysis=长文审查或多步推演`,
      ]

  const stepSchema = packOn
    ? `{"id":"s1","title":"简短标题","input":"发给执行模型的完整自包含指令（含必要背景与约束）","part":"零件id或null","domain":"领域","自由拆分":"仅part为null时写原因","acceptance":{"must_have":"硬性要求：只能来自用户目标里明确说过的东西，逐条列出；用户没提的不许写这里","quality_bar":"质量建议：你作为专业补充的更高标准，写清为什么"},"needs":{"task":"code-gen","reason":"required","modality":"text","speed":"normal","max_cost":"any","timeout_class":"gen"}}`
    : `{"id":"s1","title":"简短标题","input":"发给执行模型的完整自包含指令（含必要背景与约束）","acceptance":{"must_have":"硬性要求","quality_bar":"质量建议"},"needs":{"task":"code-gen","reason":"required","modality":"text","speed":"normal","max_cost":"any","timeout_class":"gen"}${cfg.matchMode === 'legacy' ? ',"candidates":["模型1","模型2"]' : ''}}`

  const prompt = [
    '你是任务分配器（planner）。把用户目标拆成按顺序执行的步骤，并说明每一步需要什么样的执行模型。',
    `步骤数：1-${maxSteps}，能一步做完就只出 1 步。`,
    packBlock,
    ...selectBlock,
    '输出**只含一个 JSON 对象**，不要解释文字：',
    `{"steps":[${stepSchema}],"summary":"整体思路一句话"}`,
    '要求：input 必须自包含（执行模型看不到本对话）；前序步骤的结果会自动拼进后续 input 之外，不要在 input 里写占位符。',
    `用户目标：\n${goal}`,
    context ? `补充上下文：\n${context}` : '',
    // criteria 锚定（v0.7）：用户显式给的硬性标准，must_have 只能来自这里+目标原话
    deps.criteria ? `用户硬性验收标准（must_have 只能写这里明确列出的内容，逐条对应）：\n${deps.criteria}` : '',
  ].filter(Boolean).join('\n\n')

  const models = [cfg.plannerModel, cfg.plannerFallback].filter(Boolean)
  let lastErr = null
  for (const pm of models) {
    try {
      const text = await _chat(cfg, pm, [{ role: 'user', content: prompt }], cfg.plannerTimeoutMs, signal)
      const plan = extractJson(text)
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) { lastErr = new Fail('malformed', 'planner output not JSON steps'); continue }
      const steps = plan.steps.slice(0, maxSteps).map((s, i) => {
        const needs = normalizeNeeds(s.needs || s.requirements, cfg)
        const st = {
          id: String(s.id || `s${i + 1}`),
          title: String(s.title || s.input || `step ${i + 1}`).slice(0, 120),
          input: String(s.input || s.goal || ''),
          acceptance: normalizeAcceptance(s.acceptance),
          needs,
        }
        if (packOn) bindPart(st, s, pack)
        st.candidates = cfg.matchMode === 'legacy'
          ? sanitizeCandidates(s.candidates || s.models, cfg).map(id => ({ id, effort: null, score: 0, why: 'legacy-planner-choice' }))
          : (pickStepCandidates(cfg, needs, { exclude: [pm], catalog, stats }) || [])
        return st
      }).filter(s => s.input && s.candidates.length)
      if (!steps.length) { lastErr = new Fail('malformed', 'no usable steps in plan'); continue }
      return { plannerModel: pm, summary: String(plan.summary || ''), matchMode: cfg.matchMode, steps }
    } catch (e) { lastErr = e }
  }
  // 兜底计划：整目标一步
  const needs = normalizeNeeds({}, cfg)
  const cands = cfg.matchMode === 'legacy'
    ? sanitizeCandidates([], cfg).map(id => ({ id, effort: null, score: 0, why: 'legacy-fallback' }))
    : (pickStepCandidates(cfg, needs, { catalog, stats }) || cfg.pool.slice(0, cfg.candidatesPerStep).map(id => ({ id, effort: null, score: 0, why: 'pool-fallback' })))
  return {
    plannerModel: 'fallback-direct',
    summary: 'planner 失败，整目标作为单步执行',
    matchMode: cfg.matchMode,
    steps: [{ id: 's1', title: '直接执行', input: goal, acceptance: normalizeAcceptance(''), needs, candidates: cands }],
    plannerError: String(lastErr?.message || lastErr || 'unknown'),
  }
}

/**
 * 计划级检查（pack on 且 >1 步）：覆盖 + 接口对齐。
 * 返回 { ok, coverage, interfaces, critique? }——critique 给重拆用。
 */
export function planChecks(pack, plan) {
  if (!pack || pack.empty || !plan?.steps?.length || plan.steps.length <= 1) {
    return { ok: true, skipped: true }
  }
  const used = plan.steps.map(s => ({ part: s.part || '', domain: s.domain || s.needs?.domain || '' }))
  const cl = (plan._checklistText) || ''
  const coverage = checkCoverage(cl, used, pack.domains)
  const interfaces = checkInterfaces(plan.steps.map(s => pack.parts.find(p => p.id === s.part)).filter(Boolean))
  const ok = coverage.ok !== false && interfaces.ok !== false
  const problems = []
  if (coverage.missing?.length) problems.push(`覆盖缺口：${coverage.missing.map(m => m.ref).join('、')}`)
  if (interfaces.issues?.length) problems.push(`接口问题：${interfaces.issues.map(i => `${i.pair}(${i.kind})`).join('、')}`)
  return { ok, coverage, interfaces, critique: problems.join('；') }
}
