/**
 * channel.js — 唯一网络出口：OpenAI 兼容 chat/completions，多 provider。
 *
 * 职责边界（写死）：
 *  1. 所有 LLM 调用只走 chat()——planner/executor/judge/工具环无一例外。
 *  2. 失败分类 = Fail.reason：timeout/http/network/empty/rate/auth/aborted/no-tools。
 *     下游（runStep 换候选、runToolLoop 降级、stats 分桶）全依赖这里分类正确。
 *  3. 双超时源：本地 timer + outerSignal（宿主 abort），谁先到都进同一 AbortController。
 *  4. opts.full=true 时返回 { content, tool_calls }（工具环用）；否则只回 content 字符串。
 *
 * 模型引用：`<providerId>/<modelName>`（config.resolveModelRef 解析）。
 */

import { resolveModelRef, providerKey } from './config.js'

export class Fail extends Error {
  constructor(reason, detail, opts = {}) {
    super(detail || reason)
    this.reason = reason
    // rate 是"现在不行"不是"这模型差"：带冷却，runStep 可短冷却重试
    this.cooldownMs = opts.cooldownMs ?? (reason === 'rate' ? 15_000 : 0)
  }
}

/**
 * @param cfg 合并后的配置
 * @param modelRef 'provider/model' 或裸 model（走 defaultProvider）
 * @param messages OpenAI 格式消息数组
 * @param timeoutMs 本次调用墙钟预算
 * @param outerSignal 宿主中断信号（可选）
 * @param opts { effort, tools(OpenAI tools 数组), maxTokens, full }
 * @returns string（默认）| { content, tool_calls }（opts.full）
 */
export async function chat(cfg, modelRef, messages, timeoutMs, outerSignal, opts = {}) {
  const resolved = resolveModelRef(cfg, modelRef)
  if (!resolved) throw new Fail('config', `model ref "${modelRef}" 无法解析到 provider`)
  const { provider, model } = resolved
  const key = providerKey(cfg, provider)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Fail('timeout', `timeout after ${timeoutMs}ms`)), timeoutMs)
  const relay = () => ctrl.abort(new Fail('aborted', 'caller aborted'))
  if (outerSignal) { if (outerSignal.aborted) relay(); else outerSignal.addEventListener('abort', relay, { once: true }) }

  try {
    const body = {
      model, messages, stream: false, temperature: 0.2,
      ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(Array.isArray(opts.tools) && opts.tools.length ? { tools: opts.tools } : {}),
    }
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* malformed */ }

    if (!res.ok) {
      const msg = (json?.error?.message || text).slice(0, 300)
      // no-tools：网关/上游不认 tools 参数（HTTP 4xx 且消息提到 tool/function）——
      // runToolLoop 据此做"同候选降级重打"，不烧候选名额
      if ((res.status === 400 || res.status === 422) && /tool|function/i.test(msg)) {
        throw new Fail('no-tools', `HTTP ${res.status}: ${msg}`)
      }
      const reason = res.status === 429 ? 'rate' : (res.status === 401 || res.status === 403) ? 'auth' : 'http'
      throw new Fail(reason, `HTTP ${res.status}: ${msg}`)
    }
    const msg = json?.choices?.[0]?.message
    const content = msg?.content
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
    const hasContent = typeof content === 'string' && content.trim()
    // 空输出算失败（免费池实测：429 常伪装成 200+空）；唯一例外：带 tool_calls 的空 content
    // 是"模型选择先调工具"，不算没说话
    if (!hasContent && !toolCalls.length) throw new Fail('empty', 'model returned empty content')
    if (opts.full) return { content: typeof content === 'string' ? content : '', tool_calls: toolCalls, model: resolved.ref }
    return typeof content === 'string' ? content : ''
  } catch (e) {
    if (e instanceof Fail) throw e
    if (e?.name === 'AbortError') throw new Fail(ctrl.signal.reason?.reason || 'timeout', String(ctrl.signal.reason?.message || e.message))
    throw new Fail('network', String(e?.message || e))
  } finally {
    clearTimeout(timer)
    if (outerSignal) outerSignal.removeEventListener('abort', relay)
  }
}
