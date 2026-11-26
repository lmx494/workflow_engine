/**
 * trace.js — run 存档的人类可读轨迹渲染（纯函数，离线可测）
 *
 * 定位：让用户"看见工作过程"——任务怎么拆的、哪个 AI 干了哪步、
 * 有没有被裁判打回、打回原因是什么。不展示工具调用细节（那是 learn/调试的事）。
 *
 * 数据源：runlog.js 持久化的 data/runs/*.json（result.results[].attempts 全量在）。
 */

/** run 文档 → 一行状态描述（--list 用）。 */
export function traceStatus(doc) {
  const r = doc?.result || {}
  if (r.dryRun) return 'DRY-RUN'
  if (r.aborted) return '已中止'
  if (r.ok) return 'ok'
  return `FAIL@${r.stage || '?'}`
}

function truncLines(text, maxLines, maxChars = 4000) {
  const src = String(text || '')
  const lines = src.split('\n')
  let s = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : src
  const notes = []
  if (lines.length > maxLines) notes.push(`余 ${lines.length - maxLines} 行`)
  if (s.length > maxChars) { s = s.slice(0, maxChars); notes.push('超长') }
  return notes.length ? s + `\n    …（已截断：${notes.join('，')}，--full 看全文）` : s
}

function fmtAttempt(a, i) {
  const model = a.model || '?'
  if (!a.ok) return `    #${i + 1} ${model}  ✗ 失败: ${a.reason || 'error'}${a.detail ? `（${String(a.detail).slice(0, 80)}）` : ''}`
  if (a.judged === false) return `    #${i + 1} ${model}  ✗ 裁判打回: ${a.critique || '(裁判未给原因)'}`
  if (a.judged === true) return `    #${i + 1} ${model}  ✓ 裁判放行`
  return `    #${i + 1} ${model}  ✓ 完成` + (a.adv === false ? '（裁判建议性未过）' : '')
}

/**
 * @param doc runlog 持久化的文档 { goal, context, packName, plannerModel, matchMode, result }
 * @param opts { full: bool, maxOutputLines: number }
 */
export function formatTrace(doc, opts = {}) {
  const r = doc.result || {}
  const full = opts.full === true
  const maxOut = Number.isFinite(opts.maxOutputLines) ? opts.maxOutputLines : 30
  const L = []

  // ---- 头部 ----
  L.push(`run ${doc.saved_at || '?'}  结果: ${traceStatus(doc)}  pack: ${doc.packName || '-'}  planner: ${doc.plannerModel || r.plannerModel || '-'} [${doc.matchMode || r.matchMode || '?'}]`)
  L.push(`目标: ${doc.goal || ''}`)
  if (doc.context) L.push(`上下文: ${String(doc.context).slice(0, 200)}`)
  if (r.reason) L.push(`中止原因: ${r.reason}`)
  if (r.plannerError) L.push(`planner 降级: ${r.plannerError}`)
  if (r.summary) L.push(`概要: ${r.summary}`)

  // ---- 计划级记录（重拆/闸门/检查残余）----
  const planNotes = []
  if (r.planRetry) planNotes.push(`自动重拆: ${r.planRetry.fixed ? '缺陷已修正' : '仍有残余缺陷'}（${String(r.planRetry.critique || '').slice(0, 120)}）`)
  if (r.planGate?.rejects?.length) planNotes.push(`闸门否决 ${r.planGate.rejects.length} 次: ${r.planGate.rejects.map(x => String(x).slice(0, 60)).join(' | ')}`)
  if (r.planChecks && r.planChecks.skipped !== true && r.planChecks.ok === false) {
    planNotes.push(`计划检查残余: ${r.planChecks.critique || JSON.stringify(r.planChecks.coverage?.missing || [])}`)
  }
  if (planNotes.length) L.push('\n── 计划备注 ──\n' + planNotes.map(x => '  ' + x).join('\n'))

  // ---- 步骤 ----
  // dryRun/中止：只有 plan；正常 run：results[]（含 attempts）
  const planSteps = Array.isArray(r.plan?.steps) ? r.plan.steps : []
  const execSteps = Array.isArray(r.results) ? r.results : []
  const stepList = planSteps.length ? planSteps : execSteps
  if (!stepList.length) { L.push('\n（无步骤记录）'); return L.join('\n') }

  L.push('\n── 步骤 ──')
  stepList.forEach((s, idx) => {
    L.push(`\n[${s.id || `s${idx + 1}`}] ${s.title || ''}`)
    if (s.part) L.push(`  零件: ${s.part}${s.domain ? ` (domain:${s.domain})` : ''}`)
    else if (s.freePartReason) L.push(`  自由拆分: ${s.freePartReason}`)
    if (s.partRejected) L.push(`  零件拒选: ${s.partRejected}`)
    const cands = s.candidates || []
    const candStr = cands.map(c => (typeof c === 'string' ? c : c.id) + (typeof c === 'object' && c.effort ? `@${c.effort}` : '')).join(' -> ')
    if (candStr) L.push(`  候选链: ${candStr}`)
    const mh = s.acceptance?.must_have
    if (mh) L.push(`  验收 must_have:\n${String(mh).split('\n').map(x => '    ' + x).join('\n')}`)
    if (s.rationale?.length) L.push(`  选模理由: ${s.rationale[0]}`)

    // 执行记录（仅正常 run 的 results[] 有 attempts）
    const attempts = Array.isArray(s.attempts) ? s.attempts : []
    if (attempts.length) {
      L.push('  执行:')
      attempts.forEach((a, i) => L.push(fmtAttempt(a, i)))
    } else if (execSteps.length) {
      L.push('  （未执行到此步）')
    }
    if (s.judgeFailed) L.push(`  ⚠ 裁判最终未放行: ${s.lastCritique || ''}`)
    if (s.quality) L.push(`  质量评语: ${String(s.quality).slice(0, 200)}`)

    // 产出（截断）
    if (s.output) {
      const out = full ? String(s.output) : truncLines(s.output, maxOut)
      L.push(`  产出:\n${String(out).split('\n').map(x => '    ' + x).join('\n')}`)
    }
  })

  // ---- 尾部：learn 引导 ----
  const judgeFails = execSteps.filter(s => s.judgeFailed).length
  const transportFails = execSteps.filter(s => s.attempts?.some(a => !a.ok)).length
  if (judgeFails || transportFails) {
    L.push(`\n── 提示 ──`)
    if (judgeFails) L.push(`  ${judgeFails} 步裁判未放行 → node src/learn.js <本run文件> 可让 AI 总结错题（人审后入库）`)
    if (transportFails) L.push(`  ${transportFails} 步存在传输失败（超时/HTTP）——纯基础设施问题，learn 不总结这类`)
  }
  return L.join('\n')
}
