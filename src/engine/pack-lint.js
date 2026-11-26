/**
 * pack-lint.js — 领域包确定性体检（L1，不调 LLM，零成本）
 *
 * 定位：AI 顾问的"编译器前端"——在 pack 内容进流水线之前，先把结构性、
 * 引用性、完整性问题机械地列出来。只提问不判刑：输出分级问题清单，
 * 永不自动修改 pack、永不阻止加载。
 *
 *   免责声明：本检查只用于降低出错概率，不保证不会出错；
 *   pack 内容仍可能含错误，导入与使用时必须万分谨慎，最终责任在人。
 *
 * 分级：ERROR 疑似硬伤（会导致零件被判 incomplete / 注入缺失）
 *       WARN  待核对（可运行但语义存疑或有死内容）
 *       INFO  提示（统计信息、可改进项）
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadPack, ARTIFACTS, parsePackYml } from './domain-pack.js'

const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2 }

function issue(level, file, msg, hint = '') {
  return { level, file, msg, hint }
}

/**
 * @param root pack 根目录（绝对路径）
 * @param opt  { checklistTask?: string }
 * @returns { issues: [...], stats: {...} }
 */
export function lintPack(root, opt = {}) {
  const issues = []
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')
  const pack = loadPack(root, { ttlMs: 0 })
  if (!pack) {
    issues.push(issue('ERROR', '.', 'pack 目录不存在或不可读'))
    return { issues, stats: {} }
  }

  /* ---------- pack.yml ---------- */
  const ymlPath = path.join(root, 'pack.yml')
  // 声明的 domains（pack.yml 是唯一权威；pack.domains 会混入零件推导值，不能用来判"未声明"）
  let declaredDomains = null
  if (!fs.existsSync(ymlPath)) {
    issues.push(issue('ERROR', 'pack.yml', '缺 pack.yml：domains 只能由零件推导，artifact/planner_hint 不可用', '创建 pack.yml 至少写 name/domains'))
  } else {
    const raw = fs.readFileSync(ymlPath, 'utf8')
    try { declaredDomains = new Set(parsePackYml(raw).domains) } catch { declaredDomains = null }
    // artifact 原始值检查：loadPack 对非法值静默回退 firmware，lint 要把回退本身报出来
    const artM = raw.match(/^artifact\s*:\s*(\S+)\s*$/m)
    if (artM && !ARTIFACTS[artM[1]]) {
      issues.push(issue('WARN', 'pack.yml', `artifact "${artM[1]}" 无法识别（已回退=${pack.artifact}）`, '可选：firmware|procedure|document|machine-ops'))
    }
    if (/^planner_hint\s*:/m.test(raw)) {
      issues.push(issue('INFO', 'pack.yml', '声明了 planner_hint（追加式领域提示，不可覆盖铁律）'))
    }
    if (!pack.domains.filter(d => d !== 'general').length) {
      issues.push(issue('WARN', 'pack.yml', 'domains 为空或未声明——planner 的 domain 枚举只有 general', '在 pack.yml 声明本领域的 domain 词表'))
    }
  }

  /* ---------- catalog.yml ---------- */
  const catPath = path.join(root, 'catalog.yml')
  if (!fs.existsSync(catPath)) {
    issues.push(issue('ERROR', 'catalog.yml', '缺零件目录——封闭选型无从谈起，所有步骤只能自由拆分'))
  } else if (!pack.parts.length) {
    issues.push(issue('WARN', 'catalog.yml', '零件目录为空（parts: []）——pack 处于空骨架状态', '按 catalog.yml 头部注释格式逐个填写零件'))
  }

  /* ---------- 逐零件检查 ---------- */
  const seenIds = new Set()
  const referenced = new Set()   // 所有 [编号] 引用
  for (const p of pack.parts) {
    const pf = `catalog.yml#${p.id}`
    if (seenIds.has(p.id)) issues.push(issue('ERROR', pf, `零件 id "${p.id}" 重复声明`))
    seenIds.add(p.id)
    // domain 必须在 pack.yml 声明（general 兜底豁免）；pack.yml 缺失时跳过（推导模式）
    if (declaredDomains && p.domain && p.domain !== 'general' && !declaredDomains.has(p.domain)) {
      issues.push(issue('ERROR', pf, `domain "${p.domain}" 未在 pack.yml domains 声明`, '把该 domain 加进 pack.yml 或改零件 domain'))
    }
    if (!p.api?.length) issues.push(issue('WARN', pf, '缺 api 签名——裁判无契约可核对'))
    if (!p.interface?.input || !p.interface?.output) issues.push(issue('WARN', pf, '缺 interface input/output——总装对齐检查跳过此零件'))
    if (!p.must_have?.length) issues.push(issue('WARN', pf, '缺 must_have——验收退化为裁判主观判断'))
    for (const r of p.missingRefs || []) issues.push(issue('ERROR', pf, `must_have 引用的手册条目 [${r}] 不存在（空头支票）`, `在 parts/${p.id}/manual/ 补条目或删引用`))
    if (p.incomplete) {
      const reasons = []
      if (p.missingRefs?.length) reasons.push(`missingRefs:${p.missingRefs.join(',')}`)
      if (!p.api?.length) reasons.push('no-api')
      if (!p.interface?.input || !p.interface?.output) reasons.push('no-interface')
      if (!p.must_have?.length) reasons.push('no-must_have')
      issues.push(issue('WARN', pf, `零件判 incomplete（planner 不会选用）: ${reasons.join(' ') || '含占位符'}`))
    }
    // 收集引用的 [编号]（逐字符串匹配，避免 JSON 数组括号被误吞）
    for (const s of [...(p.must_have || []), ...(p.api || []), p.title || '']) {
      for (const m of String(s).matchAll(/\[([^\]\[§<>]{2,30})\]/g)) referenced.add(m[1])
    }
  }

  /* ---------- parts/ 目录与 catalog 对齐 ---------- */
  const partsDir = path.join(root, 'parts')
  const dirIds = new Set()
  if (fs.existsSync(partsDir)) {
    for (const d of fs.readdirSync(partsDir)) {
      const dp = path.join(partsDir, d)
      try { if (!fs.statSync(dp).isDirectory()) continue } catch { continue }
      dirIds.add(d)
      if (!seenIds.has(d)) issues.push(issue('INFO', `parts/${d}/`, '零件目录存在但未在 catalog.yml 登记（不会被选型）', '在 catalog.yml 补条目或删除目录'))
      // 空壳目录检测（robotics 现状：8 个目录全空）
      const hasContent = ['templates', 'manual', 'mistakes'].some(sub => {
        const sd = path.join(dp, sub)
        try { return fs.existsSync(sd) && fs.readdirSync(sd).length > 0 } catch { return false }
      })
      if (!hasContent && seenIds.has(d)) {
        issues.push(issue('WARN', `parts/${d}/`, '零件已登记但 manual/templates/mistakes 全空——知识库内容待填', '填 manual 条目（带 [编号]+来源）后零件才可能完整'))
      }
    }
  }
  for (const p of pack.parts) {
    if (!dirIds.has(p.id)) issues.push(issue('INFO', `parts/${p.id}/`, 'catalog 登记了零件但无对应 parts/ 目录（manual 只能走旧 knowledge/ 布局或没有）'))
  }

  /* ---------- manual / 知识条目 ---------- */
  const dead = pack.knowledge.filter(k => !referenced.has(k.id))
  if (dead.length && pack.knowledge.length) {
    const sample = dead.slice(0, 8).map(k => k.id).join(', ')
    issues.push(issue('INFO', 'parts/*/manual/', `${dead.length}/${pack.knowledge.length} 条 manual 未被任何零件引用（仍可被 kb_search 命中）`, `示例: ${sample}${dead.length > 8 ? ' …' : ''}`))
  }

  /* ---------- checklist ---------- */
  const clDir = path.join(root, 'checklist')
  const clFiles = fs.existsSync(clDir) ? fs.readdirSync(clDir).filter(f => f.endsWith('.md')) : []
  if (!clFiles.length) {
    issues.push(issue('INFO', 'checklist/', '无分解清单——planner 拆步无领域先验，全靠自由拆分'))
  } else {
    for (const f of clFiles) {
      const txt = fs.readFileSync(path.join(clDir, f), 'utf8').trim()
      if (txt.length < 20) issues.push(issue('WARN', `checklist/${f}`, '清单内容过短（<20 字符），可能未写完'))
      const mentioned = [...txt.matchAll(/\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,})\b/g)].map(m => m[1])
      const ghosts = [...new Set(mentioned.filter(id => !seenIds.has(id) && id.includes('-')))]
      if (ghosts.length) issues.push(issue('INFO', `checklist/${f}`, `清单中出现 catalog 未登记的 id 样式词: ${ghosts.slice(0, 5).join(', ')}（若是普通词汇可忽略）`))
    }
    if (opt.checklistTask && !clFiles.includes(`${opt.checklistTask}.md`)) {
      issues.push(issue('WARN', 'checklist/', `checklistTask="${opt.checklistTask}" 但 checklist/ 下无 ${opt.checklistTask}.md`, `可用清单: ${clFiles.map(f => f.replace(/\.md$/, '')).join(', ')}`))
    }
  }

  /* ---------- 模板 / 错题 ---------- */
  const byState = {}
  for (const t of pack.templates) byState[t.state] = (byState[t.state] || 0) + 1
  if (pack.templates.length) {
    const inj = pack.templates.filter(t => ['bench', 'production', 'compiled'].includes(t.state)).length
    issues.push(issue('INFO', 'parts/*/templates/', `模板 ${pack.templates.length} 个（可注入 ${inj}）：${Object.entries(byState).map(([k, v]) => `${k}×${v}`).join(' ')}`))
  }
  if (pack.mistakes.length) {
    issues.push(issue('INFO', 'mistakes', `错题本 ${pack.mistakes.length} 条`))
  }

  /* ---------- loadPack 自身 warnings（解析被拒条目等） ---------- */
  for (const w of pack.warnings || []) {
    issues.push(issue('WARN', '（解析）', w))
  }

  /* ---------- 空包 ---------- */
  if (pack.empty) {
    issues.push(issue('ERROR', '.', 'pack 完全为空（无零件/知识/清单/模板）——等同于没有领域约束'))
  }

  issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
  const stats = {
    parts: pack.parts.length,
    usableParts: pack.parts.filter(p => !p.incomplete).length,
    knowledge: pack.knowledge.length,
    deadEntries: dead.length,
    templates: pack.templates.length,
    mistakes: pack.mistakes.length,
    checklists: clFiles.length,
    counts: issues.reduce((m, i) => ({ ...m, [i.level]: (m[i.level] || 0) + 1 }), {}),
  }
  return { issues, stats, pack }
}

/** 免责声明——每次输出必须带，措辞固定。 */
export const LINT_DISCLAIMER =
  '免责声明：本检查只用于降低出错概率，不保证不会出错。pack 内容仍可能含错误，导入与使用时必须万分谨慎，最终责任在人。'

/** 文本报告（给人看）。 */
export function formatLintReport(root, result) {
  const { issues, stats } = result
  const lines = [
    `pack lint: ${root}`,
    `统计: 零件 ${stats.parts}（可用 ${stats.usableParts}）| manual ${stats.knowledge}（死条目 ${stats.deadEntries}）| 模板 ${stats.templates} | 错题 ${stats.mistakes} | 清单 ${stats.checklists} 份`,
    `问题: ERROR ${stats.counts.ERROR || 0} / WARN ${stats.counts.WARN || 0} / INFO ${stats.counts.INFO || 0}`,
    '',
    LINT_DISCLAIMER,
    '',
  ]
  for (const i of issues) {
    lines.push(`[${i.level}] ${i.file} — ${i.msg}`)
    if (i.hint) lines.push(`        💡 ${i.hint}`)
  }
  return lines.join('\n')
}
