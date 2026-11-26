#!/usr/bin/env node
/**
 * trace.js — run 轨迹查看 CLI（人读版）
 *
 *   node src/trace.js [run文件|--latest]   查看最近/指定 run 的完整过程
 *   node src/trace.js --list               列出 run 存档一览
 *   选项：--full 输出全文不截断；--json 输出原始文档；--keys/--stats 同 cli.js
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { mergeConfig } = await import('./engine/config.js')
const { listRuns, runDir } = await import('./engine/runlog.js')
const { formatTrace, traceStatus } = await import('./engine/trace.js')

const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const full = has('--full')

let fileCfg = {}
try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* none */ }
const cfg = mergeConfig({ ...fileCfg, ...(arg('--stats') ? { statsFile: arg('--stats') } : {}) })

if (has('--help') || has('-h') || (!args.length && !has('--list'))) {
  console.log('Usage: node src/trace.js [run.json|--latest] [--full] [--json] | --list')
  process.exit(args.length ? 0 : 2)
}

/* ---------- --list ---------- */
if (has('--list')) {
  const runs = listRuns(cfg)
  if (!runs.length) { console.log(`（无 run 存档，目录: ${runDir(cfg)}）`); process.exit(0) }
  console.log(`run 存档（${runDir(cfg)}）：`)
  for (const p of runs.slice(0, 30)) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const r = d.result || {}
      const when = String(d.saved_at || '').slice(0, 19).replace('T', ' ')
      console.log(`  ${when}  ${traceStatus(d).padEnd(9)}  pack=${d.packName || '-'}  ${String(d.goal || '').slice(0, 55)}`)
    } catch { console.log(`  ${path.basename(p)}  （读取失败）`) }
  }
  process.exit(0)
}

/* ---------- 指定/最新 run ---------- */
let runPath = args.find(a => !a.startsWith('--') && a !== arg('--stats')) || ''
if (!runPath || runPath === '--latest') {
  const runs = listRuns(cfg)
  if (!runs.length) { console.error(`[trace] 无 run 存档（${runDir(cfg)}）`); process.exit(2) }
  runPath = runs[0]
} else if (!path.isAbsolute(runPath)) {
  runPath = path.resolve(runPath)
}
if (!fs.existsSync(runPath)) { console.error(`[trace] run 文件不存在: ${runPath}`); process.exit(2) }

const doc = JSON.parse(fs.readFileSync(runPath, 'utf8'))
if (has('--json')) { console.log(JSON.stringify(doc, null, 2)); process.exit(0) }
console.log(formatTrace(doc, { full }))
process.exit(0)
