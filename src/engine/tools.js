/**
 * tools.js — 执行模型的步内工具（v0.6 · 流程 A：工具环嵌在单步执行内部）
 *
 * 三条边界（写死，别越过）：
 *  1. 内置工具是「纯计算」：无文件、无网络、无副作用、确定性输出 → 全离线可测。
 *     （v0.8 例外：领域包工具 kb_search/mistake_search 是**只读**文件访问，
 *      路径白名单在 domain-pack 的加载器里结构性封死——只认 domain-pack 目录，
 *      不接受任意路径参数，所以不违反"无副作用"，但违反"无 I/O"，此处如实记录。）
 *  2. 工具错误是数据不是异常：executeTool 永远返回字符串（出错以 "ERROR: " 开头），
 *     回填给模型自己改；只有传输层失败才换模型——两类失败不许混。
 *  3. 模型给的字符串绝不进解释器：evalExpr 手写递归下降，不用 eval/Function。
 *     加工具 = 在 TOOL_REGISTRY 里加一个 { description, parameters, run }。
 */

import { domainToolSpecs } from './domain-pack.js'

/* ---------------- 安全算术求值（递归下降） ---------------- */

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  pow: Math.pow, log: Math.log, log10: Math.log10, exp: Math.exp,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
}

/**
 * 求值算术表达式。语法：
 *   expr    := term (('+'|'-') term)*
 *   term    := unary (('*'|'/'|'%') unary)*
 *   unary   := ('-'|'+') unary | power
 *   power   := primary ('^' unary)?        // 右结合：2^3^2 = 2^(3^2) = 512
 *   primary := number | '(' expr ')' | ident '(' args ')'
 * 出错抛 Error（带位置）；结果非有限（除零等）也抛错——不返回 Infinity/NaN。
 */
export function evalExpr(src) {
  const s = String(src)
  let i = 0
  const err = (msg) => { throw new Error(`${msg} (pos ${i})`) }
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }

  const parseExpr = () => {
    let v = parseTerm()
    for (;;) {
      ws()
      if (s[i] === '+') { i++; v += parseTerm() }
      else if (s[i] === '-') { i++; v -= parseTerm() }
      else return v
    }
  }
  const parseTerm = () => {
    let v = parseUnary()
    for (;;) {
      ws()
      if (s[i] === '*') { i++; v *= parseUnary() }
      else if (s[i] === '/') { i++; v /= parseUnary() }
      else if (s[i] === '%') { i++; v %= parseUnary() }
      else return v
    }
  }
  const parseUnary = () => {
    ws()
    if (s[i] === '-') { i++; return -parseUnary() }
    if (s[i] === '+') { i++; return parseUnary() }
    return parsePower()
  }
  const parsePower = () => {
    const base = parsePrimary()
    ws()
    if (s[i] === '^') { i++; return Math.pow(base, parseUnary()) }
    return base
  }
  const parsePrimary = () => {
    ws()
    if (s[i] === '(') {
      i++
      const v = parseExpr()
      ws()
      if (s[i] !== ')') err('expected ")"')
      i++
      return v
    }
    const num = /^(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(s.slice(i))
    if (num) { i += num[0].length; return Number(num[0]) }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (id) {
      i += id[0].length
      ws()
      if (s[i] !== '(') err(`unknown identifier "${id[0]}"`)
      const fn = FUNCS[id[0]]
      if (!fn) err(`unknown function "${id[0]}"`)
      i++ // 吃掉 '('
      const args = []
      ws()
      if (s[i] !== ')') {
        for (;;) {
          args.push(parseExpr())
          ws()
          if (s[i] === ',') { i++; continue }
          break
        }
      }
      ws()
      if (s[i] !== ')') err('expected ")"')
      i++
      if (args.length < 1) err(`${id[0]} needs at least 1 argument`)
      return fn(...args)
    }
    err(s[i] === undefined ? 'unexpected end of expression' : `unexpected token "${s[i]}"`)
  }

  const v = parseExpr()
  ws()
  if (i < s.length) err(`unexpected token "${s[i]}"`)
  if (!Number.isFinite(v)) err('result is not finite (division by zero?)')
  return v
}

/* ---------------- 两个内置工具 ---------------- */

function runCalc(args) {
  const expr = args?.expression
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('expression must be a non-empty string')
  if (expr.length > 500) throw new Error('expression too long (max 500)')
  const v = evalExpr(expr)
  // 显示收口：整数原样（≤2^53 精确），非整数按 12 位有效数字——0.1+0.2 显示 0.3 而不是浮点尾巴
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)))
}

function runRegexTest(args) {
  const pattern = args?.pattern
  const input = args?.input
  const flags = args?.flags === undefined || args?.flags === null ? '' : String(args.flags)
  if (typeof pattern !== 'string' || !pattern) throw new Error('pattern must be a non-empty string')
  if (typeof input !== 'string') throw new Error('input must be a string')
  if (pattern.length > 500) throw new Error('pattern too long (max 500)')
  if (input.length > 10_000) throw new Error('input too long (max 10000)')
  if (flags.length > 5 || !/^[gimsuy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error(`invalid flags "${flags}" (allowed: gimsuy, no duplicates)`)
  }
  let re
  try { re = new RegExp(pattern, flags) } catch (e) { throw new Error(`invalid regular expression: ${e.message}`) }
  if (!flags.includes('g')) {
    const m = re.exec(input)
    if (!m) return JSON.stringify({ match: false })
    return JSON.stringify({ match: true, matched: m[0], index: m.index, groups: m.slice(1) })
  }
  // g 模式：数总匹配数（封顶 1000），并防空匹配死循环
  let total = 0
  let first = null
  re.lastIndex = 0
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (first === null) first = m
    total++
    if (total >= 1000) break
    if (m[0] === '') re.lastIndex++
  }
  if (!first) return JSON.stringify({ match: false, total: 0 })
  return JSON.stringify({ match: true, matched: first[0], groups: first.slice(1), total })
}

/* ---------------- 注册表与执行入口 ---------------- */

export const TOOL_REGISTRY = {
  calc: {
    description: '精确计算算术表达式。支持 + - * / % ^、括号、科学计数（如 1e3），以及 sqrt/abs/round/floor/ceil/min/max/pow/log/log10/exp 函数。返回结果字符串；出错返回 "ERROR: " 开头的说明。凡是需要计算的地方都调用它，不要心算。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: '算术表达式，如 "123*(45+6)"、"sqrt(2)"、"2^10"' },
      },
    },
    run: runCalc,
  },
  regex_test: {
    description: '用 JavaScript 正则引擎实测字符串。参数 pattern（正则源码）、input（被测字符串）、flags（可选，gimsuy）。返回 JSON：{"match":true,"matched":"…","groups":[…],"total":N} 或 {"match":false}；出错返回 "ERROR: " 说明。验证正则行为时必须实测，不要凭记忆断言匹配结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern', 'input'],
      properties: {
        pattern: { type: 'string', description: '正则表达式源码（不含斜杠）' },
        input: { type: 'string', description: '被测字符串' },
        flags: { type: 'string', description: '可选标志，gimsuy 的组合' },
      },
    },
    run: runRegexTest,
  },
}

/** 注册表 → OpenAI tools 数组；use 里的未知名字直接过滤（Object.hasOwn 防原型链混入）。 */
export function toolSpecs(use) {
  const names = Array.isArray(use) && use.length ? use : Object.keys(TOOL_REGISTRY)
  return names.filter(n => Object.hasOwn(TOOL_REGISTRY, n)).map(name => ({
    type: 'function',
    function: {
      name,
      description: TOOL_REGISTRY[name].description,
      parameters: TOOL_REGISTRY[name].parameters,
    },
  }))
}

/**
 * v0.8：注册领域包工具（kb_search / mistake_search）。
 * getPack 是 provider 注入——tools.js 不认识 pack 实例，只认识 getter，
 * 于是离线测试可以塞假 pack，运行时塞真 pack，注册表本身不持有状态。
 * 重复调用安全（幂等覆盖）。
 */
export function registerDomainTools(getPack) {
  const specs = domainToolSpecs(getPack)
  const added = []
  for (const s of specs) {
    const f = s.function
    TOOL_REGISTRY[f.name] = { description: f.description, parameters: f.parameters, run: s.run }
    added.push(f.name)
  }
  return added
}

/**
 * 执行一个工具调用。永远返回字符串：
 *   成功 → 工具自己的输出；失败 → "ERROR: " + 原因。
 * 模型给的参数坏掉（非对象、缺字段、越界）都走 ERROR 分支，绝不抛到传输层。
 */
export function executeTool(name, args) {
  const t = Object.hasOwn(TOOL_REGISTRY, String(name)) ? TOOL_REGISTRY[name] : null
  if (!t) return `ERROR: unknown tool "${name}". Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`
  try {
    const out = t.run(args && typeof args === 'object' ? args : {})
    return typeof out === 'string' ? out : JSON.stringify(out)
  } catch (e) {
    return `ERROR: ${String(e?.message || e)}`
  }
}
