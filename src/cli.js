#!/usr/bin/env node
/**
 * workflow-engine CLI — 与 MCP/DSH 壳同一套引擎（src/engine/dispatch.js）。
 *
 * 用法：
 *   node src/cli.js "总目标" [--context "补充"] [--criteria "硬性要求，每行一条"]
 *     [--pack <名或路径>] [--checklist <task>] [--max-steps N]
 *     [--planner <provider/model>] [--judge|--no-judge|--judge-advisory]
 *     [--judge-tools|--no-judge-tools] [--tools|--no-tools] [--mode routes|dynamic|legacy]
 *     [--keys <keys.local.json>] [--stats <file>] [--json]
 *
 * 进度走 stderr（给人），--json 结果走 stdout（给机器），互不污染。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { mergeConfig, applyKeysFile } = await import('./engine/config.js')
const { dispatch } = await import('./engine/dispatch.js')
const { packRoots } = await import('./engine/domain-pack.js')

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const has = (n) => process.argv.includes(n)
const json = has('--json')

const VALUE_FLAGS = ['--context', '--max-steps', '--planner', '--criteria', '--checklist', '--pack', '--keys', '--stats', '--mode']
const rest = process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith('--') && !VALUE_FLAGS.includes(arr[i - 1]))
const goal = rest.join(' ').trim()

if (!goal || has('--help') || has('-h')) {
  console.log('Usage: node src/cli.js "总目标" [--context "..."] [--criteria "..."] [--pack name|path] [--checklist task] [--max-steps N] [--planner model] [--judge|--no-judge|--judge-advisory] [--judge-tools|--no-judge-tools] [--tools|--no-tools] [--mode routes|dynamic|legacy] [--keys file] [--stats file] [--json]')
  if (!goal) process.exit(2)
  process.exit(0)
}

// ---- 配置 ----
// 基础配置文件：项目根 wfe.config.json（可选，提交 git；keys 走 keys.local.json 不进库）
let fileCfg = {}
try { fileCfg = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* 无配置文件用默认 */ }
const raw = { ...fileCfg }
if (arg('--planner')) { raw.plannerModel = arg('--planner'); raw.plannerFallback = '' }
if (arg('--mode')) raw.matchMode = arg('--mode')
if (arg('--stats')) raw.statsFile = arg('--stats')
if (has('--no-judge')) raw.judge = false
if (has('--judge')) raw.judge = true
if (has('--judge-advisory')) raw.judgeAdvisory = true
if (has('--judge-tools')) raw.judgeTools = true
if (has('--no-judge-tools')) raw.judgeTools = false
raw.tools = { ...(raw.tools || {}) }
if (has('--no-tools')) raw.tools.enabled = false
if (has('--tools')) raw.tools.enabled = true
if (arg('--checklist')) raw.checklistTask = arg('--checklist')

let cfg = mergeConfig(raw)
cfg.packsDir = path.join(ROOT, 'packs')
// keys 文件：--keys 显式 > 项目根 keys.local.json > 不加载
const keysPath = arg('--keys') || path.join(ROOT, 'keys.local.json')
try { cfg = applyKeysFile(cfg, keysPath) } catch { /* 无 keys 文件走 env/兜底 */ }

// ---- pack 选择 ----
const packArg = arg('--pack')
let packName = packArg || ''
if (!packName) {
  const roots = packRoots(cfg)
  const names = Object.keys(roots)
  if (names.length === 1) packName = names[0]
  else if (names.length > 1) {
    console.error(`[wfe] 发现多个领域包：${names.join(', ')}——请用 --pack <名> 指定（或在 config 设 defaultPack）`)
    process.exit(2)
  }
}
if (packArg && !packRoots(cfg)[packArg]) {
  // 允许 --pack 直接给路径
  const fs = await import('node:fs')
  if (!(fs.existsSync(packArg) && fs.statSync(packArg).isDirectory())) {
    console.error(`[wfe] pack "${packArg}" 不在注册表也不是存在的目录`)
    process.exit(2)
  }
}

const onProgress = (m) => { if (!json) console.error('[dispatch] ' + m) }
const maxSteps = Number(arg('--max-steps', cfg.maxSteps)) || cfg.maxSteps
const criteria = String(arg('--criteria', ''))

const result = await dispatch(cfg, goal, String(arg('--context', '')), maxSteps, undefined, onProgress, {}, { pack: packName || undefined, criteria })

// ---- 输出 ----
if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('\n=== 计划 ===  planner=' + result.plannerModel + ' [mode:' + (result.matchMode || '?') + ']' + (result.plannerError ? ` (degraded: ${result.plannerError})` : ''))
  if (result.planRetry) console.log('计划重拆: ' + (result.planRetry.fixed ? '缺陷已修正' : '仍有残余缺陷'))
  if (result.planChecks) console.log('计划检查残余: ' + JSON.stringify(result.planChecks.coverage?.missing || []) + ' ' + JSON.stringify(result.planChecks.interfaces?.issues || []))
  if (result.summary) console.log(result.summary)
  for (const r of result.results) {
    console.log(`\n--- [${r.id}] ${r.title} → ${r.model || '全部候选失败'} ---`)
    if (r.part) console.log('零件: ' + r.part)
    if (r.partRejected) console.log('零件拒选: ' + r.partRejected)
    if (r.freePartReason) console.log('自由拆分: ' + r.freePartReason)
    if (r.needs) console.log('需求: ' + JSON.stringify(r.needs) + '\n候选: ' + (r.candidates || []).join(' -> '))
    if (r.rationale?.length) console.log('为何选它: ' + r.rationale[0])
    console.log('尝试: ' + r.attempts.map(a => a.model + (a.effort ? '@' + a.effort : '') + (a.ok ? ` ✓ ${a.ms}ms` : ` ✗ ${a.reason}`) + (a.toolCalls ? ` [工具×${a.toolCalls}]` : '') + (a.judgeToolCalls ? ` [裁判工具×${a.judgeToolCalls}]` : '')).join(' | '))
    if (r.judgeFailed) console.log('裁判未放行: ' + (r.lastCritique || ''))
    if (r.output) console.log(r.output)
  }
}
process.exit(result.ok ? 0 : 1)
