/**
 * stats.js — 实测数据闭环（stats.json）
 *
 * 选择 → 执行 → 记录 → 影响下次选择。stats 是"个人资产"：记录本机网关/各 provider
 * 下模型的真实表现，不进 pack 仓库（团队共享的是知识，不是各人的模型池表现）。
 *
 * 文件位置：cfg.statsFile 优先；空 → <项目>/data/stats.json。
 * 写盘失败静默（只读目录不挡主流程）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function statsFile(cfg = {}) {
  if (cfg.statsFile) return String(cfg.statsFile)
  return path.resolve(HERE, '..', '..', 'data', 'stats.json')
}

/** 读 stats.json 的 models 段；文件缺失/损坏返回 null（match 走中性分）。 */
export function loadStats(cfg = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(statsFile(cfg), 'utf8'))
    if (j && j.models && Object.keys(j.models).length) return j.models
  } catch { /* missing/corrupt → null */ }
  return null
}

/**
 * attempts 回写：把真实执行结果累积进 stats.json。
 *  - ok_rate 按样本数加权合并；p50_ms 用 EMA(α=0.3) 近似；
 *  - pass_rate 只收 blocking 判定（judged:true/false）；judged:null 不计入不污染；
 *  - jtool_rate：裁判工具调用率（说明书 §9 静默风险指标）；
 *  - fails 按 reason 分桶（timeout/http/network/empty/rate/auth/no-tools）。
 */
export function recordAttempts(cfg, attempts) {
  const p = statsFile(cfg)
  let doc = { models: {} }
  try { doc = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 新建 */ }
  if (!doc.models || typeof doc.models !== 'object') doc.models = {}
  for (const a of attempts || []) {
    if (!a || !a.model) continue
    const m = doc.models[a.model] || { ok_rate: null, p50_ms: null, tok_s: null, n: 0, fails: {}, last_at: '' }
    const n = Number(m.n) || 0
    m.ok_rate = (((Number(m.ok_rate) || 0) * n) + (a.ok ? 1 : 0)) / (n + 1)
    m.n = n + 1
    if (a.ok && (a.judged === true || a.judged === false)) {
      const pn = Number(m.pass_n) || 0
      m.pass_rate = (((Number(m.pass_rate) || 0) * pn) + (a.judged === true ? 1 : 0)) / (pn + 1)
      m.pass_n = pn + 1
    }
    // 裁判工具调用率：judgeToolCalls>0 的 attempt 计入分母（v0.8 新增，说明书 §9）
    if (Number.isFinite(a.judgeToolCalls)) {
      const jn = Number(m.jtool_n) || 0
      m.jtool_rate = (((Number(m.jtool_rate) || 0) * jn) + (a.judgeToolCalls > 0 ? 1 : 0)) / (jn + 1)
      m.jtool_n = jn + 1
    }
    if (Number.isFinite(a.ms) && a.ms > 0) {
      const prev = Number.isFinite(m.p50_ms) && m.p50_ms > 0 ? m.p50_ms : a.ms
      m.p50_ms = Math.round(prev + (a.ms - prev) * 0.3)
    }
    if (!a.ok) { m.fails = m.fails || {}; m.fails[a.reason || 'error'] = (m.fails[a.reason || 'error'] || 0) + 1 }
    m.last_at = new Date().toISOString()
    doc.models[a.model] = m
  }
  doc.generated_at = new Date().toISOString()
  doc.source = [doc.source && doc.source !== 'attempts' ? doc.source : null, 'attempts'].filter(Boolean).join('+')
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(doc, null, 2)) } catch { /* 只读目录时静默跳过 */ }
  return doc
}
