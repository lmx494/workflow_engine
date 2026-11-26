#!/usr/bin/env node
/**
 * mcp.js — 把 ai_dispatch 暴露为 MCP tool（stdio，换行分隔 JSON-RPC）。
 *
 * "白牌寄生"的最短路径：任何讲 MCP 的宿主（Claude Code / Cursor / Codex / DSH）
 * 配置一行 command 即可调用本引擎，无需插件开发。
 *
 *   { "mcpServers": { "workflow-engine": { "command": "node", "args": ["<abs>/src/mcp.js"] } } }
 *
 * 环境变量（可选）：WFE_PACK=<pack名>、WFE_KEYS=<keys.local.json路径>、
 *   WFE_MODE=routes|dynamic|legacy、WFE_JUDGE=0|1
 *
 * 实现说明：MCP stdio = 换行分隔 JSON-RPC 2.0（不是 LSP 的 Content-Length 帧）。
 * 只实现本工具需要的三个方法：initialize / tools/list / tools/call。
 * 零 npm 依赖——协议面足够小，手写比引 SDK 更符合"毛坯房"哲学。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { mergeConfig, applyKeysFile } = await import('./engine/config.js')
const { dispatch } = await import('./engine/dispatch.js')
const { packRoots } = await import('./engine/domain-pack.js')

// ---- 配置（env 驱动，MCP 宿主没有 CLI 参数）----
let fileCfg = {}
try { fileCfg = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'wfe.config.json'), 'utf8')) } catch { /* 无配置文件用默认 */ }
const raw = { ...fileCfg }
if (process.env.WFE_MODE) raw.matchMode = process.env.WFE_MODE
if (process.env.WFE_JUDGE === '0') raw.judge = false
if (process.env.WFE_JUDGE_TOOLS === '1') raw.judgeTools = true
let cfg = mergeConfig(raw)
cfg.packsDir = path.join(ROOT, 'packs')
cfg = applyKeysFile(cfg, process.env.WFE_KEYS || path.join(ROOT, 'keys.local.json'))

const TOOL_DEF = {
  name: 'ai_dispatch',
  description: '确定性工作流分发：planner 按领域包零件目录拆步 → 路由表选模执行（步内工具环自验证）→ 裁判对照零件契约+说明书验收 → 结果回写。事实必须带来源，查不到=未定义不许猜。适合有标准答案可查的领域任务（嵌入式/操作规程/合规/报表）。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal'],
    properties: {
      goal: { type: 'string', description: '要完成的总目标，描述清楚交付物。' },
      context: { type: 'string', description: '可选：补充背景、约束、已有材料。' },
      pack: { type: 'string', description: '可选：领域包名（不指定则用唯一 pack 或 defaultPack）。' },
      max_steps: { type: 'number', description: '可选：最多拆几步（默认 6，上限 12）。' },
      criteria: { type: 'string', description: '可选：硬性验收标准，每行一条；must_have 只能来自这里和目标原话。' },
      dry_run: { type: 'boolean', description: '可选：true=只拆分不执行，返回计划预览（步骤/零件/候选模型/验收标准）。宿主可先把计划展示给用户确认，再不带 dry_run 正式调用。' },
    },
  },
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'workflow-engine', version: '0.1.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') { reply(id, { tools: [TOOL_DEF] }); return }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    if (name !== 'ai_dispatch') { replyError(id, -32602, `unknown tool "${name}"`); return }
    try {
      const goal = String(args.goal || '').trim()
      if (!goal) throw new Error('goal is required')
      const maxSteps = Math.min(12, Math.max(1, Math.trunc(Number(args.max_steps)) || cfg.maxSteps))
      const pack = String(args.pack || process.env.WFE_PACK || '') || undefined
      const result = await dispatch(cfg, goal, String(args.context || ''), maxSteps, undefined,
        () => {}, {}, { pack, criteria: String(args.criteria || ''), dryRun: args.dry_run === true })
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: `ERROR: ${String(e?.message || e)}` }], isError: true })
    }
    return
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try { msg = JSON.parse(t) } catch { return }   // 非 JSON 行静默丢（stdout 只走协议）
  handle(msg).catch((e) => { if (msg.id !== undefined) replyError(msg.id, -32603, String(e?.message || e)) })
})
