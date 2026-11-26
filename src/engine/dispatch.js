/**
 * dispatch.js — 总编排（引擎入口）
 *
 * 数据流：pack 解析 → catalog(dynamic only)/stats → makePlan → 计划级检查
 * （覆盖+接口，不过带 critique 重拆一次）→ 逐步 runStep → recordAttempts → 汇总。
 *
 * 宿主无关：本文件不认识 DSH/MCP/CLI——调用方给 cfg+goal+deps，拿结果。
 * deps 全注入（chat/catalog/stats/judge/pack），离线测试零网关。
 */

import { chat as defaultChat } from './channel.js'
import { loadCatalog } from './model-catalog.js'
import { loadStats, recordAttempts } from './stats.js'
import { makePlan, planChecks } from './planner.js'
import { runStep } from './executor.js'
import { judgeStep } from './judge.js'
import { loadPackFor } from './domain-pack.js'
import { registerDomainTools } from './tools.js'
import { persistRun } from './runlog.js'
import fs from 'node:fs'

// 领域工具（kb_search/mistake_search）注册一次；getPack 读当前 dispatch 的活跃 pack。
// 注意：单进程并发 dispatch 会共享 activePack——v1 接受（CLI/MCP 均串行），
// 并发宿主需要每实例工具表时再改（v2）。
let activePack = null
registerDomainTools(() => activePack)

/**
 * @param cfg 合并后的配置
 * @param goal 总目标
 * @param context 补充上下文
 * @param maxSteps 步数上限
 * @param signal 宿主中断信号
 * @param onProgress 进度回调 (msg)=>void
 * @param deps { chat, catalog, stats, judge, pack } 测试注入
 * @param opts { pack: pack名/路径, criteria: 用户硬性标准 }
 */
export async function dispatch(cfg, goal, context, maxSteps, signal, onProgress, deps = {}, opts = {}) {
  // ---- pack 解析（deps.pack 注入优先，离线测试用）----
  const pack = deps.pack !== undefined ? deps.pack : loadPackFor(cfg, opts.pack)
  activePack = pack && !pack.empty ? pack : null

  const catalog = cfg.matchMode === 'dynamic' ? await loadCatalog(cfg, fs, cfg.catalogTtlMs) : {}
  const stats = deps.stats !== undefined ? deps.stats : loadStats(cfg)
  const _chat = deps.chat || defaultChat
  const _judge = deps.judge || ((c, s, o, sig, jd) => judgeStep(c, s, o, sig, { ...jd, pack }))

  const planDeps = { chat: _chat, catalog, stats, pack, criteria: opts.criteria }
  let plan = await makePlan(cfg, goal, context, maxSteps, signal, planDeps)
  // 记录 planner 实际用的 checklist（覆盖检查要对照同一份清单）
  if (pack && !pack.empty) {
    const tk = cfg.checklistTask || Object.keys(pack.checklists || {})[0] || ''
    plan._checklistText = (tk && pack.checklists[tk]) || Object.values(pack.checklists || {})[0] || ''
  }
  onProgress?.(`planned by ${plan.plannerModel}: ${plan.steps.length} step(s) [${plan.matchMode}]${pack && !pack.empty ? ` [pack:${pack.name} parts=${pack.parts.length}]` : ''}`)
  for (const s of plan.steps) {
    onProgress?.(`  ${s.id} needs=${JSON.stringify(s.needs || {})}`)
    onProgress?.(`  step ${s.id} (${s.title}) candidates: ${s.candidates.map(c => c.id + (c.effort ? `@${c.effort}` : '')).join(' -> ')}`)
  }
  if (plan.plannerError) onProgress?.(`planner degraded: ${plan.plannerError}`)

  // ---- 计划级检查（pack on 且 >1 步）：不过 → critique 回灌重拆一次 ----
  let planRetry = null
  let checks = planChecks(pack, plan)
  if (pack && !pack.empty && plan.steps.length > 1 && checks.ok === false) {
    onProgress?.(`plan checks failed: ${checks.critique} — replanning once`)
    const retryDeps = { ...planDeps, criteria: [opts.criteria, `【上次计划未过计划级检查】${checks.critique}\n请修正覆盖缺口与接口问题后重新拆分。`].filter(Boolean).join('\n') }
    const plan2 = await makePlan(cfg, goal, context, maxSteps, signal, retryDeps)
    if (pack && !pack.empty) {
      const tk = cfg.checklistTask || Object.keys(pack.checklists || {})[0] || ''
      plan2._checklistText = (tk && pack.checklists[tk]) || Object.values(pack.checklists || {})[0] || ''
    }
    const checks2 = planChecks(pack, plan2)
    planRetry = { fixed: checks2.ok !== false, critique: checks.critique }
    plan = plan2
    checks = checks2
    onProgress?.(`replan: ${planRetry.fixed ? 'defects fixed' : 'residual defects remain'}`)
  }

  // ---- 逐步执行 ----
  const upstream = {}
  const results = []
  try {
    for (const step of plan.steps) {
      const r = await runStep(cfg, step, upstream, signal, { chat: _chat, judge: _judge, pack })
      recordAttempts(cfg, r.attempts)
      results.push({
        id: step.id, title: step.title, ok: r.ok, model: r.model, output: r.output,
        acceptance: step.acceptance || { must_have: '', quality_bar: '', legacy: false },
        ...(step.part ? { part: step.part } : {}),
        ...(step.partRejected ? { partRejected: step.partRejected } : {}),
        ...(step.freePartReason ? { freePartReason: step.freePartReason } : {}),
        ...(step.planViolations?.length ? { planViolations: step.planViolations } : {}),
        ...(r.advisoryCritique ? { advisoryCritique: r.advisoryCritique } : {}),
        ...(r.quality ? { quality: r.quality } : {}),
        ...(r.judgeFailed ? { judgeFailed: true, lastCritique: (r.attempts.filter(a => a.judged === false).pop() || {}).critique || '' } : {}),
        needs: step.needs,
        candidates: step.candidates.map(c => c.id + (c.effort ? `@${c.effort}` : '')),
        rationale: step.candidates.map(c => c.why).filter(Boolean).slice(0, 2),
        attempts: r.attempts,
      })
      if (!r.ok) {
        const failed = {
          ok: false, stage: `step:${step.id}`, plannerModel: plan.plannerModel, matchMode: plan.matchMode,
          summary: plan.summary, ...(plan.plannerError ? { plannerError: plan.plannerError } : {}),
          ...(planRetry ? { planRetry } : {}), ...(checks && checks.skipped !== true ? { planChecks: checks } : {}),
          results,
        }
        failed.runFile = persistRun(cfg, {
          goal, context, packName: pack?.name || '', packRoot: pack?.root || '',
          plannerModel: plan.plannerModel, matchMode: plan.matchMode,
        }, failed)
        return failed
      }
      upstream[step.id] = r.output
    }
  } finally {
    activePack = null
  }
  const done = {
    ok: true, stage: 'done', plannerModel: plan.plannerModel, matchMode: plan.matchMode,
    summary: plan.summary, ...(plan.plannerError ? { plannerError: plan.plannerError } : {}),
    ...(planRetry ? { planRetry } : {}), ...(checks && checks.skipped !== true ? { planChecks: checks } : {}),
    results,
  }
  done.runFile = persistRun(cfg, {
    goal, context, packName: pack?.name || '', packRoot: pack?.root || '',
    plannerModel: plan.plannerModel, matchMode: plan.matchMode,
  }, done)
  return done
}
