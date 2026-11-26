# PACK-GUIDE — 领域包作者手册

> 本手册是"内容层"的唯一权威文档。框架（引擎）是通用的，领域知识全在 pack 里——
> **pack 写得好坏直接决定系统产出质量**。读完本手册你应该能独立写出一个新领域包。

## 0. pack 是什么

一个 pack = 一个领域的全部知识资产，一个目录：

```
<pack根>/
├── pack.yml                  # 包元数据（必填）
├── catalog.yml               # 零件目录（必填——封闭选型的数据源）
├── checklist/<task>.md       # 分解清单（可选，planner 拆步先验）
├── mistakes.jsonl            # 全局错题本（可选，JSONL）
├── mistakes-candidates/      # 错题草稿暂存区（learn 生成，人审后才入库）
├── knowledge/<domain>.md     # 旧布局 manual（兼容，建议用 parts/ 新布局）
└── parts/<零件id>/
    ├── manual/*.md           # 说明书蒸馏条目（事实必须带来源）
    ├── templates/*.{md,c,h}  # 代码模板（front-matter 声明状态）
    └── mistakes/*.jsonl      # 该零件的错题（可选）
```

**核心原则：一个零件 = 一个文件夹 = 一对可交付物 + 它的全部知识。**
零件数量不限——catalog.yml 是注册表，想加多少加多少。

## 1. pack.yml

```yaml
name: my-pack                  # 包名（显示用）
domains:                       # 本领域的 domain 词表（planner 的 domain 枚举）
  - motor
  - chassis
artifact: firmware             # 交付物类型（见 §6）
planner_hint: |                # 可选：追加式领域规划提示（不能改铁律）
  本领域拆步时注意：...
```

**注意**：`domains` 必须在这里声明——零件里写了未声明的 domain 会被 lint 报 ERROR。
`domains: []` 空数组和 `domains:` + `- x` 两种写法都支持；**内联 `[a, b]` 也支持**。

## 2. catalog.yml —— 零件目录（最重要的文件）

```yaml
parts:
  - id: can-motor-tx           # 唯一 id，planner/executor/judge 全靠它引用
    domain: motor              # 必须在 pack.yml domains 里（general 兜底豁免）
    title: CAN 电机发送驱动
    api:                       # 期望函数签名（.h 声明 + .c 实现，裁判逐字核对）
      - "void can_motor_tx_send(uint16_t id, const uint8_t *data, uint8_t len)"
    interface:                 # 数据接口（总装对齐检查用）
      input:  { name: frame, type: can-frame, range: "id 0x200-0x2FF", unit: none }
      output: { name: ack, type: uint8_t, range: "0=ok", unit: none }
    must_have:                 # 硬性验收（引用的 [编号] 必须在 manual 里存在）
      - "CAN ID 可配置，不写死 [M1]"
      - "发送失败重试次数参数化 [M2]"
    judge_mode: blocking       # blocking=裁判不通过就重做 | advisory=只记录不拦截
```

### 解析器只认的语法（重要！）

这是**极简 YAML 子集**，不是完整 YAML——写错格式会静默解析失败：

| 写法 | 支持？ |
|---|---|
| `api:` / `must_have:` 后接 `- item` 逐行列表 | ✅ 唯一支持的列表写法 |
| `api: ["a", "b"]` 内联数组 | ❌ 会被当成单个字符串 |
| `interface: { input: ... }` 全部内联 | ⚠️ `input:`/`output:` 各自要独立一行，值用 `{ k: v, k2: v2 }` 内联 map |
| 嵌套超过两层的 map | ❌ |
| 键名含中文/特殊字符 | ❌ 只认 `[a-z_]+` |

### 零件什么时候被判 incomplete（planner 不会选它）

任一命中即 incomplete：
- 含占位符 `[待说明书]`/`[待确认]`/`[TBD]`
- 缺 `api` 或 `interface.input/output` 或 `must_have`
- `must_have` 引用的 `[编号]` 在 manual 里不存在（空头支票）

## 3. manual/*.md —— 说明书蒸馏条目（事实层）

每行一条，格式**严格**：

```
[S1] CAN 波特率固定 500kbps，8 数据位 | 来源: 电控说明书 §4.2
[M1] 重试上限 3 次，超过进入失能 | 来源: 设计文档 v2 §3.1
```

规则：
- `[编号]` 在行首，编号自定义但**必须唯一**（跨 manual 文件也不能重）
- `| 来源:` 必须有——**没有来源的条目会被直接拒收**（这就是铁律 1）
- 来源要具体：`说明书 §x.y`、`数据手册表 z`，不要写"百度""经验""网上"
- 一条一个事实，不要把多个参数塞一行

## 4. templates/* —— 代码模板

```markdown
---
状态: compiled          # draft|compiled|bench|production
适用条件: 仅用于 CAN 电机发送
来源: 说明书 §5.3
---
void can_motor_tx_send(...) { ... }
```

状态阶梯：`draft` 永不注入 → `compiled` 注入但标"未上板" → `bench`/`production` 正常注入。
**别急着把模板标 production**——没真机验证过就保持 compiled，让执行 AI 知道它还没上过板。

## 5. mistakes.jsonl —— 错题本

每行一个 JSON（UTF-8，无 BOM）：

```json
{"id":"m-can-id","domain":"motor","part":"can-motor-tx","症状":"发送无响应","根因":"CAN ID 写成了标准帧格式","修法":"用扩展帧 ID 0x18FF50E5","验证":"总线抓包确认","来源":"run:2026-11-26.json step:s2"}
```

必填：`domain`、`症状`、`修法`。可选：`id`、`part`、`根因`、`验证`、`来源`。
`mistakes-candidates/` 是暂存区——`learn` 生成的草稿先进这里，人审后 `--accept` 才进 `mistakes.jsonl`。

## 6. artifact —— 交付物类型

pack.yml 声明，决定注入措辞里"产物长什么样"：

| artifact | 交付物形态 | 适用 |
|---|---|---|
| `firmware`（默认） | .h/.c 代码对 | 嵌入式开发 |
| `procedure` | 编号操作步骤/命令序列 | 操作规程、SOP |
| `document` | 文档章节 | 报告、说明文档 |
| `machine-ops` | 机器操作程序（远期预留） | 工业操作（v1 复用 procedure 措辞） |

## 7. checklist/<task>.md —— 分解清单

planner 拆步前必读的领域先验。写法自由（markdown），但要覆盖：
- 本领域典型任务的步骤骨架
- 每步应该选哪些零件（用零件 id 提及）
- 哪些环节必须显式标自由拆分

有多份清单时，`--checklist <task>` 或 config `checklistTask` 指定用哪份；缺省用第一份。

## 8. 日常工作流（填 pack 的正确姿势）

```
1. 建目录结构（照 §0 抄）
2. 写 pack.yml（domains + artifact）
3. 写 catalog.yml（先填 1-2 个零件，别贪多）
4. 填 parts/<id>/manual/（每条事实带来源）
5. node src/pack-check.js <pack>          ← L1 确定性检查，ERROR 清零再继续
6. node src/pack-check.js <pack> --ai     ← L2 AI 语义检查（可选但推荐）
7. node src/cli.js "目标" --pack <pack>   ← 真实跑一次 dispatch
8. node src/learn.js                      ← AI 总结这次跑的教训 → 人审 → 入库
9. 回到 4 继续填下一个零件
```

**铁律提醒**：AI 体检只降低出错概率不保证正确——manual 里的每个数值你都要对照原始说明书亲自核过，lint/learn 是助手不是替代。

## 9. 多 pack 与运行时选择

- `packs/` 目录下每个子目录自动注册为 pack（目录名=pack 名）
- 或 `wfe.config.json` 里 `"packs": {"robotics": "C:/path/to/robotics"}` 显式映射
- `defaultPack` 设默认；多个 pack 不指定会报错要求选择
- CLI：`--pack <名或路径>`；MCP：`ai_dispatch` 的 `pack` 参数

## 10. 常见坑（lint 会抓但最好别犯）

| 坑 | 后果 |
|---|---|
| catalog 用内联 `[a,b]` 列表 | 解析成单字符串，零件 incomplete |
| manual 条目忘写 `| 来源:` | 条目被拒收，引用它的 must_have 变空头支票 |
| must_have 引用不存在的 `[编号]` | 零件 incomplete，planner 不选它 |
| domain 没在 pack.yml 声明 | lint ERROR |
| 模板标 production 但没真机验证 | 执行 AI 会把它当权威用 |
| mistakes.jsonl 写注释行 | 非 JSON 行被跳过（warning） |
