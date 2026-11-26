# workflow-engine v1 开发计划书

> 本计划书本身按 workflow 的理念写：总目标 → 拆成"零件"（模块）→ 每个零件有契约、
> 知识来源（要迁移/重建的代码）、难点预判、验收标准。开发过程 dogfooding：
> 每完成一个零件过一次"验收"（测试/人工核对），不合格带批评重做。

## 总目标

把 `dsh-ai-dispatcher` 插件重构为宿主无关的确定性工作流引擎：

- **不变量层（锁死）**：三条铁律（事实带来源 / 缺条目=未定义 / 拆分=封闭选型）+ 流水线骨架 + fail-closed
- **策略层（可插拔）**：多 provider 模型接入、路由表、裁判、工具集、交付物措辞、宿主适配
- **内容层（用户资产）**：领域包 = 零件目录 + 清单 + 模板 + 错题 + 说明书，换领域=换目录

交付物：`node cli.js` / `node mcp.js` 可跑通完整 dispatch；离线测试全绿；robotics pack 真实跑通一次。

## 零件清单（模块拆分）

| 零件 id | 职责 | 来源 | 难度 | 验收 |
|---|---|---|---|---|
| p01-skeleton | package.json/目录/.gitignore/keys.example | 新写 | ★ | `npm pkg get name` 正确 |
| p02-config | DEFAULTS/mergeConfig/providers/resolveModel | index.js 改造 | ★★ | 单测：providers 解析、model ref 拆分、非法配置钳位 |
| p03-channel | chat() 唯一网络出口：多 provider、超时/中断、Fail 分类、tools/full 支持 | index.js chat() + CHANGELOG v0.6/v0.8 规格重建 | ★★★ | 假 fetch 单测：四类失败分类、tool_calls 解析、429→rate |
| p04-domain-pack | pack 加载/三铁律/注入块/kb_search/checks + artifact 抽象 + planner_hint + 多 pack 注册 | 迁移 domain-pack.js + 扩展 | ★★★★ | 迁移后原测试语义不变 + 新特性单测 |
| p05-tools | TOOL_REGISTRY/calc/regex_test/executeTool/registerDomainTools | 迁移 tools.js | ★ | 原样迁移，import 路径修正 |
| p06-match | match.js/model-catalog.js（dynamic 模式用） | 原样迁移 | ★ | 原样迁移 |
| p07-planner | makePlan：pack 注入、part 选型、partRejected/freePartReason、must_have 合入、计划级检查、critique 重拆 | **全部重建**（原 index.js 丢失） | ★★★★★ | 假 chat 单测：注入出现/拒选/重拆/降级计划 |
| p08-executor | runStep 阶梯 + runToolLoop（墙钟预算/降级重打/maxRounds/patchToolArgs）+ executorInject | **全部重建** | ★★★★★ | 假 chat 单测：换候选/同模型重试/工具环/裁判不带工具 |
| p09-judge | judgeOutput + judgeContractInject + 裁判工具环（judgeTools/judgeToolMaxRounds） | **全部重建** | ★★★★ | 假 chat 单测：blocking/advisory/none 三模式、judgeToolCalls 记录 |
| p10-stats | loadStats/recordAttempts：ok_rate/p50 EMA/pass_rate/jtool_rate/fails 分桶 | index.js 迁移 + 扩展 | ★★ | 单测：聚合公式、judged:null 不污染、文件缺失容错 |
| p11-dispatch | 总编排：catalog+stats→plan→逐步 runStep→recordAttempts→汇总 | index.js dispatch() 迁移改造 | ★★★ | 集成单测：全流程假 chat 跑通、多步 upstream 传递 |
| p12-cli | 独立 CLI：参数解析、--pack/--provider/--json、进度 stderr | 改造 cli.js | ★★ | `node cli.js --help`；离线 smoke |
| p13-mcp | MCP server：ai_dispatch 暴露为 tool | 新写 | ★★★ | MCP 协议握手测试（能否装 SDK 待验证） |
| p14-hosts-dsh | DSH 薄适配壳：apply(ctx,cfg) 注册 ai_dispatch | index.js 尾部迁移 | ★★ | 代码审查即可（本机 DSH 无法离线验证） |
| p15-tests | 离线测试套件重建（test-pack 语义 + 新特性） | 全新 | ★★★★ | 全绿 + 反向验证（撤铁律→红→恢复绿） |

依赖序：p01 → p02/p05/p06 → p03 → p04 → p07/p08/p09/p10 → p11 → p12/p13/p14 → p15（贯穿）

## 难点预判（写代码前先想清楚的）

### D1. v0.8 接线是"按规格重建"不是"照抄"——最大风险
原 index.js 丢失，CHANGELOG 只记了"改了什么"没记"长什么样"。重建时会有判断空间：
- runToolLoop 的 prompt 组装细节（tool_calls 消息格式、system prompt 写法）没规格，只能按 OpenAI tools 协议 + 注释语义重建
- routes 模式的 DEFAULTS.routes 表内容要重新设计（task→模型顺序），这是**产品决策**不是代码问题——需要你拍板初始路由表
- 计划级检查的 critique 回灌格式自定
**缓解**：重建后用测试锁死语义（不是锁死文本），CHANGELOG 里"已验证"的行为逐条对照。

### D2. 工具环与多 provider 的交互
- 网关不认 tools → 同候选降级重打（degraded）；直连官方 API（DeepSeek/通义）大多认 tools，但要在测试里假设"可能不认"
- patchToolArgs 钩子强制覆盖 kb_search/mistake_search 的 part/domain 参数——这个"检索键机械封死"是铁律级设计，重建时不能简化掉

### D3. MCP SDK 依赖
`@modelcontextprotocol/sdk` 需要 npm install——网络/镜像未验证。备选：手写 JSON-RPC over stdio（MCP 本质是 JSON-RPC，ai_dispatch 只需 tools/list + tools/call 两个方法，~150 行）。**先尝试官方 SDK，不行就手写**。

### D4. artifact 抽象的措辞模板
executorInject/judgeContractInject 现在硬编码 .h/.c。改成按 `pack.artifact` 选模板：
- `firmware`（默认）：现有 .h/.c 措辞
- `procedure`：交付物=命令序列/操作步骤
- `document`：交付物=文档章节
- `machine-ops`：交付物=机器操作程序（远期预留，v1 只留枚举位）
每个模板是"期望产物形态 + 查证顺序"的措辞骨架，结构（api 清单/三核对）不变。

### D5. 多 pack 注册与 pack.yml 扩展
- pack.yml 现有解析只认 domains/name/note 顶层标量，需扩展：`artifact:`、`planner_hint:`（多行文本，解析要支持块标量或单行）
- 多 pack：config.packs = {name: path} 映射 + `packsDir` 扫描兜底；dispatch 参数 `pack` 选名
- loadPack 的 30s 缓存按 root 做 key，多 pack 同时用要确认缓存不串

### D6. 测试全离线的约束
所有引擎函数必须支持 deps 注入（假 chat/假 catalog/假 stats）——这是现有代码已有的模式（deps.chat||chat），重建时保持。**没有假 chat 就没有测试**，这是第一优先级的接口设计。

### D7. Windows/WSL 边界
项目在 /mnt/c（Windows 盘），node 在 WSL 里跑没问题；但路径分隔符、fs.watch（不用）、换行符（\r\n vs \n，deBom 已处理 BOM 但 CRLF 解析要测）都是坑。测试 fixture 要覆盖 CRLF。

## 明确不做（v1）

通用插件注册表 / 可配置流水线 / Web UI / 导入工具链（PDF→条目）/ hedged 并行请求 / Beta 分布 stats / 错题自动草拟 / 机器执行器与传感器工具 / DSH 适配壳的真实验证（只写代码不验证）

## 比赛衔接

- demo 素材预埋：同一引擎切两个 pack（robotics + 一个演示用迷你 pack）展示"换领域=换目录"
- 多 provider 路由表是亮点：deepseek 官方 API（稳）→ 通义（备）→ local 免费网关（兜底）
- 保底：cli.js 真实跑通录屏

## GitHub 借鉴地图（调研 2026-11-26）

> 原则：抄思想不抄路线。重型框架（LangGraph/LangChain/RAG 向量库）不引入——
> "毛坯房"哲学要求零依赖极简 ESM，除 MCP SDK 外不加 npm 依赖。

| 零件 | 借鉴源 | 抄什么 |
|---|---|---|
| p02/p03 config+channel | `BerriAI/litellm`、`ajoly21/LLM-Failover-Proxy`、`ssthil/llmroute` | provider/model ref 范式、失败分类语义、（v1.1）凭证泄漏扫描 |
| p04 domain-pack | `byteask/ByteAsk-Embedded-MCP`、`seeramsujay/specRAG`、`nxp-agentic-ai/s32-ds-ai-support`、`jeeva-m-21/ForgeMCU` | cited-or-nothing 检索（已同构）、PDF→条目管道（远期）、产业级对照、反面教材（别学它的重型路线） |
| p05/p08 tools+executor | `huggingface/smolagents`、`openai/openai-agents-python`、`SahilArate/agent-model-router`、`noahshinn/reflexion` | tool loop 状态机参照、max_turns=我maxRounds、Beta 统计+abstain（v2 蓝图）、Reflexion=critique 回灌原型 |
| p07 planner | `stanfordnlp/dspy`、`bichengwang/multi-agents`(plan 拓扑)、`Xrouter` P3 | signature 声明式约束思想、replanner=critique 重拆 |
| p09 judge | `confident-ai/deepeval`、`microsoft/llm-as-judge`、`krishagarwal314/CodeJury`、`KevinZhangNothing/swe-review-plugin` | 评估维度分类法（G-Eval/faithfulness 等）、陪审团模式（v2）、结构化 ReviewReport 格式 |
| p10 stats | `SahilArate/agent-model-router`、`langfuse`、litellm spend logs | Beta(α,β)+置信下界（v2）、trace/span 概念、cost/token 字段（v2 补 usage） |
| p11 dispatch | `mrilikecoding/llm-orc`、`Xrouter` DAG executor、`open-multi-agent` | accept gate 对照、DAG 依赖（远期）、phase 化模型策略 |
| p13 mcp | `@modelcontextprotocol/sdk` 官方 + `modelcontextprotocol/servers` reference | 标准 SDK，不自造协议 |
| p15 tests | `confident-ai/deepeval`（pytest-for-LLM 思想）、本项目 CHANGELOG 规格 | 分组断言风格、23-26 组测试语义重建 |

**明确不抄**：LangGraph/LangChain 重型编排、向量 RAG 框架、agent 自主决定 workflow（流水线骨架锁死是差异化不是缺陷）。

## 待用户拍板项

1. **DEFAULTS.routes 初始路由表内容**：task 类型 → 模型优先级列表。建议初版：
   - code-gen: deepseek/deepseek-chat → qwen/qwen-plus → local/qodercn/qfmodel
   - code-review: deepseek/deepseek-reasoner → local/qodercn/qmodel_latest → local/qodercn/kmodel_latest
   - analyze: 同 code-review
   - general/其他: local 免费档优先（cost-sensitive）
   具体模型 id 等用户提供 API key 后可调
2. **provider key 管理**：keys.json 放哪（建议 `~/.config/workflow-engine/keys.json` 或项目内 gitignore 的 keys.local.json）
3. **planner_hint 保守版**（只能追加不能改铁律）——默认采用，未反对
