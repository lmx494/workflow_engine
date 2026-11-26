/**
 * executor.js — 执行阶梯（runStep）+ 步内工具环（runToolLoop）
 *
 * runToolLoop 设计（v0.6 流程 A + v0.8 裁判复用）：
 *  ① 预算按整轮墙钟：每次 chat 拿剩余时间，剩 <1s 判 timeout；
 *  ② 网关不认 tools（Fail 'no-tools'）→ 抛给上层做同候选降级重打，不烧候选名额；
 *  ③ 工具错误是数据：executeTool 永远返回字符串（ERROR: 开头），回填模型自己改；
 *     只有传输层失败才换模型；
 *  ④ 轮数到顶（cfg.tools.maxRounds）关工具强制收卷（toolCapped）；
 *  ⑤ patchToolArgs 钩子：kb_search/mistake_search 的 part/domain 被框架强制覆盖
 *     成本步骤的值——"查错手册"的路机械封死（铁律级设计，别简化）。
 *
 * runStep 三种判定模式（acceptance 锚定降级链）：
 *  blocking  must_have≥8字：裁判可判死 → 同模型带批评重做(judgeRetries) → 换候选 → 诚实上报
 *  advisory  仅 quality_bar / --judge-advisory：裁判跑，批评进结果，永不阻断
 *  none      没开裁判或没标准：单次尝试
 */

import { chat as defaultChat, Fail } from './channel.js'
import { executeTool } from './tools.js'
import { toolSpecs } from './tools.js'
import { executorInject } from './domain-pack.js'
import { normalizeAcceptance } from './planner.js'

/* ---------------- 工具参数补丁（检索键强制覆盖） ---------------- */

/** kb_search/mistake_search 的 part/domain 强制改写成本步骤值；其他工具原样。 */
export function makePatchToolArgs(step) {
  const part = step?.needs?.part || step?.part || ''
  const domain = step?.needs?.domain || step?.domain || ''
  return (name, args) => {
    if (name !== 'kb_search' && name !== 'mistake_search') return args
    return { ...args, ...(part ? { part } : {}), ...(domain ? { domain } : {}) }
  }
}

/* ---------------- 步内工具环 ---------------- */

/**
 * @returns { content, toolCalls, toolRounds, toolCapped, messages }
 * @throws Fail('timeout'|'network'|'http'|'rate'|'auth'|'no-tools'|'empty'|...)
 */
export async function runToolLoop(cfg, modelRef, messages, timeoutMs, signal, opts = {}) {
  const _chat = opts.chat || defaultChat
  const tools = opts.tools || null
  const maxRounds = Math.max(1, Math.trunc(opts.maxRounds ?? cfg.tools?.maxRounds ?? 4))
  const patch = opts.patchToolArgs || null
  const resultMaxChars = opts.resultMaxChars ?? cfg.tools?.resultMaxChars ?? 2000
  const deadline = Date.now() + timeoutMs
  const msgs = messages.map(m => ({ ...m }))
  let toolCalls = 0, toolRounds = 0, toolCapped = false

  for (let round = 0; round <= maxRounds; round++) {
    const remain = deadline - Date.now()
    if (remain < 1000) throw new Fail('timeout', `tool loop budget exhausted (${timeoutMs}ms)`)
    const useTools = tools && round < maxRounds
    const res = await _chat(cfg, modelRef, msgs, remain, signal, {
      effort: opts.effort,
      tools: useTools ? tools : null,
      full: true,
    })
    const content = typeof res === 'string' ? res : (res?.content ?? '')
    const calls = (res && Array.isArray(res.tool_calls)) ? res.tool_calls : []
    if (!calls.length) {
      return { content, toolCalls, toolRounds, toolCapped, messages: msgs }
    }
    // 有 tool_calls：回填 assistant 消息 + 逐个执行工具
    msgs.push({ role: 'assistant', content: content || null, tool_calls: calls })
    for (const tc of calls) {
      const name = tc?.function?.name || ''
      let args = {}
      try { args = JSON.parse(tc?.function?.arguments || '{}') } catch { args = {} }
      if (patch) args = patch(name, args) || args
      let out
      try { out = executeTool(name, args) } catch (e) { out = `ERROR: ${String(e?.message || e)}` }
      if (typeof out !== 'string') out = JSON.stringify(out)
      if (out.length > resultMaxChars) out = out.slice(0, resultMaxChars) + '…[截断]'
      msgs.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCalls}`, content: out })
      toolCalls++
    }
    toolRounds++
    if (round === maxRounds - 1) toolCapped = true   // 下一轮是最后一轮（无工具收卷）
  }
  // 到这里说明最后一轮仍返回 tool_calls——不应发生（useTools 在 maxRounds 轮已关），
  // 防御：强制再要一次无工具结果
  const remain = deadline - Date.now()
  if (remain < 1000) throw new Fail('timeout', 'tool loop final call: budget exhausted')
  const res = await _chat(cfg, modelRef, msgs, remain, signal, { effort: opts.effort, tools: null, full: true })
  const content = typeof res === 'string' ? res : (res?.content ?? '')
  return { content, toolCalls, toolRounds, toolCapped: true, messages: msgs }
}

/* ---------------- 步骤消息 ---------------- */

export function buildStepMessage(step, upstream, pack = null) {
  const acc = step.acceptance && typeof step.acceptance === 'object' ? step.acceptance : normalizeAcceptance(step.acceptance)
  const accText = [
    acc.must_have ? `硬性要求：${acc.must_have}` : '',
    acc.quality_bar ? `质量建议（尽量满足，不是交卷门槛）：${acc.quality_bar}` : '',
  ].filter(Boolean).join('\n')
  const parts = [
    `步骤 ${step.id}：${step.title}`,
    accText,
    Object.keys(upstream).length ? `前序步骤结果（JSON）：\n${JSON.stringify(upstream, null, 2)}` : '',
    `任务：\n${step.input}`,
    // pack on 且本步绑定了零件 → 注入零件契约（期望函数+查证顺序）
    pack && step.part ? executorInject(pack, step.part) : '',
    '直接给出该步骤的完成结果本身，不要复述任务、不要问句收尾。',
  ].filter(Boolean)
  return parts.join('\n\n')
}

/* ---------------- 执行阶梯 ---------------- */

/**
 * @param deps { chat, judge, pack }
 * judge 签名：(cfg, step, output, signal, judgeDeps) → { pass, critique, quality, judgeToolCalls }
 */
export async function runStep(cfg, step, upstream, signal, deps = {}) {
  const _chat = deps.chat || defaultChat
  const _judge = deps.judge || null
  const pack = deps.pack || null
  const attempts = []
  const base = buildStepMessage(step, upstream, pack)
  const timeoutMs = (cfg.timeoutByClass && cfg.timeoutByClass[step.needs?.timeout_class]) || cfg.stepTimeoutMs
  const acc = step.acceptance && typeof step.acceptance === 'object' ? step.acceptance : normalizeAcceptance(step.acceptance)
  const mode = cfg.judge === true
    ? (acc.must_have.trim().length >= 8 ? 'blocking' : acc.quality_bar.trim().length >= 8 ? 'advisory' : 'none')
    : cfg.judgeAdvisory === true ? 'advisory' : 'none'
  const maxRounds = mode === 'blocking' ? cfg.judgeRetries + 1 : 1

  const toolsOn = cfg.tools?.enabled === true && Array.isArray(cfg.tools?.use) && cfg.tools.use.length > 0
  const toolList = toolsOn ? toolSpecs(cfg.tools.use) : null
  const patch = makePatchToolArgs(step)

  let last = null
  for (const cand of step.candidates.slice(0, cfg.candidatesPerStep)) {
    const model = typeof cand === 'string' ? cand : cand.id
    const effort = cfg.useEffort && typeof cand === 'object' ? cand.effort : null
    let message = base
    for (let round = 1; round <= maxRounds; round++) {
      const t0 = Date.now()
      try {
        // ---- 执行（带工具环；不认 tools → 同候选降级重打一次）----
        let output, toolCalls = 0, toolRounds = 0, degraded = false, toolCapped = false
        const loopOpts = { chat: _chat, effort, tools: toolList, maxRounds: cfg.tools?.maxRounds, resultMaxChars: cfg.tools?.resultMaxChars, patchToolArgs: patch }
        try {
          const r = await runToolLoop(cfg, model, [{ role: 'user', content: message }], timeoutMs, signal, loopOpts)
          output = r.content; toolCalls = r.toolCalls; toolRounds = r.toolRounds; toolCapped = r.toolCapped
        } catch (e) {
          if (e instanceof Fail && e.reason === 'no-tools' && toolList) {
            // 网关不认 tools：同候选去 tools 重打一次（不烧候选名额）
            degraded = true
            const r = await runToolLoop(cfg, model, [{ role: 'user', content: message }], timeoutMs, signal, { ...loopOpts, tools: null })
            output = r.content; toolCalls = r.toolCalls; toolRounds = r.toolRounds; toolCapped = r.toolCapped
          } else throw e
        }

        if (mode === 'none' || !_judge) {
          attempts.push({ model, ...(effort ? { effort } : {}), ok: true, ms: Date.now() - t0, ...(toolCalls ? { toolCalls, toolRounds } : {}), ...(degraded ? { degraded: true } : {}), ...(toolCapped ? { toolCapped: true } : {}) })
          return { ok: true, model, output, attempts }
        }
        const v = await _judge(cfg, { ...step, acceptance: acc }, output, signal, { chat: _chat, pack })
        attempts.push({
          model, ...(effort ? { effort } : {}), ok: true, ms: Date.now() - t0,
          judged: mode === 'blocking' ? v.pass : null, mode,
          ...(mode === 'advisory' ? { adv: v.pass } : {}),
          ...(v.critique ? { critique: v.critique } : {}), ...(v.quality ? { quality: v.quality } : {}),
          ...(toolCalls ? { toolCalls, toolRounds } : {}), ...(degraded ? { degraded: true } : {}), ...(toolCapped ? { toolCapped: true } : {}),
          ...(Number.isFinite(v.judgeToolCalls) ? { judgeToolCalls: v.judgeToolCalls } : {}),
        })
        last = { model, output }
        if (mode === 'advisory') return { ok: true, model, output, attempts, ...(v.critique ? { advisoryCritique: v.critique } : {}), ...(v.quality ? { quality: v.quality } : {}) }
        if (v.pass !== false) return { ok: true, model, output, attempts, ...(v.quality ? { quality: v.quality } : {}) }
        if (round < maxRounds) {
          message = base + `\n\n【上次输出未通过硬性要求。裁判指出的问题】${v.critique}\n请针对上述问题修正，重新给出完整结果。`
        }
      } catch (e) {
        if (e instanceof Fail && e.reason === 'aborted') throw e
        attempts.push({ model, ...(effort ? { effort } : {}), ok: false, ms: Date.now() - t0, reason: e instanceof Fail ? e.reason : 'error', detail: String(e.message || e).slice(0, 200) })
        // rate 限流是"现在不行"：blocking 模式且还有重试预算时短冷却重试一次同模型
        if (e instanceof Fail && e.reason === 'rate' && mode === 'blocking' && round < maxRounds) {
          await new Promise(r => setTimeout(r, e.cooldownMs))
          continue
        }
        break   // 其他传输失败不在同模型上重试，直接换下一个候选
      }
    }
  }
  if (last) return { ok: false, judgeFailed: true, model: last.model, output: last.output, attempts }
  return { ok: false, model: null, output: '', attempts }
}
