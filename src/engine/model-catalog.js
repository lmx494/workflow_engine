/**
 * model-catalog — L1 能力元数据（来源：网关 GET /v1/models 的 name/input/reasoning）
 *
 * - loadCatalog(cfg, fs)：实时拉取；网关不可达时退回 SNAPSHOT（2026-11-07 抓取）。
 * - profileOf(cat, id)：归一化出 cost/modality/reasoning/speed，供 match.js 打分。
 * L1 拿不到的字段（function_call 支持、绝对 ctx 窗口、真实质量档）保持 null，
 * 由调用方按保守档处理，不做无依据的臆测。
 */

import { providerKey } from './config.js'

export const SNAPSHOT = {
  'deepseek-account/deepseek-flash': { name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'], efforts: ['none', 'low', 'high', 'max'], def: 'high' },
  'qodercn/auto': { name: 'Auto · x0.5', input: ['text', 'image'], efforts: null, def: null },
  'qodercn/dfmodel': { name: 'DeepSeek-Flash · x0.1', input: ['text', 'image'], efforts: ['none', 'low', 'high', 'max'], def: 'none' },
  'qodercn/dmodel': { name: 'DeepSeek-V4-Pro · x0.5', input: ['text'], efforts: ['none', 'high', 'max'], def: 'high' },
  'qodercn/gfmodel': { name: 'GLM-5.3-Flash · x0.1', input: ['text', 'image'], efforts: ['high', 'max'], def: 'high' },
  'qodercn/gmodel': { name: 'GLM-5.3 · x0.8', input: ['text', 'image'], efforts: ['low', 'high', 'max'], def: 'high' },
  'qodercn/kmodel': { name: 'Kimi-K2.8-Preview · x0.8', input: ['text', 'image'], efforts: ['low', 'high', 'max'], def: 'high' },
  'qodercn/kmodel_latest': { name: 'Kimi-K3 · x1.4', input: ['text', 'image'], efforts: ['low', 'high', 'max'], def: 'high' },
  'qodercn/mmodel': { name: 'MiniMax-M2.7 · x0.2', input: ['text'], efforts: null, def: null },
  'qodercn/q37fmodel': { name: 'Qwen3.7-Flash · x0.1', input: ['text', 'image'], efforts: null, def: null },
  'qodercn/qfmodel': { name: 'Qwen3.8-Flash · 免费', input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'xhigh'], def: 'medium' },
  'qodercn/qmodel': { name: 'Qwen3.7-Plus · x0.1', input: ['text', 'image'], efforts: ['none'], def: 'none' },
  'qodercn/qmodel_38max': { name: 'Qwen3.8-Max · x0.5', input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'xhigh'], def: 'xhigh' },
  'qodercn/qmodel_latest': { name: 'Qwen3.7-Max · x0.5', input: ['text', 'image'], efforts: ['none'], def: 'none' },
  'loomy/DeepSeek-V4.1-Flash': { name: 'DeepSeek V4.1 Flash · x2.0', input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'high', 'xhigh'], def: null },
  'loomy/GLM-5.3-Flash': { name: 'GLM 5.3 Flash · x0.8', input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'high', 'xhigh'], def: null },
  'loomy/qwen3.8-flash': { name: 'qwen 3.8 flash · x0.8', input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'high', 'xhigh'], def: null },
  'loomy/spark-x2.6': { name: 'Spark-X2.6 正式版(限时免费) · x0.0', input: ['text'], efforts: ['none', 'low', 'medium', 'high', 'xhigh'], def: null },
  'minimax/MiniMax-M3.1-Flash': { name: 'M3.1-Flash', input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], def: 'low' },
  'zcode/GLM-5.3': { name: 'GLM-5.3', input: ['text'], efforts: ['low', 'high', 'max'], def: 'high' },
  'zcode/GLM-5.3-Flash': { name: 'GLM-5.3-Flash', input: ['text', 'image'], efforts: ['low', 'high', 'max'], def: 'high' },
  'our-free-model/kilo-auto/free': { name: 'Kilo Auto Free', input: ['text'], efforts: ['low', 'medium', 'high'], def: 'low' },
  'our-free-model/combo:recommended-free': { name: '推荐免费组', input: ['text'], efforts: ['low'], def: 'low' },
  'our-free-model/nvidia/nemotron-3.5-lightning:free': { name: 'Kilo Nemotron 3.5 Lightning', input: ['text'], efforts: ['low', 'medium', 'high'], def: 'high' },
  'our-free-model/minimaxai/minimax-m3.1-flash': { name: 'EAC Minimax M3 1 Flash', input: ['text'], efforts: ['low'], def: 'low' },
}//对象

const NAME_RE = /^(.*?)\s*(?:·|•)\s*(免费|限时免费|x([\d.]+))\s*$/u

/** name → { label, costLabel, costN }；costN：0=免费，数字=倍率，null=定价未知 */
export function parseName(name) {
  const m = String(name || '').match(NAME_RE)
  if (!m) return { label: String(name || ''), costLabel: null, costN: null }
  const costLabel = m[2]
  const costN = costLabel.startsWith('x') ? Number(m[3]) : 0
  return { label: m[1].trim(), costLabel, costN }
}

const EFFORT_RANK = { none: 0, low: 1, balanced: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

/**
 * 思考能力上限，三态（2026-11-08 改，原为两态）：
 *   null = 网关没给 efforts，**不知道**能不能思考 → 调用方不得据此淘汰
 *   0    = 明确只有 none 档，**确实**不假思考    → 可以据此淘汰
 *   1..5 = 能开到的最高档
 * 旧版把这两种情况都返回 0，导致 q37fmodel/qmodel/mmodel/auto 这类"元数据缺失"
 * 的模型被 reason:required 硬淘汰（实测池内 5 个受害者）。
 */
export function effortCap(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return null
  return Math.max(...efforts.map(e => EFFORT_RANK[e] ?? 0))
}

/**
 * 速度档：1(快)…5(慢)，纯名称启发；**没有依据时返回 null**（旧版返回 2，
 * 而 match.js 的 normal 权重数组里档 2 恰好是最高分，等于"不知道"比"知道很快"
 * 得分更高）。有 stats.p50_ms 后应由实测覆盖，见 match.js。
 * 注：档 2 现在没有任何分支产生它（原唯一来源就是这条未知路径）。
 */
export function speedHint(label, efforts) {
  if (/flash|lightning|mini|nano|small|spark/i.test(label)) return 1
  if (/auto|combo|组|router|自动|均衡/i.test(label)) return 3
  if (/ultra|super|k3|kimi-k3|pro|preview|3\.8-max|38max/i.test(label)) return 4
  if (/max|plus/i.test(label)) return 3
  if (!Array.isArray(efforts) || !efforts.length) return null
  return 3
}

export function profileOf(cat, id) {
  const raw = cat[id]
  if (!raw) {
    // 目录里没有这个 id：能力与速度都是「未知」，不是「最差」
    return { id, known: false, label: id, costLabel: null, costN: null, modality: ['text'], efforts: null, def: null, cap: null, speed: null, opaque: true, router: false }
  }
  const { label, costLabel, costN } = parseName(raw.name)
  const input = Array.isArray(raw.input) && raw.input.length ? raw.input : ['text']
  const efforts = Array.isArray(raw.efforts) && raw.efforts.length ? raw.efforts : null
  return {
    id, known: true, label, costLabel, costN,
    modality: input,
    efforts, def: raw.def || null, cap: effortCap(efforts),
    speed: speedHint(label, efforts),
    opaque: costN == null,                        // 名称无倍率 → 定价未知
    reasonUnknown: !efforts,                      // 网关没给 efforts → 思考能力未知
    // 2026-11-11：description 接进 router 判定——combo 的 "5-model chain: a -> b -> c"
    // 是结构化信号，比"组"这个中文字可靠。联合 name + description 一起测。
    router: /auto|combo|组|router|chain/i.test(label + ' ' + (raw.description || '')),
    // combo 链序解析：description 里 "N-model chain: a -> b -> c" → 数组，供 stats 当先验
    chain: resolveChain(parseChain(raw.description), cat, id),
  }
}

/** 从 description 解析 combo 链序："5-model chain: a -> b -> c" → ['a','b','c'] */
function parseChain(desc) {
  if (!desc || typeof desc !== 'string') return null
  const m = desc.match(/(\d+)-model\s+chain:\s*(.+)/i)
  if (!m) return null
  const ids = m[2].split('->').map(s => s.trim()).filter(Boolean)
  return ids.length >= 2 ? ids : null
}

/**
 * 链内短名 → 目录 id。实测（check-chain-live）网关 description 写的是**去掉 provider 前缀的短名**
 * （kilo-auto/free），而目录 id 是 our-free-model/kilo-auto/free —— 不解析就永远匹配不上，先验形同虚设。
 * 三级解析：① 精确 id ② 本条目自身前缀拼接 ③ 后缀唯一命中；都失败留 null 占位（保后面成员的链序位置）。
 * 同名多条目（如 our-free-model/deepseek-v4.1-flash-free 与 .../opencode/deepseek-v4.1-flash-free）
 * 按 id 序相邻排列——不猜哪个更"对"，但保证确定性。
 */
function resolveChain(names, cat, selfId) {
  if (!names) return null
  const ids = Object.keys(cat)
  const prefix = selfId.includes('/') ? selfId.slice(0, selfId.indexOf('/') + 1) : ''
  const out = []
  for (const n of names) {
    if (ids.includes(n)) out.push(n)
    else if (prefix && ids.includes(prefix + n)) out.push(prefix + n)
    else {
      const hit = ids.filter(k => k.endsWith('/' + n)).sort()
      if (hit.length) out.push(...hit)
      else out.push(null)
    }
  }
  return out
}

const cache = { at: 0, catalog: null, source: 'none' }

/** 拉实时目录；失败退回 SNAPSHOT。source 标记数据来源，供调用方在结果里如实上报。
 *  v1 多 provider：能力表只对 catalog provider（defaultProvider，通常 local 网关）有意义——
 *  直连官方 API 没有富元数据（定价/模态/reasoning），dynamic 模式主要服务 local 池。 */
export async function loadCatalog(cfg, fs, ttlMs = 10 * 60_000) {
  if (cache.catalog && Date.now() - cache.at < ttlMs) return cache.catalog
  try {
    const provider = (cfg.providers || []).find(p => p.id === cfg.defaultProvider) || (cfg.providers || [])[0]
    if (!provider) throw new Error('no provider')
    const key = providerKey(cfg, provider)
    const res = await fetch(`${provider.baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const cat = {}
    for (const m of (j?.data || [])) cat[m.id] = { name: m.name ?? m.id, input: m.input, efforts: m.reasoning?.openai_efforts ?? null, def: m.reasoning?.default ?? null, description: m.description ?? null }
    if (!Object.keys(cat).length) throw new Error('empty /models')
    cache.catalog = cat; cache.at = Date.now(); cache.source = 'live'
    return cat
  } catch {
    cache.catalog = SNAPSHOT; cache.at = Date.now(); cache.source = 'snapshot'
    return SNAPSHOT
  }
}

export function catalogSource() { return cache.source }
