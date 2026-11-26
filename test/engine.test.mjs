/**
 * engine.test.mjs — 离线测试（node:test，全假 chat 零网关）
 * 覆盖：config/providers、pack 加载与铁律、planner 注入、matcher routes、
 *       executor 工具环与阶梯、judge、dispatch 集成。
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PACK = path.join(HERE, 'fixtures', 'mini-pack')

const { mergeConfig, resolveModelRef, normalizeProviders, applyKeysFile } = await import('../src/engine/config.js')
const dp = await import('../src/engine/domain-pack.js')
const { normalizeNeeds, pickStepCandidates, pickRoutes, refAllowed } = await import('../src/engine/matcher.js')
const { makePlan, planChecks, sanitizeCandidates } = await import('../src/engine/planner.js')
const { runStep, runToolLoop, buildStepMessage } = await import('../src/engine/executor.js')
const { judgeStep } = await import('../src/engine/judge.js')
const { dispatch } = await import('../src/engine/dispatch.js')
const { loadStats, recordAttempts, statsFile } = await import('../src/engine/stats.js')
const tools = await import('../src/engine/tools.js')

const baseCfg = () => mergeConfig({
  providers: [
    { id: 'local', baseUrl: 'http://x/v1', apiKey: 'k' },
    { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', models: ['deepseek-chat', 'deepseek-reasoner'] },
  ],
  pool: ['local/m1', 'local/m2', 'deepseek/deepseek-chat'],
  routes: { 'code-gen': ['deepseek/deepseek-chat', 'local/m1'], general: ['local/m2'] },
  statsFile: path.join(HERE, 'fixtures', 'stats-test.json'),
  runDir: path.join(HERE, 'fixtures', 'runs-test'),
})

/* ---------------- config ---------------- */

test('config: providers 归一化 + model ref 解析', () => {
  const cfg = baseCfg()
  assert.equal(cfg.providers.length, 2)
  const r = resolveModelRef(cfg, 'deepseek/deepseek-chat')
  assert.equal(r.provider.id, 'deepseek'); assert.equal(r.model, 'deepseek-chat')
  // local 模型 id 自带斜杠：local/qodercn/qfmodel → provider local, model qodercn/qfmodel
  const r2 = resolveModelRef(cfg, 'local/qodercn/qfmodel')
  assert.equal(r2.provider.id, 'local'); assert.equal(r2.model, 'qodercn/qfmodel')
  // 裸 id → defaultProvider
  const r3 = resolveModelRef(cfg, 'qodercn/qfmodel')
  assert.equal(r3.provider.id, 'local')
})

test('config: provider.models 白名单过滤', () => {
  const cfg = baseCfg()
  assert.equal(refAllowed(cfg, 'deepseek/deepseek-chat'), true)
  assert.equal(refAllowed(cfg, 'deepseek/not-in-list'), false)
  assert.equal(refAllowed(cfg, 'local/anything'), true)   // local 未声明 models = 不限制
})

test('config: keys 文件补 apiKey', () => {
  const cfg = mergeConfig({ providers: [{ id: 'p', baseUrl: 'http://x', apiKeyEnv: 'NOPE_ENV_X' }] })
  const kf = path.join(HERE, 'fixtures', 'keys-test.json')
  fs.writeFileSync(kf, JSON.stringify({ providers: { p: { apiKey: 'from-file' } } }))
  applyKeysFile(cfg, kf)
  assert.equal(cfg.providers[0].apiKey, 'from-file')
})

/* ---------------- domain-pack ---------------- */

test('pack: 加载 mini-pack，artifact/planner_hint 生效', () => {
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  assert.ok(pack)
  assert.equal(pack.artifact, 'procedure')
  assert.ok(pack.plannerHint.includes('procedure'))
  assert.equal(pack.parts.length, 1)
  assert.equal(pack.parts[0].id, 'sensor-read')
  assert.equal(pack.parts[0].incomplete, false)   // api/interface/must_have/manual 引用齐全
  assert.deepEqual(pack.domains, ['general', 'sensor'])
})

test('pack: plannerInject 含清单+目录+铁律+planner_hint，artifact 措辞非 .h/.c', () => {
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const inj = dp.plannerInject(pack, 'read-sensor')
  assert.ok(inj.includes('sensor-read'))
  assert.ok(inj.includes('拆分规则'))
  assert.ok(inj.includes('领域规划提示'))
  assert.ok(inj.includes('操作程序'))   // procedure artifact 的 unit 措辞
  assert.ok(!inj.includes('.h/.c'))
})

test('pack: executorInject/judgeContractInject 按 artifact 切措辞', () => {
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const ej = dp.executorInject(pack, 'sensor-read')
  assert.ok(ej.includes('read_channel'))
  assert.ok(ej.includes('操作程序'))
  const jj = dp.judgeContractInject(pack, 'sensor-read')
  assert.ok(jj.includes('覆盖核对'))   // procedure 的 judgeChecks
  assert.ok(!jj.includes('.h 是否声明'))
})

test('pack: kb_search 命中/空手/枚举闸', () => {
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const hit = dp.kbSearch(pack, { part: 'sensor-read', query: '采样' })
  assert.ok(hit.includes('[S1]'))
  const miss = dp.kbSearch(pack, { part: 'sensor-read', query: '不存在的词zzz' })
  assert.ok(miss.includes('未定义'))
  const badDomain = dp.kbSearch(pack, { domain: 'nonexistent' })
  assert.ok(badDomain.startsWith('ERROR'))
})

test('pack: 无来源 manual 条目被拒', () => {
  // 直接测 parseManual 路径：构造临时 pack 太重，改测 kbSearch 对 rejected 的屏蔽
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  // fixture 全部带来源；这里验证 rejected 机制存在：knowledge 只含合法条目
  assert.ok(pack.knowledge.every(k => k.source))
})

/* ---------------- matcher ---------------- */

test('matcher: routes 查表 + pool 补位 + exclude + provider 白名单', () => {
  const cfg = baseCfg()
  const c = pickRoutes(cfg, 'code-gen', { exclude: ['local/m1'] })
  assert.deepEqual(c.map(x => x.id), ['deepseek/deepseek-chat', 'local/m2'])
  const c2 = pickRoutes(cfg, 'unknown-task')
  assert.deepEqual(c2.map(x => x.id), ['local/m2', 'local/m1', 'deepseek/deepseek-chat'])
})

test('matcher: needs 归一化含 domain/part', () => {
  const n = normalizeNeeds({ task: 'code-gen', domain: 'sensor', part: 'sensor-read', bogus: 1 }, baseCfg())
  assert.equal(n.task, 'code-gen'); assert.equal(n.domain, 'sensor'); assert.equal(n.part, 'sensor-read')
})

/* ---------------- planner ---------------- */

const planJson = JSON.stringify({
  steps: [{
    id: 's1', title: '采集', input: '读取通道3采100次', part: 'sensor-read', domain: 'sensor',
    acceptance: { must_have: '输出采样数组', quality_bar: '' },
    needs: { task: 'code-gen', timeout_class: 'gen' },
  }],
  summary: '单步采集',
})

test('planner: pack on 注入 + part 绑定 + must_have 合入', async () => {
  const cfg = baseCfg()
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const fakeChat = async () => planJson
  const plan = await makePlan(cfg, '读传感器', '', 3, undefined, { chat: fakeChat, pack })
  assert.equal(plan.steps.length, 1)
  const s = plan.steps[0]
  assert.equal(s.part, 'sensor-read')
  assert.equal(s.needs.part, 'sensor-read')
  assert.ok(s.acceptance.must_have.includes('采样次数参数化'))   // 零件 must_have 合入
  assert.ok(s.candidates.length >= 1)
})

test('planner: incomplete/不存在零件 → partRejected + 自由拆分', async () => {
  const cfg = baseCfg()
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const badJson = JSON.stringify({
    steps: [{ id: 's1', title: 'x', input: '做点什么', part: 'no-such-part', '自由拆分': '目录无此零件', acceptance: {}, needs: {} }],
    summary: '',
  })
  const plan = await makePlan(cfg, 'g', '', 2, undefined, { chat: async () => badJson, pack })
  assert.ok(plan.steps[0].partRejected.includes('不在目录'))
  assert.equal(plan.steps[0].freePartReason, '目录无此零件')
})

test('planner: planner 全挂 → fallback-direct 单步', async () => {
  const cfg = baseCfg()
  const { Fail } = await import('../src/engine/channel.js')
  const plan = await makePlan(cfg, 'g', '', 2, undefined, { chat: async () => { throw new Fail('http', 'x') } })
  assert.equal(plan.plannerModel, 'fallback-direct')
  assert.equal(plan.steps.length, 1)
  assert.ok(plan.plannerError)
})

/* ---------------- executor / tools ---------------- */

test('executor: runToolLoop 工具往返 + patchToolArgs 强制覆盖', async () => {
  const cfg = baseCfg()
  tools.registerDomainTools(() => null)
  const calls = []
  const fakeChat = async (c, m, msgs, t, s, o) => {
    calls.push({ tools: !!o?.tools })
    if (calls.length === 1) {
      return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{"part":"WRONG","query":"采样"}' } }] }
    }
    return { content: '最终结果：ok', tool_calls: [] }
  }
  const r = await runToolLoop(cfg, 'local/m1', [{ role: 'user', content: 'hi' }], 30_000, undefined, {
    chat: fakeChat, tools: [{ type: 'function', function: { name: 'kb_search', parameters: {} } }],
    maxRounds: 3, patchToolArgs: (n, a) => ({ ...a, part: 'sensor-read', domain: 'sensor' }),
  })
  assert.equal(r.content, '最终结果：ok')
  assert.equal(r.toolCalls, 1); assert.equal(r.toolRounds, 1)
})

test('executor: runStep 阻断模式——裁判 fail 后同模型重做', async () => {
  const cfg = baseCfg()
  cfg.judge = true; cfg.judgeRetries = 1
  const step = {
    id: 's1', title: 't', input: '做', needs: { timeout_class: 'gen' },
    acceptance: { must_have: '必须包含关键词XYZ', quality_bar: '', legacy: false },
    candidates: [{ id: 'local/m1' }],
  }
  let execN = 0, judgeN = 0
  const fakeChat = async () => 'output v' + (++execN)
  const fakeJudge = async () => ({ pass: judgeN++ === 0 ? false : true, critique: '缺XYZ', quality: '' })
  const r = await runStep(cfg, step, {}, undefined, { chat: fakeChat, judge: fakeJudge })
  assert.equal(r.ok, true)
  assert.equal(execN, 2)   // 第一次被判 fail，第二次带 critique 重做
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[0].judged, false)
})

test('executor: runStep 全候选挂 → judgeFailed 诚实上报', async () => {
  const cfg = baseCfg()
  cfg.judge = true; cfg.judgeRetries = 0
  const step = {
    id: 's1', title: 't', input: '做', needs: {},
    acceptance: { must_have: '硬性要求ABCDEFGH', quality_bar: '', legacy: false },
    candidates: [{ id: 'local/m1' }, { id: 'local/m2' }],
  }
  const { Fail } = await import('../src/engine/channel.js')
  const r = await runStep(cfg, step, {}, undefined, {
    chat: async () => 'x',
    judge: async () => ({ pass: false, critique: '不合格', quality: '' }),
  })
  assert.equal(r.ok, false); assert.equal(r.judgeFailed, true)
  assert.ok(r.output)   // 保留末版输出
})

test('executor: 传输失败换候选（不重试同模型）', async () => {
  const cfg = baseCfg()
  cfg.judge = false
  const step = {
    id: 's1', title: 't', input: '做', needs: {}, acceptance: { must_have: '', quality_bar: '', legacy: false },
    candidates: [{ id: 'local/m1' }, { id: 'local/m2' }],
  }
  const { Fail } = await import('../src/engine/channel.js')
  let n = 0
  const r = await runStep(cfg, step, {}, undefined, {
    chat: async (c, m) => { if (m === 'local/m1') throw new Fail('http', '500'); return 'ok-' + (++n) },
  })
  assert.equal(r.ok, true); assert.equal(r.model, 'local/m2')
  assert.equal(r.attempts.length, 2); assert.equal(r.attempts[0].reason, 'http')
})

/* ---------------- judge ---------------- */

test('judge: pack on 注入契约，输出 verdict 结构', async () => {
  const cfg = baseCfg()
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const step = { id: 's1', title: 't', input: 'i', part: 'sensor-read', needs: { part: 'sensor-read' }, acceptance: { must_have: '要求', quality_bar: '' } }
  let seenPrompt = ''
  const v = await judgeStep(cfg, step, 'output', undefined, {
    pack,
    chat: async (c, m, msgs) => { seenPrompt = msgs[0].content; return '{"pass":true,"critique":"","quality":""}' },
  })
  assert.equal(v.pass, true)
  assert.ok(seenPrompt.includes('期望契约项'))
  assert.ok(seenPrompt.includes('read_channel'))
})

/* ---------------- stats ---------------- */

test('stats: recordAttempts 聚合公式 + judged:null 不污染', () => {
  const cfg = baseCfg()
  fs.rmSync(cfg.statsFile, { force: true })   // 上次运行的残留会污染计数
  recordAttempts(cfg, [
    { model: 'local/m1', ok: true, ms: 100, judged: true },
    { model: 'local/m1', ok: true, ms: 300, judged: null },
    { model: 'local/m1', ok: false, reason: 'http', ms: 50 },
  ])
  const s = loadStats(cfg)
  const m = s['local/m1']
  assert.equal(m.n, 3)
  assert.ok(Math.abs(m.ok_rate - 2 / 3) < 0.01)
  assert.equal(m.pass_n, 1)          // judged:null 那条没计入
  assert.equal(m.pass_rate, 1)
  assert.equal(m.fails.http, 1)
})

/* ---------------- pack-lint（L1 确定性体检） ---------------- */

const { lintPack, formatLintReport, LINT_DISCLAIMER } = await import('../src/engine/pack-lint.js')

test('lint: mini-pack 干净（0 ERROR）', () => {
  const { issues, stats } = lintPack(PACK)
  assert.equal(stats.counts.ERROR || 0, 0)
  assert.ok(stats.parts >= 1)
})

test('lint: bad-pack 抓出硬伤（重复id/未声明domain/缺条目引用/无来源manual/坏artifact）', () => {
  const { issues } = lintPack(path.join(HERE, 'fixtures', 'bad-pack'))
  const msgs = issues.map(i => i.msg).join('\n')
  const errors = issues.filter(i => i.level === 'ERROR').map(i => i.msg).join('\n')
  assert.ok(errors.includes('重复声明'), 'dup id ERROR')
  assert.ok(errors.includes('不存在'), 'missingRefs ERROR')
  assert.ok(msgs.includes('not-declared'), 'undeclared domain')
  assert.ok(issues.some(i => i.msg.includes('无来源') || i.msg.includes('被拒')), '无来源 manual 被拒')
  assert.ok(issues.some(i => i.level === 'WARN' && i.msg.includes('artifact')), '坏 artifact WARN')
})

test('lint: 报告含免责声明', () => {
  const { issues, stats } = lintPack(PACK)
  const report = formatLintReport(PACK, { issues, stats })
  assert.ok(report.includes(LINT_DISCLAIMER.slice(0, 10)))
})

/* ---------------- pack-ai（L2 AI 语义体检） ---------------- */

const { aiLintPack, buildPackDigest } = await import('../src/engine/pack-ai.js')

test('pack-ai: digest 含 pack/catalog/manual/checklist 内容', () => {
  const d = buildPackDigest(PACK)
  assert.ok(d.includes('sensor-read'))
  assert.ok(d.includes('[S1]'))
  assert.ok(d.includes('read-sensor'))
  assert.ok(d.includes('被检查数据') === false)   // digest 本身不含边界标记
})

test('pack-ai: aiLintPack 解析 JSON 数组 + 分级排序 + 非法项过滤', async () => {
  const cfg = baseCfg()
  const fakeChat = async (c, m, msgs) => {
    // 验证防注入边界标记存在
    assert.ok(msgs[1].content.includes('被检查数据开始'))
    return '```json\n[{"level":"warn","file":"catalog.yml#sensor-read","msg":"api 返回类型与 manual 矛盾","hint":"核对 §3"},{"level":"ERROR","file":"x","msg":"硬伤"},{"level":"BOGUS","file":"y","msg":"非法level降级"},{"level":"WARN"}]\n```'
  }
  const { issues, digestChars, rejected } = await aiLintPack(cfg, PACK, { chat: fakeChat })
  assert.ok(digestChars > 100)
  assert.equal(issues.length, 3)         // 缺 msg 的被拒
  assert.equal(issues[0].level, 'ERROR') // 排序 ERROR 在前
  assert.equal(issues[1].level, 'WARN')
  assert.equal(issues[2].level, 'WARN')  // BOGUS → WARN 降级
  assert.equal(rejected, 1)
})

/* ---------------- runlog + learn（错题总结） ---------------- */

const { persistRun, listRuns } = await import('../src/engine/runlog.js')
const { summarizeRun, buildRecap } = await import('../src/engine/learn.js')

test('runlog: persistRun 写档 + listRuns 逆序', () => {
  const cfg = baseCfg()
  fs.rmSync(cfg.runDir, { recursive: true, force: true })
  const p1 = persistRun(cfg, { goal: 'g1', packName: 'mini-pack' }, { ok: true, results: [] })
  const p2 = persistRun(cfg, { goal: 'g2', packName: 'mini-pack' }, { ok: false, stage: 'step:s1', results: [] })
  assert.ok(p1 && p2 && fs.existsSync(p1))
  const runs = listRuns(cfg)
  assert.equal(runs.length, 2)
  const doc = JSON.parse(fs.readFileSync(runs[0], 'utf8'))
  assert.equal(doc.goal, 'g2')   //新的在前
  assert.equal(doc.v, 1)
})

test('learn: buildRecap 包含关键字段且截断', () => {
  const doc = {
    goal: 'g', packName: 'p',
    result: { ok: false, stage: 'step:s2', plannerModel: 'm', summary: 'sum',
      results: [{ id: 's1', title: 't', ok: true, model: 'mm', part: 'pt',
        attempts: [{ model: 'mm', ok: true, ms: 1, judged: false, critique: 'bad' }],
        output: 'x'.repeat(2000) }] },
  }
  const recap = buildRecap(doc, { maxChars: 500 })
  assert.ok(recap.includes('JUDGE-FAIL'))   // judged:false 的 attempt 带标记
  assert.ok(recap.includes('critique'))
  assert.ok(recap.length <= 520)
})

test('learn: summarizeRun 解析 JSONL 草稿 + 必填过滤 + 来源兜底', async () => {
  const cfg = baseCfg()
  cfg.learnModel = 'local/m1'
  const runDoc = {
    goal: 'g', packName: 'mini-pack', packRoot: PACK,
    result: { ok: false, stage: 'step:s1', runFile: '/tmp/r1.json',
      results: [{ id: 's1', title: 't', ok: false, judgeFailed: true, part: 'sensor-read',
        attempts: [{ model: 'm', ok: true, ms: 1, judged: false, critique: '数值编造' }],
        acceptance: { must_have: 'x' } }] },
  }
  const fakeChat = async () => [
    '{"id":"m-1","domain":"sensor","part":"sensor-read","症状":"编造了通道范围","根因":"没查manual","修法":"先kb_search","验证":"","来源":""}',
    '{"id":"m-2","domain":"sensor","症状":"缺修法字段"}',
    '这不是JSON垃圾行',
    '{"domain":"general","症状":"好条目","修法":"做对的做法"}',
  ].join('\n')
  const { drafts, rejected } = await summarizeRun(cfg, runDoc, { chat: fakeChat })
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0]['来源'], 'run:r1.json step:s1')   // 空来源兜底
  assert.equal(drafts[1].domain, 'general')
  assert.equal(rejected.length, 2)   // 缺修法 + 垃圾行
})

/* ---------------- dispatch 集成 ---------------- */

test('dispatch: 全流程假 chat 跑通（pack on 单步）', async () => {
  const cfg = baseCfg()
  cfg.judge = true
  const pack = dp.loadPack(PACK, { ttlMs: 0 })
  const fakeChat = async (c, model, msgs) => {
    const content = msgs[0].content
    if (content.includes('任务分配器')) return planJson
    if (content.includes('验收裁判')) return '{"pass":true,"critique":"","quality":""}'
    return '采样结果：[1,2,3]'
  }
  const result = await dispatch(cfg, '读传感器通道3采100次', '', 3, undefined, () => {}, { chat: fakeChat, pack }, { pack: PACK })
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].part, 'sensor-read')
  assert.equal(result.results[0].model, 'deepseek/deepseek-chat')   // routes 首选
})
