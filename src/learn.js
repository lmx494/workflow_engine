#!/usr/bin/env node
/**
 * learn.js — 错题总结 CLI（AI 起草 → 人工审核 → 入库）
 *
 *   node src/learn.js [run文件|--latest]           回顾 run 轨迹，生成错题草稿
 *   node src/learn.js --accept <草稿.jsonl>        审核后的草稿转正进 mistakes.jsonl
 *   node src/learn.js --list                        列出可总结的 run
 *
 * 草稿落在 <pack>/mistakes-candidates/<run名>.jsonl（暂存区，不进检索）；
 * --accept 后追加到 <pack>/mistakes.jsonl（全局错题本，mistake_search 可检索）。
 *
 * 选项：--model <ref> 指定总结模型（默认 cfg.learnModel||judgeModel）
 *       --pack <路径> 草稿/入库的 pack 覆盖（run 里没记 packRoot 时用）
 *       --keys <file> / --stats <file> 同 cli.js
 *       --json 机器可读输出
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { mergeConfig, applyKeysFile } = await import('./engine/config.js')
const { listRuns, runDir } = await import('./engine/runlog.js')
const { summarizeRun, MISTAKE_REQUIRED } = await import('./engine/learn.js')

const args = process.argv.slice(2)
const has = (n) => args.includes(n)
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const json = has('--json')

let fileCfg = {}
try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* none */ }
const raw = { ...fileCfg }
if (arg('--model')) { raw.learnModel = arg('--model'); raw.plannerFallback = raw.plannerFallback }
if (arg('--stats')) raw.statsFile = arg('--stats')
let cfg = mergeConfig(raw)
cfg.packsDir = cfg.packsDir || path.join(ROOT, 'packs')
try { cfg = applyKeysFile(cfg, arg('--keys') || path.join(ROOT, 'keys.local.json')) } catch { /* none */ }

function loadRunDoc(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/* ---------- --list ---------- */
if (has('--list') || (!args.filter(a => !a.startsWith('--')).length && !has('--accept'))) {
  const runs = listRuns(cfg)
  if (json) { console.log(JSON.stringify(runs.map(p => ({ file: path.basename(p), mtime: fs.statSync(p).mtime.toISOString() })), null, 2)); process.exit(0) }
  if (!runs.length) { console.log(`（无 run 存档，目录: ${runDir(cfg)}）`); process.exit(0) }
  console.log(`run 存档（${runDir(cfg)}）：`)
  for (const p of runs.slice(0, 20)) {
    try {
      const d = loadRunDoc(p)
      console.log(`  ${path.basename(p)}  ok=${d.result?.ok}  pack=${d.packName || '-'}  goal=${String(d.goal || '').slice(0, 50)}`)
    } catch { console.log(`  ${path.basename(p)}  （读取失败）`) }
  }
  process.exit(0)
}

/* ---------- --accept ---------- */
if (has('--accept')) {
  const target = arg('--accept')
  if (!target || target.startsWith('--')) { console.error('用法: --accept <草稿.jsonl 路径>'); process.exit(2) }
  const draftPath = path.resolve(target)
  if (!fs.existsSync(draftPath)) { console.error(`[learn] 草稿文件不存在: ${draftPath}`); process.exit(2) }

  // 定位 packRoot：优先 --pack，其次按草稿文件名匹配 run 存档里的 packRoot
  let packRoot = arg('--pack') ? path.resolve(arg('--pack')) : ''
  if (!packRoot) {
    const base = path.basename(draftPath).replace(/\.jsonl$/, '.json')
    for (const rp of listRuns(cfg)) {
      if (path.basename(rp) === base) {
        try { packRoot = loadRunDoc(rp).packRoot || '' } catch { /* skip */ }
        break
      }
    }
  }
  if (!packRoot || !fs.existsSync(packRoot)) {
    console.error('[learn] 无法确定 pack 根目录——用 --pack <路径> 指定')
    process.exit(2)
  }

  const outFile = path.join(packRoot, 'mistakes.jsonl')
  const lines = fs.readFileSync(draftPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const accepted = [], skipped = []
  for (const line of lines) {
    try {
      const m = JSON.parse(line)
      const missing = MISTAKE_REQUIRED.filter(k => !m[k])
      if (missing.length) { skipped.push({ line: line.slice(0, 60), missing }); continue }
      accepted.push(JSON.stringify(m))
    } catch { skipped.push({ line: line.slice(0, 60), missing: ['JSON'] }) }
  }
  if (accepted.length) {
    fs.appendFileSync(outFile, accepted.join('\n') + '\n')
  }
  const report = { packRoot, outFile, accepted: accepted.length, skipped }
  if (json) { console.log(JSON.stringify(report, null, 2)) } else {
    console.log(`[learn] ${accepted.length} 条错题已追加到 ${outFile}`)
    for (const s of skipped) console.log(`  跳过: ${s.line}…（缺 ${s.missing.join('/')}）`)
    console.log('提示: mistake_search 现在就能检索到这些条目')
  }
  process.exit(accepted.length ? 0 : 1)
}

/* ---------- 默认：总结 ---------- */
const positional = args.filter(a => !a.startsWith('--') && a !== arg('--model') && a !== arg('--keys') && a !== arg('--stats') && a !== arg('--pack'))
let runPath = positional[0] || ''
if (!runPath) {
  const runs = listRuns(cfg)
  if (!runs.length) { console.error(`[learn] 无 run 存档（${runDir(cfg)}）。先跑一次 dispatch。`); process.exit(2) }
  runPath = runs[0]
} else if (!path.isAbsolute(runPath)) {
  runPath = path.resolve(runPath)
}
if (!fs.existsSync(runPath)) { console.error(`[learn] run 文件不存在: ${runPath}`); process.exit(2) }

const runDoc = loadRunDoc(runPath)
const { drafts, rejected, runFile } = await summarizeRun(cfg, runDoc)

// 写草稿到 mistakes-candidates/（有 packRoot 才写；没有只打印）
let draftFile = ''
const packRoot = arg('--pack') ? path.resolve(arg('--pack')) : (runDoc.packRoot || '')
const base = path.basename(runPath).replace(/\.json$/, '')
if (packRoot && fs.existsSync(packRoot)) {
  const candDir = path.join(packRoot, 'mistakes-candidates')
  fs.mkdirSync(candDir, { recursive: true })
  draftFile = path.join(candDir, `${base}.jsonl`)
  fs.writeFileSync(draftFile, drafts.map(d => JSON.stringify(d)).join('\n') + (drafts.length ? '\n' : ''))
}

if (json) {
  console.log(JSON.stringify({ run: runPath, runFile, drafts, rejected, draftFile }, null, 2))
} else {
  console.log(`[learn] run: ${path.basename(runPath)}  pack=${runDoc.packName || '-'}  结果=${runDoc.result?.ok ? 'ok' : 'FAIL@' + runDoc.result?.stage}`)
  console.log(`[learn] 草稿 ${drafts.length} 条（rejected ${rejected.length}）`)
  for (const d of drafts) {
    console.log(`\n--- ${d.id || '(no-id)'} [${d.domain}${d.part ? '/' + d.part : ''}] ---`)
    console.log(`症状: ${d['症状']}`)
    if (d['根因']) console.log(`根因: ${d['根因']}`)
    console.log(`修法: ${d['修法']}`)
    if (d['验证']) console.log(`验证: ${d['验证']}`)
    console.log(`来源: ${d['来源']}`)
  }
  if (draftFile) console.log(`\n草稿已存: ${draftFile}`)
  console.log('\n审核后入库: node src/learn.js --accept ' + (draftFile || '<草稿.jsonl>') + (packRoot ? '' : ' --pack <pack路径>'))
  if (rejected.length) console.log(`\n注意: ${rejected.length} 行被拒（${rejected.slice(0, 3).map(r => r.missing.join('+')).join(' | ')}）`)
}
process.exit(drafts.length ? 0 : 1)
