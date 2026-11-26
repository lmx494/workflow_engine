#!/usr/bin/env node
/**
 * pack-check.js — 领域包体检 CLI（L1 确定性检查，零 LLM 成本）
 *
 *   node src/pack-check.js <pack路径|pack名> [--json] [--checklist <task>]
 *
 * pack 名解析顺序：命令行给的目录路径 → wfe.config.json 的 packs/packsDir 注册表。
 * 退出码：有 ERROR → 1；只有 WARN/INFO → 0；pack 不存在 → 2。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { lintPack, formatLintReport, LINT_DISCLAIMER } = await import('./engine/pack-lint.js')
const { mergeConfig } = await import('./engine/config.js')
const { resolvePackRoot } = await import('./engine/domain-pack.js')

const args = process.argv.slice(2)
const json = args.includes('--json')
const ci = args.indexOf('--checklist')
const checklistTask = ci >= 0 ? args[ci + 1] : ''
const target = args.find(a => !a.startsWith('--') && a !== checklistTask)

if (!target || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node src/pack-check.js <pack路径|pack名> [--json] [--checklist <task>]')
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

const { issues, stats } = lintPack(root, { checklistTask })

if (json) {
  console.log(JSON.stringify({ root, stats, issues, disclaimer: LINT_DISCLAIMER }, null, 2))
} else {
  console.log(formatLintReport(root, { issues, stats }))
}
process.exit((stats.counts?.ERROR || 0) > 0 ? 1 : 0)
