/**
 * config.js — 默认配置、合并钳位、provider 解析
 *
 * 三层架构里的"策略层"入口：所有可调策略都在这里有默认值，
 * 不变量（三条铁律、流水线骨架）不在此文件——它们在 domain-pack.js / dispatch.js 里硬编码。
 *
 * 模型引用格式：`<providerId>/<modelName>`，如 `deepseek/deepseek-chat`、
 * `local/qodercn/qfmodel`（local = DSH 内置 OpenAI 网关，向后兼容旧池 id）。
 * 裸 id（无 provider 前缀）按 cfg.defaultProvider 解析，默认 'local'。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const COST_TIERS_ALL = ['free', 'x0.1', 'x0.2', 'x0.3', 'x0.5', 'x0.8', 'x1', 'x1.4', 'x2', 'any']

/**
 * v1 默认路由表（routes 模式主路径）：task → 有序候选模型引用。
 * 这是产品决策初版——显式配置可手改，比隐藏加权诚实。
 * 候选按"跨 provider 梯队"排：付费稳档 → 免费档兜底；provider 不在 config 里自动跳过。
 */
export const DEFAULT_ROUTES = {
  'code-gen':     ['deepseek/deepseek-chat', 'qwen/qwen-plus', 'local/qodercn/qfmodel', 'local/loomy/spark-x2.6'],
  'code-review':  ['deepseek/deepseek-reasoner', 'local/qodercn/qmodel_latest', 'local/qodercn/kmodel_latest', 'local/qodercn/qfmodel'],
  'analyze':      ['deepseek/deepseek-reasoner', 'local/qodercn/qmodel_latest', 'local/qodercn/kmodel_latest', 'local/qodercn/qfmodel'],
  'long-output':  ['deepseek/deepseek-chat', 'local/qodercn/qfmodel', 'local/loomy/qwen3.8-flash'],
  'general':      ['local/qodercn/qfmodel', 'local/qodercn/q37fmodel', 'local/loomy/GLM-5.3-Flash'],
  'summarize':    ['local/qodercn/qfmodel', 'local/loomy/GLM-5.3-Flash', 'local/qodercn/q37fmodel'],
  'translate':    ['local/qodercn/qfmodel', 'local/loomy/GLM-5.3-Flash'],
  'vision':       ['local/qodercn/qfmodel', 'local/qodercn/qmodel_38max'],
}

/** 兜底池：路由表查不到 task 或候选全被过滤时按此顺序补位。 */
export const DEFAULT_POOL = [
  'local/qodercn/qfmodel',
  'local/qodercn/q37fmodel',
  'local/qodercn/qmodel',
  'local/qodercn/qmodel_latest',
  'local/qodercn/dfmodel',
  'local/qodercn/gfmodel',
  'local/qodercn/kmodel_latest',
  'local/loomy/qwen3.8-flash',
  'local/loomy/GLM-5.3-Flash',
  'local/loomy/spark-x2.6',
  'local/our-free-model/kilo-auto/free',
]

const DEFAULTS = {
  enabled: true,

  // ---- providers（多 provider 模型接入）----
  // providers: [{ id, baseUrl, apiKey|apiKeyEnv|apiKeyFile, models?: string[] }]
  // 也兼容对象写法 { deepseek: { baseUrl, apiKeyEnv, ... } }——归一化在 normalizeProviders。
  providers: [
    {
      id: 'local',
      baseUrl: 'http://127.0.0.1:8326/v1',
      apiKeyFile: path.join(os.homedir(), '.dsh', 'openai-gateway', 'api-key'),
      // models 不填 = 不限制（pool/routes 里出现的 id 直接用）
    },
  ],
  defaultProvider: 'local',
  keysFile: '',                     // keys.local.json 路径；空 → 不加载外部 keys
  apiKey: '',                       // 全局兜底 key（旧配置兼容，优先级最低）

  // ---- 选模 ----
  matchMode: 'routes',              // routes(默认) | dynamic(旧打分) | legacy(planner 猜名)
  routes: { ...DEFAULT_ROUTES },
  pool: [...DEFAULT_POOL],
  candidatesPerStep: 4,
  maxCost: 'any',                   // 仅 dynamic 模式成本闸
  useEffort: true,                  // 仅 dynamic 模式

  // ---- 角色模型 ----
  plannerModel: 'local/qodercn/qfmodel',
  plannerFallback: 'local/qodercn/q37fmodel',
  judgeModel: 'local/qodercn/q37fmodel',
  plannerTimeoutMs: 180_000,
  stepTimeoutMs: 150_000,
  timeoutByClass: { short: 60_000, gen: 150_000, analysis: 330_000 },
  maxSteps: 6,
  catalogTtlMs: 600_000,            // 仅 dynamic：网关能力表缓存

  // ---- 裁判 ----
  judge: true,
  judgeAdvisory: false,
  judgeRetries: 1,
  judgeTimeoutMs: 60_000,
  judgeTools: false,                // pack on 时裁判走工具环
  judgeToolMaxRounds: 3,
  judgeToolTimeoutMs: 150_000,

  // ---- 步内工具环 ----
  tools: { enabled: true, maxRounds: 4, resultMaxChars: 2000, use: ['calc', 'regex_test', 'kb_search', 'mistake_search'] },

  // ---- 领域包 ----
  // packs: { <名>: <目录路径> }；packsDir: 扫描目录（每个子目录当一个 pack，目录名=pack 名）
  packs: {},
  packsDir: '',                     // 空 → 默认 <项目>/packs
  defaultPack: '',                  // dispatch 未指定 pack 时用；空 → packs 里第一个/唯一
  checklistTask: '',                // 空=有清单用第一份

  // ---- 其他 ----
  statsFile: '',                    // 空 → <项目>/data/stats.json
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * providers 归一化：数组写法和对象写法都收。
 * 对象写法 { deepseek: { baseUrl, apiKeyEnv } } → [{ id:'deepseek', ... }]
 * 补默认字段；apiKey 明文只允许出现在 keys.local.json/环境，不进 DEFAULTS。
 */
export function normalizeProviders(raw, cfg = {}) {
  let list = raw
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = Object.entries(list).map(([id, v]) => ({ id, ...(v || {}) }))
  }
  if (!Array.isArray(list)) list = []
  const out = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const id = String(p.id || '').trim()
    const baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '')
    if (!id || !baseUrl) continue
    out.push({
      id,
      baseUrl,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '',
      apiKeyFile: typeof p.apiKeyFile === 'string' ? p.apiKeyFile : '',
      models: Array.isArray(p.models) && p.models.length ? p.models.map(String) : null,
    })
  }
  return out
}

/**
 * 解析模型引用 → { provider, model, ref }。
 * 'deepseek/deepseek-chat' → provider 'deepseek'；'qodercn/qfmodel'（无已知前缀）→ defaultProvider。
 * 注意 local 模型 id 本身带斜杠（local/qodercn/qfmodel），所以按"已知 provider id 前缀"匹配，
 * 不是按第一个斜杠切。
 */
export function resolveModelRef(cfg, ref) {
  const s = String(ref || '').trim()
  if (!s) return null
  for (const p of cfg.providers) {
    if (s === p.id || s.startsWith(p.id + '/')) {
      const model = s === p.id ? '' : s.slice(p.id.length + 1)
      return model ? { provider: p, model, ref: s } : null
    }
  }
  const p = cfg.providers.find(x => x.id === cfg.defaultProvider)
  if (p) return { provider: p, model: s, ref: `${p.id}/${s}` }
  return cfg.providers[0] ? { provider: cfg.providers[0], model: s, ref: `${cfg.providers[0].id}/${s}` } : null
}

/** provider 的 API key：apiKey > apiKeyEnv > apiKeyFile > cfg.apiKey 全局兜底 */
export function providerKey(cfg, provider) {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv]
  if (provider.apiKeyFile) {
    try { return fs.readFileSync(provider.apiKeyFile, 'utf8').trim() } catch { /* fall */ }
  }
  return cfg.apiKey || ''
}

export function mergeConfig(raw, opt = {}) {
  const cfg = { ...DEFAULTS, ...(raw || {}) }
  cfg.maxSteps = clampInt(cfg.maxSteps, 1, 12, DEFAULTS.maxSteps)
  cfg.candidatesPerStep = clampInt(cfg.candidatesPerStep, 1, 6, DEFAULTS.candidatesPerStep)
  cfg.stepTimeoutMs = clampInt(cfg.stepTimeoutMs, 5_000, 900_000, DEFAULTS.stepTimeoutMs)
  cfg.plannerTimeoutMs = clampInt(cfg.plannerTimeoutMs, 10_000, 900_000, DEFAULTS.plannerTimeoutMs)
  cfg.judgeRetries = clampInt(cfg.judgeRetries, 0, 3, DEFAULTS.judgeRetries)
  cfg.judgeTimeoutMs = clampInt(cfg.judgeTimeoutMs, 5_000, 300_000, DEFAULTS.judgeTimeoutMs)
  cfg.judgeToolMaxRounds = clampInt(cfg.judgeToolMaxRounds, 1, 8, DEFAULTS.judgeToolMaxRounds)
  cfg.judgeToolTimeoutMs = clampInt(cfg.judgeToolTimeoutMs, 10_000, 600_000, DEFAULTS.judgeToolTimeoutMs)
  cfg.catalogTtlMs = clampInt(cfg.catalogTtlMs, 0, 86_400_000, DEFAULTS.catalogTtlMs)
  cfg.timeoutByClass = { ...DEFAULTS.timeoutByClass, ...(cfg.timeoutByClass || {}) }
  for (const k of ['short', 'gen', 'analysis']) cfg.timeoutByClass[k] = clampInt(cfg.timeoutByClass[k], 5_000, 900_000, DEFAULTS.timeoutByClass[k])
  cfg.judge = cfg.judge === true
  cfg.judgeAdvisory = cfg.judgeAdvisory === true
  cfg.judgeTools = cfg.judgeTools === true
  if (!COST_TIERS_ALL.includes(String(cfg.maxCost))) cfg.maxCost = 'any'

  cfg.providers = normalizeProviders(cfg.providers, cfg)
  // providers 为空时兜底一个 local（baseUrl 取旧 baseUrl/apiKeyFile 兼容）
  if (!cfg.providers.length) {
    cfg.providers = normalizeProviders([{
      id: 'local',
      baseUrl: cfg.baseUrl || DEFAULTS.providers[0].baseUrl,
      apiKeyFile: cfg.apiKeyFile || DEFAULTS.providers[0].apiKeyFile,
      apiKey: cfg.apiKey,
    }], cfg)
  }
  if (!cfg.providers.some(p => p.id === cfg.defaultProvider)) cfg.defaultProvider = cfg.providers[0].id

  cfg.routes = (cfg.routes && typeof cfg.routes === 'object' && !Array.isArray(cfg.routes)) ? cfg.routes : { ...DEFAULT_ROUTES }
  cfg.pool = Array.isArray(cfg.pool) && cfg.pool.length ? cfg.pool.map(String).filter(Boolean) : [...DEFAULT_POOL]
  cfg.packs = (cfg.packs && typeof cfg.packs === 'object' && !Array.isArray(cfg.packs)) ? cfg.packs : {}
  cfg.tools = { ...DEFAULTS.tools, ...(cfg.tools || {}) }
  cfg.tools.maxRounds = clampInt(cfg.tools.maxRounds, 1, 10, DEFAULTS.tools.maxRounds)
  cfg.tools.resultMaxChars = clampInt(cfg.tools.resultMaxChars, 200, 50_000, DEFAULTS.tools.resultMaxChars)
  cfg.tools.use = Array.isArray(cfg.tools.use) && cfg.tools.use.length ? cfg.tools.use.map(String) : [...DEFAULTS.tools.use]
  cfg.matchMode = ['routes', 'dynamic', 'legacy'].includes(cfg.matchMode) ? cfg.matchMode : 'routes'
  cfg.baseUrl = cfg.providers.find(p => p.id === cfg.defaultProvider)?.baseUrl || cfg.providers[0].baseUrl
  return cfg
}

/** keys.local.json 加载：把 providers 的 apiKey 补进 cfg.providers（不落盘到配置里）。 */
export function applyKeysFile(cfg, keysPath) {
  if (!keysPath) return cfg
  try {
    const j = JSON.parse(fs.readFileSync(keysPath, 'utf8'))
    const kp = j?.providers || {}
    for (const p of cfg.providers) {
      const k = kp[p.id]
      if (k && typeof k === 'object') {
        if (typeof k.apiKey === 'string' && k.apiKey && !p.apiKey) p.apiKey = k.apiKey
        if (typeof k.apiKeyEnv === 'string' && !p.apiKeyEnv) p.apiKeyEnv = k.apiKeyEnv
        if (typeof k.apiKeyFile === 'string' && !p.apiKeyFile) p.apiKeyFile = k.apiKeyFile
      }
    }
  } catch { /* keys 文件缺失/损坏静默——走 apiKeyEnv/apiKeyFile 兜底 */ }
  return cfg
}
