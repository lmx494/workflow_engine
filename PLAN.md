# workflow-engine 开发计划书（v2 · 纯产品路线）

> ~~比赛已取消~~（2026-11-26 用户确认）。本计划转为长期产品路线：
> 不再有 demo 死线，按"把地基打对"的节奏走，质量建设优先。
>
> 本计划书本身按 workflow 的理念写：总目标 → 拆成"零件"（模块）→ 每个零件有契约、
> 知识来源、难点预判、验收标准。开发过程 dogfooding：每完成一个零件过一次"验收"。

## 产品定位（一句话）

**用严谨的流程，用上限换准确和性价比**——别人卖"更聪明的 AI"，我们卖"更可信的流程"。
适用边界：任务正确性可对照成文知识验收的领域（嵌入式/操作规程/合规/报表）；
创意写作、无标准答案的探索不在射程内。

## 三层架构（不变量 / 策略 / 内容）

- **不变量层（锁死，永不插件化）**：三条铁律（事实带来源 / 缺条目=未定义 / 拆分=封闭选型）+ 流水线骨架 + fail-closed 语义
- **策略层（接缝可插拔）**：多 provider、路由表、裁判、工具集、交付物措辞、宿主适配
- **内容层（用户资产 = 真正的"插件"）**：领域包 = 零件目录 + 清单 + 模板 + 错题 + 说明书；换领域=换目录

## 当前进度（v0.1 已提交 `ea47fc7`）

| 零件 | 状态 |
|---|---|
| p01-skeleton ~ p13-mcp | ✅ 全部完成（含 wfe.config.json 配置文件、离线测试 20/20 绿、MCP 握手实测通过） |
| p14-hosts-dsh | ⏸ 降为 v1.5——MCP 已覆盖"寄生任意宿主"，DSH 壳不急 |
| p15-tests | ✅ v0.1 基线 20 组；后续每加功能补测试 |

## 下一阶段路线（按优先级）

### P0 · 真实跑通验证（进行中）

让引擎在真实网络下完整跑一次 dispatch：

- **前置**：✅ 已打通——DSH 网关在跑（581 个模型），但 **WSL 直连不通**（网关绑 Windows loopback），
  必须用 Windows node 跑：`cmd.exe /c "cd /d C:\Users\lmxzsa\workflow-engine && node src\cli.js ..."`
- **已验证（2026-11-26）**：mini-pack 端到端 ok:true——
  planner 真实拆步（2 步，选了 sensor-read 零件+自由拆分）、routes 选模、步内工具环（kb_search ×4/×3/×12）、
  **铁律实战生效**（执行 AI 主动标注"[S2] 通道范围未定义：待说明书"而非编造数值）、
  **裁判抓到真缺陷**（示例 JSON 50 项≠100 项→重做→放行）、候选超时自动换模型（GLM-Flash 60s 超时→q37fmodel）
- **遗留**：① 单次 attempt 50-66s，免费模型慢，真实领域任务总时长会很长 ② robotics pack 是空骨架，
  真实领域验证需先填 catalog/manual 内容 ③ Windows node v26 vs WSL node v22 行为差异未测

### P1 · pack lint（知识库体检）—— AI 顾问定位

> **免责声明（必须写进输出和文档）**：本检查机制只用于**降低出错概率，不保证不会出错**；
> pack 内容仍可能含错误，用户导入与使用时必须万分谨慎，最终责任在人。

分两层实现，先确定性后 AI：

| 层 | 内容 | 成本 | 状态 |
|---|---|---|---|
| L1 确定性 lint | 结构完整性（pack.yml/catalog.yml/manual 引用）、引用闭合（checklist↔catalog、domains 声明 vs pack.yml 原文）、死条目、空壳零件目录、incomplete 原因列举 | 零（不调 LLM） | ✅ 已完成 `src/engine/pack-lint.js` + `src/pack-check.js`（23 测试含 lint 3 组） |
| L2 AI 语义体检 | `wfe pack check --ai`：常识合理性质疑（"8 位单片机配 10GHz 采样"）、api 与 manual 自相矛盾、checklist 与目录覆盖错位、must_have 不可验收的空话 | 1-2 次 LLM 调用 | ⬜ 待做 |

**关键设计约束**：
- 输出是**分级问题清单**（ERROR 疑似硬伤 / WARN 待核对 / INFO 提示），每条带文件定位+建议核对来源
- **只提问不判刑**：永不自动修改 pack、永不阻止加载——和 judge 同哲学：AI 干活，人拍板
- 用最强可用模型跑检查（reasoner 档），检查者本身不能是被检查对象的同级弱模型
- 防注入：pack 文本在 prompt 中明确标记为"被检查数据"而非指令

### P2 · 质量闭环（运行时反哺知识库）

- ✅ **run 存档 + 错题总结（已完成）**：dispatch 结果持久化到 `data/runs/*.json`（成功失败都存，`saveRuns:false` 可关）；`node src/learn.js` 回顾轨迹 → AI 起草 mistakes.jsonl 候选 → 落 `mistakes-candidates/` 暂存区 → `--accept` 人工确认后追加进 `mistakes.jsonl`（mistake_search 立即可检索）。强制约束：草稿必填 domain/症状/修法、来源必须带 run 引用、纯基础设施失败（超时/HTTP）不总结。26 测试全绿。
- judgeFailed/连续失败的 dispatch → 自动把可疑 manual 条目标 `status:draft-recheck` 候选（人确认才转正）——与 learn 互补，暂缓
- stats 升级：agent-model-router 式 Beta(α,β) 置信下界路由（替代朴素 ok_rate）
- usage/token 字段补记（现在 chat() 丢弃 usage，为成本统计留口）

### P3 · 生态与远期

- `hosts/dsh.js` DSH 薄适配壳（有需要时再写）
- pack `validate` 命令合并进 lint
- 机器操作方向（远期）：`artifact: machine-ops` 枚举位已预留；执行器抽象/传感器只读工具/人工确认边界——**AI 只进监督层不进控制层**（急停/联锁必须在控制器里，模型够不到）
- 第二个真实领域 pack——通用性从"架构承诺"变"已验证事实"的唯一途径

## 难点预判（已发生/待发生）

### D1. v0.8 接线重建 —— ✅ 已完成
按 CHANGELOG 规格重建成功，语义用 20 组离线测试锁死。遗留风险：routes 初始表是产品决策（见下），真实网络下行为未验证。

### D8.（新）pack lint 的误报率
AI 体检必然有 false positive——分级输出+永不阻塞是缓解，但用户如果被误报淹没会失去信任。**验收标准：在 robotics pack 上跑一遍，人工评估"有用信号/噪声"比例**，噪声大就先只上 L1 确定性 lint。

### D9.（新）真实 provider 的 tools 兼容性
DeepSeek/通义官方 API 是否完整支持 OpenAI tools 字段未验证——首次真实跑通时重点观察 runToolLoop 是否降级重打。

## 明确不做（v1，维持）

通用插件注册表 / 可配置流水线 / Web UI / PDF→条目导入工具链 / hedged 并行请求 / Beta stats（→P2 提前候选）/ 错题自动草拟（→P2）/ 机器执行器与传感器工具（→P3 远期）

## 待用户拍板项

1. **API key 落地**：DSH 网关是否常开？还是 keys.local.json 填 DeepSeek/通义？（决定 P0 怎么跑）
2. **robotics pack 现状**：`~/.dsh/domain-pack/robotics` 的 manual 条目是否已填真实参数？（决定 P0 验证质量）
3. **routes 初始表**：当前 DEFAULT_ROUTES 是我按"付费稳档→免费兜底"排的初版，有 key 后可调
4. **pack lint 排期**：P0 跑通后立刻做，还是先补第二个 pack 验证通用性？（我建议先 lint——robotics pack 本身就是最好的测试对象）

## GitHub 借鉴地图（调研 2026-11-26，仍有效）

> 原则：抄思想不抄路线。重型框架（LangGraph/LangChain/RAG 向量库）不引入——
> "毛坯房"哲学要求零依赖极简 ESM，除 MCP SDK 外不加 npm 依赖。

| 零件 | 借鉴源 | 抄什么 |
|---|---|---|
| p02/p03 config+channel | `BerriAI/litellm`、`ajoly21/LLM-Failover-Proxy`、`ssthil/llmroute` | provider/model ref 范式、失败分类语义、（v1.1）凭证泄漏扫描 |
| p04 domain-pack | `byteask/ByteAsk-Embedded-MCP`、`seeramsujay/specRAG`、`nxp-agentic-ai/s32-ds-ai-support`、`jeeva-m-21/ForgeMCU` | cited-or-nothing 检索（已同构）、PDF→条目管道（远期）、产业级对照、反面教材 |
| p05/p08 tools+executor | `huggingface/smolagents`、`openai/openai-agents-python`、`SahilArate/agent-model-router`、`noahshinn/reflexion` | tool loop 状态机、Beta 统计+abstain（P2 蓝图）、Reflexion=critique 回灌原型 |
| p07 planner | `stanfordnlp/dspy`、`bichengwang/multi-agents`(plan 拓扑)、`Xrouter` P3 | signature 声明式约束、replanner=critique 重拆 |
| p09 judge | `confident-ai/deepeval`、`microsoft/llm-as-judge`、`krishagarwal314/CodeJury`、`KevinZhangNothing/swe-review-plugin` | 评估维度分类法、陪审团模式（远期）、结构化 ReviewReport 格式 |
| p10 stats | `SahilArate/agent-model-router`、`langfuse`、litellm spend logs | Beta+置信下界（P2）、trace/span、cost/token 字段（P2 补 usage） |
| p11 dispatch | `mrilikecoding/llm-orc`、`Xrouter` DAG executor、`open-multi-agent` | accept gate 对照、phase 化模型策略 |
| p13 mcp | `@modelcontextprotocol/sdk` 官方 | 已完成：手写 JSON-RPC（零依赖，MCP 方法面足够小） |
| p15 tests | `confident-ai/deepeval`（pytest-for-LLM 思想）、本项目 CHANGELOG 规格 | 分组断言、23-26 组语义重建 ✅ 已完成 20 组 |
| **p16 pack-lint（新）** | `seeramsujay/specRAG`（数据手册 grounding）、`nxp-agentic-ai/s32-ds-ai-support`（技能文件治理） | "AI 提问不判刑"的分级问题清单形态、pack 内容当数据不当指令 |

**明确不抄**：LangGraph/LangChain 重型编排、向量 RAG 框架、agent 自主决定 workflow（流水线骨架锁死是差异化不是缺陷）。
