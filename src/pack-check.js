#!/usr/bin/env node
/**
 * pack-check.js — 领域包体检 CLI
 *
 *   node src/pack-check.js <pack路径|pack名> [--json] [--checklist <task>]
 *   node src/pack-check.js <pack> --ai [--model <ref>]     # L1+L2 AI 语义体检
 *
 * L1 确定性检查零成本始终跑；--ai 追加一轮 LLM 语义审查（1-2 次调用）。
 * pack 名解析顺序：命令行给的目录路径 → wfe.config.json 的 packs/packsDir 注册表。
 * 退出码：有 ERROR → 1；只有 WARN/INFO → 0；pack 不存在 → 2。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { lintPack, formatLintReport, LINT_DISCLAIMER } = await import('./engine/pack-lint.js')
const { mergeConfig, applyKeysFile } = await import('./engine/config.js')
const { resolvePackRoot } = await import('./engine/domain-pack.js')

const args = process.argv.slice(2)
const json = args.includes('--json')
const useAi = args.includes('--ai')
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const ci = args.indexOf('--checklist')
const checklistTask = ci >= 0 ? args[ci + 1] : ''
const VALUE_FLAGS = ['--checklist', '--model', '--keys']
const target = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]))

if (!target || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node src/pack-check.js <pack路径|pack名> [--json] [--checklist <task>] [--ai] [--model <ref>] [--keys <file>]')
  process.exit(target ? 0 : 2)
}

// 解析 pack 根目录：先当路径，再查注册表
let root = null
try { if (fs.existsSync(target) && fs.statSync(target).isDirectory()) root = path.resolve(target) } catch { /* not path */ }
if (!root) {
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* none */ }
  const cfg = mergeConfig(fileCfg)
  cfg.packsDir = cfg.packsDir || path.join(ROOT, 'packs')
  root = resolvePackRoot(cfg, target)
}
if (!root) {
  console.error(`[pack-check] 找不到 pack "${target}"（不是存在的目录，也不在注册表）`)
  process.exit(2)
}

// L1 确定性检查（始终跑）
const { issues: l1, stats } = lintPack(root, { checklistTask })
for (const i of l1) i.source = 'lint'
let issues = l1
let aiInfo = null

// L2 AI 语义检查（可选）
if (useAi) {
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* none */ }
  const raw = { ...fileCfg }
  if (arg('--model')) { raw.learnModel = arg('--model') }
  if (arg('--keys')) { /* applyKeysFile below */ }
  let cfg = mergeConfig(raw)
  cfg.packsDir = cfg.packsDir || path.join(ROOT, 'packs')
  try { cfg = applyKeysFile(cfg, arg('--keys') || path.join(ROOT, 'keys.local.json')) } catch { /* none */ }
  const { aiLintPack } = await import('./engine/pack-ai.js')
  try {
    const r = await aiLintPack(cfg, root)
    issues = [...l1, ...r.issues]
    const order = { ERROR: 0, WARN: 1, INFO: 2 }
    issues.sort((a, b) => order[a.level] - order[b.level])
    stats.counts = issues.reduce((m, i) => ({ ...m, [i.level]: (m[i.level] || 0) + 1 }), {})
    aiInfo = { model: cfg.learnModel || cfg.judgeModel, digestChars: r.digestChars, aiIssues: r.issues.length, rejected: r.rejected }
  } catch (e) {
    aiInfo = { error: String(e?.message || e) }
    if (!json) console.error(`[pack-check] AI 检查失败: ${aiInfo.error}`)
  }
}

if (json) {
  console.log(JSON.stringify({ root, stats, issues, ai: aiInfo, disclaimer: LINT_DISCLAIMER }, null, 2))
} else {
  console.log(formatLintReport(root, { issues, stats }))
  if (aiInfo) {
    if (aiInfo.error) console.log(`\n[AI检查] 失败: ${aiInfo.error}`)
    else console.log(`\n[AI检查] model=${aiInfo.model} digest=${aiInfo.digestChars}字 → ${aiInfo.aiIssues} 条语义问题${aiInfo.rejected ? `（${aiInfo.rejected} 条格式被拒）` : ''}`)
    console.log(LINT_DISCLAIMER)
  }
}
process.exit((stats.counts?.ERROR || 0) > 0 ? 1 : 0)
