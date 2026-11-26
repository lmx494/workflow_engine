/**
 * learn.js — 错题总结（run 轨迹 → mistakes.jsonl 草稿）
 *
 * 定位：AI 起草、人类审核。dispatch 跑完后用户主动调用，把"哪步被裁判打回、
 * 为什么、能总结出什么可复用教训"提炼成错题本候选条目。
 * 草稿先落 pack 的 mistakes-candidates/（暂存区，不进检索），
 * 用户审查编辑后 `--accept` 才转正进 mistakes.jsonl。
 *
 * 与 pack lint 同哲学：AI 提问不判刑——草稿是建议不是事实，
 * 来源字段强制带 run 引用（可回溯），违反铁律 1 精神的条目拒收。
 */

import { chat as defaultChat } from './channel.js'

/** mistakes.jsonl 必填字段（与 parseMistakesJsonl 对齐）。 */
export const MISTAKE_REQUIRED = ['domain', '症状', '修法']

/** run 轨迹压缩成 prompt 可读的文本（截断保关键信号）。 */
export function buildRecap(runDoc, opt = {}) {
  const r = runDoc?.result || {}
  const out = []
  out.push(`【任务】${runDoc?.goal || '(unknown)'}`)
  if (runDoc?.context) out.push(`【上下文】${String(runDoc.context).slice(0, 300)}`)
  out.push(`【pack】${runDoc?.packName || '无'}  【结果】${r.ok ? '成功' : `失败@${r.stage}`}  【planner】${r.plannerModel || '-'}`)
  if (r.summary) out.push(`【计划摘要】${r.summary}`)
  for (const s of r.results || []) {
    out.push(`\n=== step ${s.id}: ${s.title} ===`)
    out.push(`part=${s.part || '自由拆分'} model=${s.model || 'FAIL'} ok=${s.ok}${s.judgeFailed ? ' [裁判未放行]' : ''}`)
    if (s.acceptance?.must_have) out.push(`验收must_have: ${String(s.acceptance.must_have).slice(0, 300)}`)
    for (const a of s.attempts || []) {
      const bits = [`  attempt model=${a.model} ok=${a.ok} ms=${a.ms} reason=${a.reason || '-'}`]
      if (a.judged === false) bits.push('JUDGE-FAIL')
      if (a.judged === true) bits.push('judge-pass')
      if (a.toolCalls) bits.push(`tools=${a.toolCalls}`)
      if (a.critique) bits.push(`critique="${String(a.critique).slice(0, 400)}"`)
      out.push(bits.join(' '))
    }
    if (s.lastCritique) out.push(`  lastCritique: ${String(s.lastCritique).slice(0, 400)}`)
    if (s.quality) out.push(`  quality: ${String(s.quality).slice(0, 300)}`)
    if (s.output) out.push(`  output[截断]: ${String(s.output).slice(0, 600)}`)
  }
  const text = out.join('\n')
  return text.length > (opt.maxChars || 14000) ? text.slice(0, opt.maxChars) + '\n…[截断]' : text
}

const SYSTEM = `你是错题本总结员。读一段多步 AI 工作流的执行轨迹，提炼**可复用的领域教训**。

规则（硬性）：
1. 只总结"知识/方法"层面的教训——协议数值记错、接口理解偏差、模板误用、验收标准误读等。
2. **忽略纯基础设施失败**：超时、HTTP 错误、网络断开、模型空响应——这些是选模/stats 的问题，不是知识库该记的。
3. 每条必须能归到具体零件 part；归不进任何零件的写 domain 级（part 留空）。
4. "来源"字段必须引用 run 标识（格式 run:<文件名> step:<步骤id>），禁止凭空编造出处。
5. 没有值得总结的教训就输出空（一个字都别写多余解释）。
6. 输出**纯 JSONL**，每行一个 JSON 对象，不要 markdown 代码块、不要前后缀文字。

每行 schema（字段名固定中文）：
{"id":"m-<短横线英文>","domain":"<领域>","part":"<零件id或空>","症状":"<执行时表现出的错误现象>","根因":"<为什么会错>","修法":"<下次该怎么做才对>","验证":"<怎么确认修好了，可空>","来源":"run:<文件> step:<id>"}
必填只有 domain/症状/修法，其余可省。`

/**
 * 从 run 轨迹生成错题草稿。
 * @param cfg 配置（learnModel || judgeModel）
 * @param runDoc persistRun 写入的文档（含 result）
 * @param deps { chat } 测试注入
 * @returns { drafts: [...], raw: string, runFile }
 */
export async function summarizeRun(cfg, runDoc, deps = {}) {
  const _chat = deps.chat || defaultChat
  const runFile = runDoc?.result?.runFile ? String(runDoc.result.runFile).split(/[\\/]/).pop() : ''
  const recap = buildRecap(runDoc)
  const model = cfg.learnModel || cfg.judgeModel
  const vocab = deps.packInfo
    ? `\n【合法词表】domain 只能取: ${deps.packInfo.domains.join('|')}；part 只能取: ${deps.packInfo.parts.join('|') || '(无零件，全部留空)'}——超出词表的值会被拒收。`
    : ''
  const content = await _chat(cfg, model, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `run 标识: ${runFile || '(unknown)'}\n\n${recap}${vocab}\n\n请输出错题草稿 JSONL：` },
  ], cfg.learnTimeoutMs || cfg.judgeTimeoutMs)

  const drafts = []
  const rejected = []
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim().replace(/^```(jsonl?|)\s*/i, '').replace(/```\s*$/, '')
    if (!t || t.startsWith('#')) continue
    try {
      const m = JSON.parse(t)
      const missing = MISTAKE_REQUIRED.filter(k => !m[k])
      if (missing.length) { rejected.push({ line: t.slice(0, 80), missing }); continue }
      // 来源兜底：模型没给就用 runFile+首个失败步骤
      if (!m['来源']) {
        const failStep = (runDoc?.result?.results || []).find(s => s.judgeFailed || s.attempts?.some(a => a.judged === false))
        m['来源'] = `run:${runFile || '?'}${failStep ? ` step:${failStep.id}` : ''}`
      }
      drafts.push(m)
    } catch { rejected.push({ line: t.slice(0, 80), missing: ['JSON'] }) }
  }
  return { drafts, rejected, raw: content, runFile }
}
