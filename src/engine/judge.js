/**
 * judge.js — 验收裁判
 *
 * 判定模式由 runStep 的 acceptance 锚定降级链决定（blocking/advisory/none），
 * 本文件只负责"怎么判"：
 *  - pack on 且 step.part：prompt 追加 judgeContractInject（三核对/强制查证，
 *    期望契约项来自目录不是裁判猜）；
 *  - cfg.judgeTools：裁判走工具环（kb_search 对照说明书判卷），
 *    patchToolArgs 同样强制覆盖检索键——裁判也不许查错手册；
 *  - 输出统一 { pass, critique, quality, judgeToolCalls }；
 *    pass:null = 无法判定（调用方按通过处理但不计 pass_rate）。
 */

import { chat as defaultChat, Fail } from './channel.js'
import { judgeContractInject } from './domain-pack.js'
import { runToolLoop, makePatchToolArgs } from './executor.js'
import { toolSpecs } from './tools.js'

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const src = (fence ? fence[1] : text).trim()
  try { return JSON.parse(src) } catch { /* fall through */ }
  const a = src.indexOf('{'), b = src.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(src.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

const JUDGE_BASE = (step, output) => {
  const acc = step.acceptance || { must_have: '', quality_bar: '' }
  return [
    '你是严格的验收裁判。判断执行结果是否**满足硬性要求**。宁可误判不合格，不可放行明显缺陷。',
    `【硬性要求——只有这一项决定 pass/fail】\n${acc.must_have || '(无硬性要求：此时一律 pass=true，只写质量建议)'}`,
    acc.quality_bar ? `【质量建议——不决定 pass/fail，只写改进提示】\n${acc.quality_bar}` : '',
    `【任务】${step.title}\n${String(step.input || '').slice(0, 800)}`,
    '【执行结果】',
    String(output).slice(0, 4000),
    '',
    '逐条核对硬性要求：每条给出证据（引用结果原文片段，≤30字）与结论。',
    '只输出一个 JSON 对象，不要解释文字：',
    '{"pass": true 或 false（仅由硬性要求决定）, "critique": "硬性要求不合格时：具体问题与修正要求≤120字；否则空字符串", "quality": "质量建议的改进提示≤120字；无则空字符串"}',
  ].filter(Boolean).join('\n\n')
}

function parseVerdict(text) {
  const j = extractJson(text)
  if (!j || typeof j.pass !== 'boolean') return { pass: null, critique: '', quality: '' }
  return { pass: j.pass, critique: String(j.critique || '').slice(0, 300), quality: String(j.quality || '').slice(0, 300) }
}

/**
 * 裁判入口。
 * deps: { chat, pack }
 * 返回 { pass, critique, quality, judgeToolCalls }
 */
export async function judgeStep(cfg, step, output, signal, deps = {}) {
  const _chat = deps.chat || defaultChat
  const pack = deps.pack || null
  const jm = cfg.judgeModel || 'local/qodercn/q37fmodel'

  // pack on + 绑定零件 → 契约注入（结构机械：api 清单来自目录）
  const contract = pack && step.part ? judgeContractInject(pack, step.part) : ''
  const prompt = JUDGE_BASE(step, output) + (contract ? `\n\n${contract}` : '')

  try {
    // 裁判工具环：pack on 且 judgeTools 开 → 先 kb_search 查手册再出 verdict
    if (cfg.judgeTools === true && pack && !pack.empty) {
      const toolList = toolSpecs(cfg.tools?.use || [])
      const patch = makePatchToolArgs(step)
      const r = await runToolLoop(cfg, jm, [{ role: 'user', content: prompt }],
        cfg.judgeToolTimeoutMs || cfg.judgeTimeoutMs, signal, {
          chat: _chat,
          tools: toolList,
          maxRounds: cfg.judgeToolMaxRounds || 3,
          resultMaxChars: cfg.tools?.resultMaxChars,
          patchToolArgs: patch,
        })
      const v = parseVerdict(r.content)
      return { ...v, judgeToolCalls: r.toolCalls }
    }
    const text = await _chat(cfg, jm, [{ role: 'user', content: prompt }], cfg.judgeTimeoutMs, signal)
    return { ...parseVerdict(typeof text === 'string' ? text : text?.content || ''), judgeToolCalls: 0 }
  } catch (e) {
    if (e instanceof Fail && e.reason === 'aborted') throw e
    return { pass: null, critique: '', quality: '', judgeToolCalls: 0 }   // 裁判挂了不阻塞主流程
  }
}
