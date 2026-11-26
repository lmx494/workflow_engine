/**
 * runlog.js — dispatch 结果持久化（data/runs/*.json）
 *
 * 为什么需要：learn/错题总结、调试回放、审计都依赖"当时到底发生了什么"。
 * stats.json 只存聚合计数，run 文件存完整轨迹（attempts/critique/工具调用）。
 *
 * 文件位置：cfg.runDir 优先；空 → <项目>/data/runs/。
 * 写盘失败静默（不挡主流程）；cfg.saveRuns===false 完全关闭。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function runDir(cfg = {}) {
  if (cfg.runDir) return String(cfg.runDir)
  return path.resolve(HERE, '..', '..', 'data', 'runs')
}

/** 列出现有 run 文件（新的在前）。 */
export function listRuns(cfg = {}) {
  try {
    return fs.readdirSync(runDir(cfg))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => path.join(runDir(cfg), f))
  } catch { return [] }
}

/**
 * 持久化一次 dispatch。
 * @param cfg
 * @param meta { goal, context, packName, packRoot, plannerModel, matchMode }
 * @param result dispatch 返回的完整结果
 * @returns 写入的文件路径；失败/关闭返回 null
 */
export function persistRun(cfg, meta, result) {
  if (cfg.saveRuns === false) return null
  try {
    const dir = runDir(cfg)
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const p = path.join(dir, `${ts}.json`)
    const doc = {
      v: 1,
      saved_at: new Date().toISOString(),
      ...meta,
      result,
    }
    fs.writeFileSync(p, JSON.stringify(doc, null, 2))
    return p
  } catch { return null }
}
