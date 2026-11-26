/**
 * domain-pack.js — 领域包加载与注入（框架 v0.2：知识库按零件组织）
 *
 * 复用性原则（2026-11-15 定）：**框架代码里一个领域词都不许有**。
 * domains 由 pack.yml 声明；本文件只认识 'general' 兜底和"某个包声明的某个域"。
 * 换一个领域（视觉、云台、别的比赛）= 换一个目录，零代码改动。
 *
 * 目录结构（v0.2，知识库以零件为文件夹）：
 *   <root>/pack.yml                       domains 声明 + 包元数据
 *   <root>/catalog.yml                    零件目录（id/domain/api/interface/must_have）
 *   <root>/checklist/<task>.md            领域分解清单（planner 拆前必读）
 *   <root>/parts/<part-id>/
 *     ├─ templates/<名>.md                代码模板（front-matter: 状态/适用条件/来源）
 *     ├─ manual/<名>.md                   说明书蒸馏条目：[编号] 内容 | 来源: 文档 §章节
 *     └─ mistakes/mistakes.jsonl          该零件的错题（schema 同旧全局错题本）
 *   <root>/knowledge/<domain>.md          （旧布局，仍支持，加载时并入 manual）
 *   <root>/mistakes.jsonl                 （旧布局，仍支持，加载时并入 mistakes）
 *
 * 三条铁律仍是机械执行，不靠 prompt 恳求：
 *  1. 事实必须带来源（manual 条目无 "| 来源:" 拒收；模板无 状态/来源 视为 draft 不注入）
 *  2. 缺条目 = 未定义（占位符 → incomplete 零件；引用编号不存在 → missingRefs → incomplete）
 *  3. 拆分 = 选型（清单存在时封闭集；目录外步骤必须写自由拆分原因）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* 预算与常量                                                          */
/* ------------------------------------------------------------------ */

export const BUDGET = {
  plannerChecklist: 1500,
  plannerCatalog: 1200,
  executorContract: 2500,
  knowledgePerCall: 2000,
  judgeMustHave: 1200,
  judgeKnowledge: 2000,
  judgeMistakes: 1200,
  assemblyInterfaces: 3000,
}

/** 模板状态阶梯（§1 讨论定）：draft 不进检索；compiled 注入时标注"未上板"。 */
const TEMPLATE_STATES = ['draft', 'compiled', 'bench', 'production']
const INJECTABLE = new Set(['bench', 'production', 'compiled'])

const PLACEHOLDER_RE = /\[待说明书\]|\[待确认\]|\[TBD\]|<[^>]*待[^>]*>/i

/* ------------------------------------------------------------------ */
/* 交付物类型（artifact）：措辞模板，结构不变                             */
/* ------------------------------------------------------------------ */

/**
 * pack.yml `artifact:` 声明本包零件的交付物形态，注入构建器按它选措辞。
 * 结构（api 清单 / 三核对 / 查证顺序）不变，变的只是"产物长什么样"的描述。
 * v1 内置四类；machine-ops 远期预留（v1 复用 procedure 措辞）。
 */
export const ARTIFACTS = {
  firmware: {
    label: '固件代码',
    unit: '一个零件 = 一对 .h/.c 文件（用户习惯的文件级拆分）',
    deliverable: '输出 = 完整 .h（含头文件守卫+全部期望函数声明+单位注释）+ 完整 .c。接口单位没有手册依据的，必须在声明旁注释写明"单位未定义"。',
    judgeChecks: [
      '① 声明核对：.h 是否声明了全部期望函数（缺一个即 fail）',
      '② 实现核对：.c 是否实现每个声明（只声明不实现即 fail）',
      '③ 签名核对：声明与实现、与期望签名是否逐字一致（参数类型/数组维度/const 差异即 fail）',
    ],
  },
  procedure: {
    label: '操作程序',
    unit: '一个零件 = 一段可执行操作程序（编号步骤序列）',
    deliverable: '输出 = 完整操作程序：按序编号的步骤，每步含动作/参数/预期结果；参数无手册依据的必须注释"未定义：待说明书"。',
    judgeChecks: [
      '① 覆盖核对：程序是否覆盖目录全部期望项（缺一步即 fail）',
      '② 参数核对：每步参数/顺序是否与期望契约一致（改名/漏步/乱序即 fail）',
      '③ 依据核对：每个数值/阈值/时序能否指到 manual [编号]（凭记忆即 fail）',
    ],
  },
  document: {
    label: '文档交付物',
    unit: '一个零件 = 一个文档章节/交付物片段',
    deliverable: '输出 = 完整文档片段：结构完整、术语与数值有据；无手册依据的表述必须标注"未定义"。',
    judgeChecks: [
      '① 结构核对：文档是否覆盖目录全部期望要点（缺项即 fail）',
      '② 术语核对：术语/定义是否与 manual 条目一致（自创术语即 fail）',
      '③ 依据核对：关键论断能否指到 manual [编号]（凭记忆即 fail）',
    ],
  },
  'machine-ops': {
    label: '机器操作',
    unit: '一个零件 = 一段机器操作程序（命令序列/工艺步骤）',
    deliverable: '输出 = 完整操作程序：按序编号的工步，每步含设备命令/参数/预期状态；参数无手册依据的必须注释"未定义：待确认"。安全联锁参数必须显式给出，不得省略。',
    judgeChecks: [
      '① 覆盖核对：程序是否覆盖目录全部期望工步（缺步即 fail）',
      '② 参数核对：每步命令/参数是否与期望契约一致（越界参数即 fail）',
      '③ 安全核对：联锁/限值参数是否齐全且有 manual 依据（缺失即 fail）',
    ],
  },
}

export function artifactOf(pack) {
  const a = pack?.artifact
  return ARTIFACTS[a] || ARTIFACTS.firmware
}

/* ------------------------------------------------------------------ */
/* 极简解析（只认我们定的形状）                                          */
/* ------------------------------------------------------------------ */

function unq(v) {
  const s = String(v ?? '').trim()
  return s.replace(/^["']|["']$/g, '').trim()
}

/** 剥 BOM——Windows 记事本/PowerShell 写的 UTF8 常带 BOM，
 *  不剥的话首行正则（^parts: / ^name: / [编号]）静默不匹配，整文件当空（2026-11-15 实测抓到）。
 *  收口在 parse* 入口而不是调用点：调用点会增多，入口只有一个。 */
function deBom(s) { return String(s ?? '').replace(/^\uFEFF/, '') }

/** pack.yml: `domains:` 列表 + 顶层标量。
 *  `domains: []`（内联空数组）与 `domains:` + `- x` 两种写法都要归一成数组——
 *  前者若当字符串存，下游 .filter 直接崩（2026-11-15 空白包实测抓到）。 */
function parsePackYml(text) {
  const out = { domains: [], name: '', note: '', planner_hint: '', _hint: [] }
  let mode = null
  for (const raw of deBom(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (m) {
      const key = m[1]
      const val = m[2].trim()
      if (key === 'domains') {
        mode = 'domains'
        // 内联数组 [a, b] 或空数组 []
        if (val.startsWith('[')) {
          out.domains = val.replace(/^\[|\]$/g, '').split(',').map(s => unq(s)).filter(Boolean)
          mode = null
        } else if (val) {
          out.domains = [unq(val)]
          mode = null
        }
        continue
      }
      mode = val === '' ? key : null
      if (val) out[key] = unq(val)
      continue
    }
    const li = line.match(/^\s+-\s+(.+)$/)
    if (li && mode === 'domains') out.domains.push(unq(li[1]))
    // planner_hint 块：缩进行逐行累积（只能追加规划提示，铁律不可覆盖——保守版约定）
    if (mode === 'planner_hint') {
      const hm = line.match(/^\s+(.+)$/)
      if (hm) { out._hint.push(hm[1].trim()); continue }
    }
  }
  if (out._hint.length) out.planner_hint = out._hint.join('\n')
  delete out._hint
  out.domains = Array.isArray(out.domains) ? out.domains.filter(d => typeof d === 'string' && d) : []
  return out
}

/** catalog.yml: parts 列表，字段 domain/title/api/interface/must_have/judge_mode */
function parseCatalogYaml(text) {
  const lines = deBom(text).split(/\r?\n/)
  const parts = []
  let cur = null, mode = null, inParts = false
  const flush = () => { if (cur) parts.push(cur); cur = null; mode = null }
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^parts:\s*$/.test(line)) { inParts = true; continue }
    if (!inParts) continue
    const item = line.match(/^\s*-\s+id:\s*(.+)$/)
    if (item) { flush(); cur = { id: unq(item[1]), must_have: [], api: [], pitfalls: [], interface: {}, judge_mode: 'blocking' }; continue }
    if (!cur) continue
    const ifv = line.match(/^\s{2,}(input|output):\s*(.*)$/)
    if (ifv && mode === 'interface') { cur.interface[ifv[1]] = parseInlineMap(ifv[2]); continue }
    const kv = line.match(/^\s{2,}([a-z_]+):\s*(.*)$/)
    if (kv) {
      const [, key, val] = kv
      if (val.trim() === '') { mode = key; continue }
      if (key === 'must_have' || key === 'pitfalls' || key === 'api') { cur[key] = [unq(val)]; mode = key; continue }
      if (key === 'interface') { mode = 'interface'; continue }
      mode = null
      cur[key] = unq(val)
      continue
    }
    const li = line.match(/^\s{2,}-\s+(.+)$/)
    if (li && mode && ['must_have', 'pitfalls', 'api'].includes(mode)) { cur[mode].push(unq(li[1])); continue }
  }
  flush()
  return parts
}

function parseInlineMap(s) {
  const out = {}
  const str = String(s || '').trim().replace(/^\{|\}$/g, '')
  if (!str) return out
  const pieces = []
  let buf = '', inQ = null
  for (const ch of str) {
    if (inQ) { buf += ch; if (ch === inQ) inQ = null; continue }
    if (ch === '"' || ch === "'") { inQ = ch; buf += ch; continue }
    if (ch === ',') { pieces.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) pieces.push(buf)
  for (const p of pieces) {
    const m = p.match(/^\s*([a-z_]+)\s*:\s*(.*)$/i)
    if (m) out[m[1]] = unq(m[2])
  }
  return out
}

/** manual 条目：[编号] 内容 | 来源: xxx（无来源拒收） */
function parseManual(text, file, part) {
  const out = []
  for (const raw of deBom(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('[')) continue
    const m = line.match(/^\[([^\]]+)\]\s*([\s\S]*)$/)
    if (!m) continue
    const body = m[2]
    const srcIdx = body.lastIndexOf('| 来源:')
    if (srcIdx < 0) { out.push({ id: m[1], text: body, source: '', rejected: '缺来源', part, file }); continue }
    out.push({ id: m[1], text: body.slice(0, srcIdx).trim(), source: body.slice(srcIdx + 5).trim(), rejected: '', part, file })
  }
  return out
}

/** 模板：front-matter（状态/适用条件/来源）+ 代码正文 */
function parseTemplate(text, file, part) {
  const fm = {}
  let body = deBom(text)
  const m = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([^\u4e00-\u9fa5A-Za-z_]+)?\s*([^\u4e00-\u9fa5:]+):\s*(.*)$/i) || line.match(/^\s*(状态|适用条件|来源|标题):\s*(.*)$/)
      if (kv) { const key = (kv[1] || kv[2] || '').trim(); const val = (kv[2] ?? kv[3] ?? '').trim(); if (key) fm[key] = val }
    }
    body = body.slice(m[0].length)
  }
  const state = String(fm['状态'] || fm.state || 'draft').trim()
  return {
    name: file.replace(/\.(md|c|h|txt)$/, ''),
    part,
    state: TEMPLATE_STATES.includes(state) ? state : 'draft',
    applies: fm['适用条件'] || fm.applies || '',
    source: fm['来源'] || fm.source || '',
    code: body.trim(),
    file,
  }
}

function parseMistakesJsonl(text, part, warnings) {
  const out = []
  for (const raw of deBom(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m && m.domain && m['症状'] && m['修法']) out.push({ ...m, part: m.part || part })
      else warnings.push(`错题条目缺必填字段（domain/症状/修法），跳过: ${line.slice(0, 60)}`)
    } catch { warnings.push(`错题行非合法 JSON，跳过: ${line.slice(0, 60)}`) }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 加载器                                                              */
/* ------------------------------------------------------------------ */

// 多 pack 后缓存按 root 分槽（v1 改：原单槽会在多 pack 间互相挤掉）
const cache = new Map() // root -> { at, pack }

export function loadPack(root, opt = {}) {
  const ttl = opt.ttlMs ?? 30_000
  if (!root) return null
  const hit = cache.get(root)
  if (hit && hit.pack && Date.now() - hit.at < ttl) return hit.pack
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null
  } catch { return null }

  const warnings = []
  const meta = fs.existsSync(path.join(root, 'pack.yml'))
    ? parsePackYml(fs.readFileSync(path.join(root, 'pack.yml'), 'utf8'))
    : { domains: [], name: path.basename(root) }
  if (!fs.existsSync(path.join(root, 'pack.yml'))) warnings.push('缺 pack.yml：domains 将由零件声明推导')

  let parts = []
  const catFile = path.join(root, 'catalog.yml')
  if (fs.existsSync(catFile)) {
    try { parts = parseCatalogYaml(fs.readFileSync(catFile, 'utf8')) }
    catch (e) { warnings.push(`catalog 解析失败: ${e.message}`) }
  } else warnings.push('缺 catalog.yml：零件目录为空')

  // checklist
  const checklists = {}
  const clDir = path.join(root, 'checklist')
  if (fs.existsSync(clDir)) {
    try {
      for (const f of fs.readdirSync(clDir)) if (f.endsWith('.md')) checklists[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(clDir, f), 'utf8')
    } catch (e) { warnings.push(`checklist 读取失败: ${e.message}`) }
  }

  // 知识库：parts/<pid>/{templates,manual,mistakes}（v0.2 主结构）+ 旧布局兼容
  const knowledge = []   // manual 条目
  const templates = []
  const mistakes = []
  const partsDir = path.join(root, 'parts')
  if (fs.existsSync(partsDir)) {
    for (const pid of fs.readdirSync(partsDir)) {
      const pdir = path.join(partsDir, pid)
      if (!fs.statSync(pdir).isDirectory()) continue
      const tDir = path.join(pdir, 'templates')
      if (fs.existsSync(tDir)) {
        for (const f of fs.readdirSync(tDir)) {
          if (!/\.(md|c|h|txt)$/.test(f)) continue
          templates.push(parseTemplate(fs.readFileSync(path.join(tDir, f), 'utf8'), f, pid))
        }
      }
      const mDir = path.join(pdir, 'manual')
      if (fs.existsSync(mDir)) {
        for (const f of fs.readdirSync(mDir)) {
          if (!f.endsWith('.md')) continue
          for (const e of parseManual(fs.readFileSync(path.join(mDir, f), 'utf8'), f, pid)) {
            if (e.rejected) warnings.push(`parts/${pid}/${f} [${e.id}] 被拒：${e.rejected}`)
            else knowledge.push(e)
          }
        }
      }
      const mkDir = path.join(pdir, 'mistakes')
      if (fs.existsSync(mkDir)) {
        for (const f of fs.readdirSync(mkDir)) {
          if (!f.endsWith('.jsonl')) continue
          mistakes.push(...parseMistakesJsonl(fs.readFileSync(path.join(mkDir, f), 'utf8'), pid, warnings))
        }
      }
    }
  }
  // 旧布局并入（domain 从文件名推）
  const knDir = path.join(root, 'knowledge')
  if (fs.existsSync(knDir)) {
    for (const f of fs.readdirSync(knDir)) {
      if (!f.endsWith('.md')) continue
      for (const e of parseManual(fs.readFileSync(path.join(knDir, f), 'utf8'), f, '')) {
        if (e.rejected) warnings.push(`${f} [${e.id}] 被拒：${e.rejected}`)
        else { e.domainHint = f.replace(/\.md$/, ''); knowledge.push(e) }
      }
    }
  }
  const mkFile = path.join(root, 'mistakes.jsonl')
  if (fs.existsSync(mkFile)) mistakes.push(...parseMistakesJsonl(fs.readFileSync(mkFile, 'utf8'), '', warnings))

  // domains：pack.yml 声明优先；否则从零件推导 + general（框架代码不含任何领域词）
  const declared = meta.domains.filter(d => typeof d === 'string' && d)
  const derived = [...new Set(parts.map(p => p.domain).filter(d => d && d !== 'general'))]
  const domains = [...new Set(['general', ...declared, ...derived])]

  // 零件完整性（铁律 2）——knowledge 解析之后：
  //  - 占位 / 缺 interface / 缺 must_have / 缺 api → incomplete
  //  - must_have 引用的 [编号] 在 manual 不存在 → missingRefs → incomplete（空头支票）
  const kbIds = new Set(knowledge.map(k => k.id))
  for (const p of parts) {
    const blob = JSON.stringify(p)
    const refs = []
    for (const mh of p.must_have || []) for (const m of String(mh).matchAll(/\[([^\]§<>]{2,30})\]/g)) refs.push(m[1])
    p.missingRefs = [...new Set(refs.filter(r => !kbIds.has(r)))]
    p.incomplete = PLACEHOLDER_RE.test(blob) || !p.interface?.input || !p.interface?.output
      || !p.must_have?.length || !p.api?.length || p.missingRefs.length > 0
    p.domain = domains.includes(p.domain) ? p.domain : (p.domain ? `!${p.domain}` : 'general')
    // 该零件的模板状态摘要（注入门控在 executorInject 里执行）
    const ts = templates.filter(t => t.part === p.id)
    p.templateStates = ts.map(t => ({ name: t.name, state: t.state, applies: t.applies }))
    p.templatesInjectable = ts.filter(t => INJECTABLE.has(t.state))
  }

  const pack = {
    root, at: Date.now(),
    name: meta.name || path.basename(root),
    domains, parts, checklists, knowledge, templates, mistakes, warnings,
    artifact: typeof meta.artifact === 'string' && ARTIFACTS[meta.artifact] ? meta.artifact : 'firmware',
    plannerHint: typeof meta.planner_hint === 'string' ? meta.planner_hint.trim() : '',
    empty: !parts.length && !knowledge.length && !templates.length && !Object.keys(checklists).length,
  }
  cache.set(root, { at: Date.now(), pack })
  return pack
}

/* ------------------------------------------------------------------ */
/* planner 注入块（铁律 3：封闭集选型）                                  */
/* ------------------------------------------------------------------ */

export function plannerInject(pack, taskKey) {
  if (!pack || pack.empty) return ''
  const blocks = []
  const cl = (taskKey && pack.checklists[taskKey]) || Object.values(pack.checklists)[0]
  if (cl) blocks.push({ name: '领域分解清单（拆步前必读，优先按此选型）', text: cl, budget: BUDGET.plannerChecklist })

  const usable = pack.parts.filter(p => !p.incomplete)
  const skipped = pack.parts.length - usable.length
  if (usable.length) {
    const lines = usable.map(p =>
      `- ${p.id} [${p.domain}] ${p.title || ''} | 函数:${(p.api || []).length}个 入:${fmtIO(p.interface?.input)} 出:${fmtIO(p.interface?.output)}`)
    if (skipped) lines.push(`（另有 ${skipped} 个零件因含未定义字段/缺 api/缺手册条目被排除，不得选用）`)
    blocks.push({ name: '预定义零件目录', text: lines.join('\n'), budget: BUDGET.plannerCatalog })
  }
  if (!blocks.length) return ''
  let out = ''
  const dropped = []
  for (const b of blocks) {
    const head = `【${b.name}】\n`
    const room = b.budget - head.length - out.length - 2
    if (room < 80) { dropped.push(b.name); continue }
    out += head + clip(b.text, room) + '\n\n'
  }
  const art = artifactOf(pack)
  const rule = [
    '拆分规则（硬性）：',
    '1. 优先从上面目录**选型组装**，零件用其 id 原样填入 step.part；目录覆盖不到的才允许自由拆分，且必须写 "自由拆分": "原因"。',
    `2. 每个 step 必须给 domain，只能取：${pack.domains.join('|')}。`,
    '3. 禁止出现任何模型名或模型 id；禁止凭记忆写协议数值——具体事实由执行模型查知识库获得，查不到就写"未定义"。',
    '4. 清单要求的环节若在目录里没有对应零件，必须显式列为自由拆分步骤，不许默默漏掉。',
    `5. ${art.unit}；步骤 input 里写明目标产物名。`,
  ].join('\n')
  if (dropped.length) out += `（因预算限制本次未注入：${dropped.join('、')}）\n`
  out += '\n' + rule
  // pack.yml planner_hint：只能追加领域规划提示，铁律与 schema 不可覆盖（保守版约定）
  if (pack.plannerHint) out += `\n\n【领域规划提示（pack 作者补充，不改变上面硬性规则）】\n${pack.plannerHint}`
  return out
}

/* ------------------------------------------------------------------ */
/* 执行 AI 注入块（零件契约 + 查证顺序）【骨架，措辞待用户迭代】          */
/* ------------------------------------------------------------------ */

export function executorInject(pack, partId) {
  if (!pack || !partId) return ''
  const p = pack.parts.find(x => x.id === partId)
  if (!p) return ''
  const lines = [
    '【零件契约（本步的硬约束，裁判将逐条核对）】',
    `零件: ${p.id}（${p.title}） domain=${p.domain}`,
    p.api?.length ? `期望函数签名（.h 必须全部声明、.c 必须全部实现、逐字一致）：\n${p.api.map(a => '  ' + a).join('\n')}` : '',
    `数据接口: 入 ${fmtIO(p.interface?.input)} → 出 ${fmtIO(p.interface?.output)}`,
    p.must_have?.length ? `硬性验收：\n${p.must_have.map(x => '  - ' + x).join('\n')}` : '',
  ]
  if (p.templateStates?.length) {
    const ok = p.templateStates.filter(t => INJECTABLE.has(t.state))
    lines.push(`模板库: ${ok.length ? ok.map(t => `${t.name}[${t.state}]${t.applies ? `（适用: ${t.applies}）` : ''}`).join('、') : '无可注入模板'}`)
  }
  lines.push(
    '查证顺序（硬性）：',
    `1. 先 kb_search(part="${p.id}", kind=template) 找模板——有匹配适用条件的模板就基于它改，别从头编。`,
    `2. 没有模板 → kb_search(part="${p.id}", kind=manual) 查说明书条目，产物里的每个协议数值/字段/单位/参数都必须能指到某条 [编号]。`,
    `3. 写前 mistake_search(part="${p.id}") 看这个零件踩过什么坑。`,
    '4. 任何查不到的事实：在产物注释里写 `/* 未定义：待说明书 */`，不许用记忆补数。',
    artifactOf(pack).deliverable,
    '6. 若调用/引用前面零件的产物，必须先在上游输出的原文里核对契约，禁止凭印象。',
  )
  return clip(lines.filter(Boolean).join('\n'), BUDGET.executorContract)
}

/* ------------------------------------------------------------------ */
/* 裁判注入块【骨架——用户将改写措辞，结构勿动：三核对+强制查证+verdict】  */
/* ------------------------------------------------------------------ */

export function judgeContractInject(pack, partId) {
  if (!pack || !partId) return ''
  const p = pack.parts.find(x => x.id === partId)
  if (!p) return ''
  const art = artifactOf(pack)
  // 【待你改写】以下措辞，但保持核对结构与 verdict 形状——
  // 结构是机械的（api 清单来自 catalog，比对来自文本），措辞是你的。
  return clip([
    '【裁判契约——本步只审这一个零件，只查这个零件的手册】',
    `期望契约项（来自零件目录，不是你猜的）：\n${(p.api || []).map(a => '  ' + a).join('\n') || '  （目录无 api，判 advisory）'}`,
    `核对项（逐条给证据，全部通过才 pass）：`,
    ...art.judgeChecks.map(c => '  ' + c),
    `查证（强制）：判卷前必须 kb_search(part="${p.id}", kind=manual) 核对本零件涉及的协议数值；引用证据时带条目编号与来源。执行结果里出现未查证的记忆性数值 → 该条硬性要求 fail。`,
    p.templateStates?.some(t => t.state === 'compiled') ? '注意：本零件模板仅 compiled（未上板），判卷时对模板派生部分同样要对照 manual，不可默认模板正确。' : '',
    ...(p.missingRefs?.length ? [`⚠ 该零件有 ${p.missingRefs.length} 条 must_have 引用的手册条目不存在（${p.missingRefs.join('、')}）——这些条目无法核对，按"无法核对即 fail"处理并写入 critique 提醒补知识库。`] : []),
  ].filter(Boolean).join('\n'), BUDGET.judgeKnowledge + BUDGET.judgeMustHave)
}

/* ------------------------------------------------------------------ */
/* kb_search / mistake_search                                          */
/* ------------------------------------------------------------------ */

/* query 分词计分：整串 includes 会把 "通道 位" 这种多词查询判死（G12 实测抓到）。
 * 任一命中即候选，按命中词数*词长计分排序。 */
function termScore(hay, terms) {
  const h = hay.toLowerCase()
  let s = 0
  for (const t of terms) if (h.includes(t)) s += t.length
  return s
}

export function kbSearch(pack, args = {}) {
  const domain = String(args.domain || '').trim()
  const part = String(args.part || '').trim()
  const kind = ['template', 'manual', 'mistakes', 'all'].includes(args.kind) ? args.kind : 'all'
  if (!pack || pack.empty) return 'ERROR: 领域包未配置或为空。请先提供说明书并填充 domain-pack。'
  if (domain && !pack.domains.includes(domain)) return `ERROR: domain "${domain}" 不在本包声明的枚举内。可用：${pack.domains.join('|')}`
  if (part && !pack.parts.some(p => p.id === part)) return `ERROR: part "${part}" 不在零件目录内。`
  const query = String(args.query || '').trim()
  if (!query && !domain && !part) return 'ERROR: query/domain/part 至少给一个'
  const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean)

  const hits = []
  // 模板（状态门控：draft 永不出现；compiled 标注未上板）
  if (kind === 'template' || kind === 'all') {
    let ts = pack.templates.filter(t => INJECTABLE.has(t.state))
    if (part) ts = ts.filter(t => t.part === part)
    if (domain) ts = ts.filter(t => partDomainOf(pack, t.part) === domain)
    if (terms.length) ts = ts.map(t => ({ t, s: termScore(`${t.name} ${t.code} ${t.applies}`, terms) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.t)
    for (const t of ts.slice(0, 2)) {
      hits.push(`【模板 ${t.part}/${t.name}】状态=${t.state}${t.state === 'compiled' ? '（未上板，用前对照 manual）' : ''}${t.applies ? ` 适用: ${t.applies}` : ''}${t.source ? ` 来源: ${t.source}` : ''}\n${t.code.slice(0, 900)}`)
    }
  }
  // manual
  if (kind === 'manual' || kind === 'all') {
    let ks = pack.knowledge
    if (part) ks = ks.filter(k => k.part === part || (!k.part && k.domainHint === partDomainOf(pack, part)))
    if (domain) ks = ks.filter(k => !k.part && (k.domainHint === domain || partDomainOf(pack, k.part) === domain))
    if (terms.length) ks = ks.map(k => ({ k, s: termScore(`${k.id} ${k.text} ${k.source}`, terms) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.k)
    for (const k of ks.slice(0, 4)) hits.push(`[${k.id}]${k.part ? `(${k.part})` : ''} ${k.text} | 来源: ${k.source}`)
  }
  if (!hits.length) {
    return `未命中（part=${part || '-'}，domain=${domain || '-'}，kind=${kind}，query="${args.query || ''}"）。\n按铁律：该事实**未定义**，禁止用记忆补数。请在代码注释写明"未定义：待说明书"并继续其余部分。`
  }
  return clip(hits.join('\n'), BUDGET.knowledgePerCall)
}

export function mistakeSearch(pack, args = {}) {
  if (!pack || !pack.mistakes?.length) return '错题本为空（尚未经用户策展入库）。'
  const domain = String(args.domain || '').trim()
  const part = String(args.part || '').trim()
  if (domain && !pack.domains.includes(domain)) return `ERROR: domain "${domain}" 不在包枚举内：${pack.domains.join('|')}`
  let pool = pack.mistakes
  if (part) pool = pool.filter(m => m.part === part)
  else if (domain) pool = pool.filter(m => m.domain === domain)
  const query = String(args.query || '').trim().toLowerCase()
  if (query) pool = pool.filter(m => JSON.stringify(m).toLowerCase().includes(query))
  if (!pool.length) return `未命中（part=${part || '-'}，domain=${domain || '-'}，库内 ${pack.mistakes.length} 条）`
  return clip(pool.slice(0, 5).map(m =>
    `[${m.id}] ${m['症状']}\n  根因: ${m['根因'] || '未记录'}\n  修法: ${m['修法']}\n  验证: ${m['验证'] || '未记录'}\n  来源: ${m['来源'] || ''}`).join('\n'), BUDGET.knowledgePerCall)
}

function partDomainOf(pack, partId) {
  return pack?.parts.find(p => p.id === partId)?.domain || ''
}

/* ------------------------------------------------------------------ */
/* 工具规格（provider 注入）                                            */
/* ------------------------------------------------------------------ */

export function domainToolSpecs(getPack) {
  return [
    {
      type: 'function',
      function: {
        name: 'kb_search',
        description: '检索领域知识库。kind=template 找代码模板（仅注入已验证状态）；kind=manual 查说明书蒸馏条目（带来源）；kind=all 两者。**凡涉及协议字段、数值范围、公式系数、时序阈值，必须先查这里，禁止凭记忆写**。查不到会明确返回"未定义"，此时如实写进注释并继续，不许猜。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {
            part: { type: 'string', description: '零件 id（目录内），最精确的检索键' },
            domain: { type: 'string', description: '领域（本包 pack.yml 声明的枚举）' },
            query: { type: 'string', description: '关键词，如 "通道 位宽" 或 "超时 清零"' },
            kind: { type: 'string', enum: ['template', 'manual', 'mistakes', 'all'], description: '检索面，默认 all' },
          },
        },
      },
      run: (args) => kbSearch(getPack(), args),
    },
    {
      type: 'function',
      function: {
        name: 'mistake_search',
        description: '检索错题本（用户确认过的历史故障：症状/根因/修法/验证）。参数 part（零件 id，优先）或 domain。写同类零件前应先查。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {
            part: { type: 'string', description: '零件 id' },
            domain: { type: 'string', description: '领域' },
            query: { type: 'string', description: '可选：症状关键词' },
          },
        },
      },
      run: (args) => mistakeSearch(getPack(), args),
    },
  ]
}

/* ------------------------------------------------------------------ */
/* 计划级检查（总装裁判①②）与辅助                                       */
/* ------------------------------------------------------------------ */

export function fmtIO(io) {
  if (!io || typeof io !== 'object') return '?'
  const bits = [io.type || io.name].filter(Boolean)
  if (io.range) bits.push(`范围${io.range}`)
  if (io.unit) bits.push(io.unit)
  return bits.join('/') || '?'
}

export function checkInterfaces(parts) {
  const issues = []
  for (let i = 0; i < parts.length - 1; i++) {
    const up = parts[i]?.interface?.output, dn = parts[i + 1]?.interface?.input
    const pair = `${parts[i].id} -> ${parts[i + 1].id}`
    if (!up || !dn) { issues.push({ pair, kind: 'missing', detail: '接口签名不完整，无法核对' }); continue }
    const blob = JSON.stringify([up, dn])
    if (PLACEHOLDER_RE.test(blob)) { issues.push({ pair, kind: 'undefined', detail: '含未定义字段，按铁律不得猜测' }); continue }
    if (up.type && dn.type && up.type !== dn.type) issues.push({ pair, kind: 'type', detail: `输出类型 ${up.type} != 输入期望 ${dn.type}` })
    if (up.range && dn.range && up.range !== dn.range) issues.push({ pair, kind: 'range', detail: `输出范围 ${up.range} != 输入期望 ${dn.range}` })
    if (up.unit && dn.unit && up.unit !== dn.unit) issues.push({ pair, kind: 'unit', detail: `输出单位 ${up.unit} != 输入期望 ${dn.unit}` })
  }
  return { ok: !issues.some(x => ['type', 'undefined', 'missing'].includes(x.kind)), issues }
}

export function checkCoverage(checklistText, usedParts, domains) {
  if (!checklistText) return { ok: true, missing: [], note: '无清单，跳过覆盖检查' }
  const ids = new Set((usedParts || []).map(p => p.part || p.id).filter(Boolean))
  const usedDomains = new Set((usedParts || []).map(p => p.domain).filter(Boolean))
  const enumDomains = domains && domains.length ? domains : ['general']
  const missing = []
  for (const raw of deBom(checklistText).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const idHits = line.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}\b/g) || []
    for (const h of idHits) {
      if (enumDomains.includes(h)) continue
      if (/^[a-z]+-[a-z0-9-]+$/.test(h) && !ids.has(h) && !line.includes('可选')) missing.push({ kind: 'part', ref: h, line: line.slice(0, 80) })
    }
    for (const d of enumDomains) {
      if (line.includes(d) && !usedDomains.has(d) && !line.includes('可选')) missing.push({ kind: 'domain', ref: d, line: line.slice(0, 80) })
    }
  }
  const uniq = [...new Map(missing.map(m => [`${m.kind}:${m.ref}`, m])).values()]
  return { ok: !uniq.length, missing: uniq, note: uniq.length ? `清单要求但计划未覆盖：${uniq.map(m => m.ref).join('、')}` : '' }
}

function clip(s, n) {
  const t = String(s ?? '')
  return t.length <= n ? t : t.slice(0, n) + '…[截断]'
}

/* ------------------------------------------------------------------ */
/* pack 注册表：cfg.packs 映射 + packsDir 扫描（多 pack / 模式切换）       */
/* ------------------------------------------------------------------ */

/**
 * 可用 pack 清单：{ <名>: <绝对路径> }。
 * 来源合并：cfg.packs 显式映射优先；cfg.packsDir（空→<项目>/packs）下
 * 每个含 pack.yml 或 catalog.yml 的子目录自动注册，目录名=pack 名（不覆盖显式映射）。
 */
export function packRoots(cfg = {}) {
  const out = {}
  const dir = cfg.packsDir || path.resolve(HERE, '..', '..', 'packs')
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        try {
          if (fs.statSync(p).isDirectory() && (fs.existsSync(path.join(p, 'pack.yml')) || fs.existsSync(path.join(p, 'catalog.yml')))) {
            out[name] = p
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* dir unreadable → 只用显式映射 */ }
  for (const [name, p] of Object.entries(cfg.packs || {})) {
    if (typeof p === 'string' && p) out[name] = p
  }
  return out
}

/**
 * 选 pack 根目录。
 *  name 显式给：先查注册表；查不到但 name 本身是存在的目录 → 当路径直用（CLI --pack 便利）。
 *  name 缺省：cfg.defaultPack → 唯一 pack → 否则 null（多 pack 无默认 = 不猜，pack off）。
 */
export function resolvePackRoot(cfg = {}, name) {
  const roots = packRoots(cfg)
  const want = String(name || cfg.defaultPack || '').trim()
  if (want) {
    if (roots[want]) return roots[want]
    try { if (fs.existsSync(want) && fs.statSync(want).isDirectory()) return want } catch { /* not a path */ }
    return null
  }
  const names = Object.keys(roots)
  if (names.length === 1) return roots[names[0]]
  return null
}

/** 按名取 pack 实例（含缓存）；解析不到返回 null。 */
export function loadPackFor(cfg = {}, name, opt = {}) {
  const root = resolvePackRoot(cfg, name)
  return root ? loadPack(root, opt) : null
}

export { PLACEHOLDER_RE, TEMPLATE_STATES, INJECTABLE }
