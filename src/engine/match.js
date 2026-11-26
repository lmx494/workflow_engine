/**
 * match.js — 确定性模型匹配器（替代「planner 猜模型名」）
 *
 * 输入：needs 谓词（planner 输出，只描述任务要什么，不出现模型 id）
 * 输出：按分排序的候选列表 + 选择理由（可解释，供 attempts/results 记录）
 *
 * 硬过滤（不满足直接淘汰）：模态、思考能力下限、定价上限。
 * 打分（0..100，权重可配）：定价贴合、思考深度贴合、速度贴合、任务先验、实测可用性、实测吞吐。
 * stats 缺失（未跑探针）时，可用性/吞吐两项不计分并做中性化处理，不让未测量的模型凭空占优。
 */

const COST_TIERS = { free: 0, 'x0.1': 0.1, 'x0.2': 0.2, 'x0.3': 0.3, 'x0.5': 0.5, 'x0.8': 0.8, x1: 1, 'x1.4': 1.4, x2: 2 }

/** needs.max_cost → 允许的最大倍率；'any' → Infinity */
function costCeil(maxCost) {
  if (maxCost == null || maxCost === 'any') return Infinity
  const n = COST_TIERS[String(maxCost)]
  return Number.isFinite(n) ? n : Infinity
}

const TASK_PRIOR = {
  // task → { cap: 需要的最低思考档, prefer: 名称正则加分 }
  // ⚠ 未经校准的启发式（2026-11-09 实测在案）：prefer 按"名字里有什么"加分，
  //   本质是猜测不是观测——实测抹掉 label 后前三名会换一批。它应当被 stats 的
  //   pass_rate（任务级合格率）逐类替换掉，而不是继续调正则。改动前想清楚：
  //   这里每加一个词，都是在把你的偏好伪装成模型的知识。
  'code-gen':     { cap: 1, prefer: /qwen|deepseek|kimi|glm|minimax|spark|nemotron|code/i },
  'code-review':  { cap: 3, prefer: /k3|kimi|deepseek|38max|max|glm/i },
  'analyze':      { cap: 3, prefer: /k3|kimi|deepseek|pro|max/i },
  'summarize':    { cap: 0, prefer: /flash|lightning|mini|small|3\.8|qwen/i },
  'translate':    { cap: 0, prefer: /flash|lightning|mini|qwen|glm/i },
  'long-output':  { cap: 1, prefer: /flash|lightning|3\.8|qwen|glm/i },
  'vision':       { cap: 0, prefer: /.*/ },
  'general':      { cap: 0, prefer: /.*/ },
}

const REASON_FLOOR = { any: 0, required: 1, strong: 3 }

/**
 * 无数据时的中性系数（与 avail 项一致）。
 * 原则：「不知道」既不该按最差算（会误杀），也不该按最好算（会奖励无知）。
 * 见 20261108-模块边界实测.md 之外的同日排查：旧版 speedHint 未知返 2、
 * 而旧权重数组档 2 恰是最高分 → 未知比"已知很快"得分更高。
 */
const NEUTRAL = 0.55

/** 速度档 1(快)…5(慢) 的得分系数，必须单调不增；档 2 现已无来源（保留占位）。 */
const SPEED_WEIGHT = { normal: [0.95, 0.8, 0.65, 0.5, 0.35], fast: [1, 0.75, 0.5, 0.3, 0.15] }

/**
 * 成本分：
 *  - 设了硬上限（max_cost != any）：不合格者已被硬过滤淘汰；合格者按「越便宜越好」给梯度分。
 *  - 未设上限：仍给便宜加分（1/(1+cost)），否则免费档与 x2.0 打平，违背「白嫖优先」的前提。
 */
function costScore(p, ceil, wCost) {
  if (ceil === 0) return wCost                                    // 只要免费，免费即满分
  if (!Number.isFinite(ceil)) return wCost * (1 / (1 + (p.costN ?? 0.6)))
  if (p.costN === 0) return wCost
  if (!Number.isFinite(p.costN)) return wCost * 0.5
  return wCost * (0.35 + 0.65 * (1 - p.costN / (ceil || 1)))       // 便宜优先，但保留「贵一点更值」的空间
}


/**
 * @param {object[]} profiles  profileOf() 的结果集合
 * @param {object}   needs     { modality?, reason?, max_cost?, prefer_cost?, task?, speed? }
 * @param {object}   stats     { [id]: { ok_rate, p50_ms, tok_s, fail_reason } } 可空
 * @param {object}   opt       { limit, exclude, weights }
 */
export function match(profiles, needs = {}, stats = null, opt = {}) {
  const limit = Math.max(1, Math.trunc(opt.limit ?? 5))
  const exclude = new Set(opt.exclude || [])
  const w = { cost: 26, reason: 24, speed: 14, task: 16, avail: 20, ...opt.weights }
  const ceil = costCeil(needs.max_cost)
  const needModality = needs.modality === 'image' ? 'image' : null
  const reasonFloor = REASON_FLOOR[needs.reason] ?? 0
  const task = TASK_PRIOR[needs.task] || TASK_PRIOR.general

  const rejected = []
  const scored = []
  for (const p of profiles) {
    if (!p || exclude.has(p.id)) continue
    // --- 硬过滤 ---
    if (needModality && !p.modality.includes(needModality)) { rejected.push({ id: p.id, why: `modality:${p.modality.join('+')} 无 ${needModality}` }); continue }
    // cap === null（元数据缺失）不参与硬淘汰；只有确证的 0 才淘汰。
    if (p.cap != null && p.cap < reasonFloor) { rejected.push({ id: p.id, why: `reason:cap ${p.cap}<${reasonFloor}` }); continue }
    if (ceil === 0) {
      if (p.costN !== 0) { rejected.push({ id: p.id, why: `cost:非免费(${p.costLabel || '未知'})` }); continue }
    } else if (Number.isFinite(ceil)) {
      if (p.opaque) { rejected.push({ id: p.id, why: 'cost:定价未知，在设了 max_cost 时不冒险' }); continue }
      if (p.costN > ceil) { rejected.push({ id: p.id, why: `cost:${p.costLabel}>${needs.max_cost}` }); continue }
    }
    if (task.cap && p.cap != null && p.cap < task.cap) { rejected.push({ id: p.id, why: `task ${needs.task}:cap ${p.cap}<${task.cap}` }); continue }

    // --- 打分 ---
    let s = 0, why = []
    s += costScore(p, ceil, w.cost)
    why.push(p.costN === 0 ? '免费' : p.costLabel ? `成本${p.costLabel}` : '定价未知')
    if (p.opaque) s -= 4
    if (p.router) { s -= 6; why.push('路由器上游不确定') }
    // 思考深度：刚好满足需求最好，过剩也不全丢分；cap 未知 → 中性且额外降权（不奖励无知）
    const want = reasonFloor || task.cap || 1
    if (p.cap == null) {
      s += w.reason * NEUTRAL * 0.8
      why.push('思考档未知')
    } else {
      const over = Math.max(0, p.cap - want)
      s += w.reason * (p.cap >= want ? Math.max(0.55, 1 - over * 0.12) : 0.15)
      why.push(`思考cap${p.cap}${p.def ? `/${p.def}` : ''}`)
    }
    // 速度：有实测 p50 用实测，否则用名称启发；两者都没有 → 中性，不给分也不罚分
    const fastWant = needs.speed === 'fast'
    const sp = fastWant ? SPEED_WEIGHT.fast : SPEED_WEIGHT.normal
    const st0 = stats?.[p.id]
    if (st0 && Number.isFinite(st0.p50_ms)) {
      const tier = st0.p50_ms <= 3000 ? 1 : st0.p50_ms <= 8000 ? 2 : st0.p50_ms <= 20000 ? 3 : st0.p50_ms <= 45000 ? 4 : 5
      s += w.speed * sp[tier - 1]
      why.push(`实测${Math.round(st0.p50_ms)}ms→速档${tier}`)
    } else if (p.speed != null) {
      s += w.speed * sp[p.speed - 1]
      why.push(`速档${p.speed}(名称启发)`)
    } else {
      s += w.speed * NEUTRAL
      why.push('速度未知')
    }
    // 任务先验
    if (task.prefer.test(p.label)) { s += w.task * 0.8; why.push(`匹配${needs.task || 'general'}`) } else s += w.task * 0.25
    // 实测（有则用，无则中性且降权）
    const st = st0
    if (st) {
      const availW = w.avail
      s += availW * (Number(st.ok_rate ?? 0.6))
      why.push(`实测ok${Math.round((st.ok_rate ?? 0) * 100)}%`)
      if (Number.isFinite(st.tok_s)) s += 6 * Math.min(1, st.tok_s / 60)
      if (Number.isFinite(st.p50_ms)) s += 4 * Math.min(1, 12_000 / st.p50_ms)
    } else {
      // 2026-11-11：stats 缺失时，combo 链序当先验。chainPrior 格式：{ 'model-id': rank }，rank 越小排越前（0=链首）
      // 语义边界（test-chain 组 2 锁死）：先验只做「同族内排序」，不越过中性线——
      // rank 0 = 中性（不假装"网关排第一"就等于"我们测过它好"），rank 越大越降权。
      // 下钳 0.4：链条深处的成员只是弱信号，不能按"不可用"处理（旧写法 max(0,·) 会扣满 avail 权重）。
      const prior = opt.chainPrior?.[p.id]
      if (prior !== undefined && Number.isFinite(prior)) {
        const boost = Math.min(1, Math.max(0.4, 1 - prior * 0.15))
        s += w.avail * NEUTRAL * boost
        why.push(`链序先验#${prior + 1}`)
      } else {
        s += w.avail * NEUTRAL
        why.push('无实测数据')
      }
    }
    scored.push({ id: p.id, score: Math.round(s * 10) / 10, profile: p, why: why.join(' ') })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return { picked: scored.slice(0, limit), all: scored, rejected }
}

/** 把 match 结果压成候选数组，并附 reasoning_effort 建议（同模型的第二旋钮）。 */
export function candidatesWithEffort(picked, needs) {
  const wantHigh = needs.reason === 'strong' || ['code-review', 'analyze'].includes(needs.task)
  return picked.map(c => {
    const effs = c.profile.efforts || []
    let effort = c.profile.def || null
    if (effs.length) {
      const rank = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
      // cap 为 null 时按 1 处理（effs 非空则 cap 必为数字，这里只是防御性写法）
      const cap = c.profile.cap == null ? 1 : c.profile.cap
      const target = wantHigh ? Math.min(4, cap) : Math.min(2, cap)
      effort = effs.slice().sort((a, b) => Math.abs(rank[a] - target) - Math.abs(rank[b] - target))[0]
    }
    return { id: c.id, score: c.score, effort, why: c.why }
  })
}
