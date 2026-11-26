# workflow-engine

确定性工作流引擎：**用严谨的流程，用上限换准确和性价比**。

planner 按领域包零件目录拆步 → 路由表选模执行（步内工具环自验证）→ 裁判对照零件契约+说明书验收 → stats 闭环。

三条铁律机械执行：**事实必须带来源、缺条目=未定义、拆分=封闭选型**。

## 快速开始

```bash
# 配置（复制示例后填 provider/key）
cp wfe.config.example.json wfe.config.json
cp keys.example.json keys.local.json   # 填 apiKey 或指向 key 文件

# 跑一次 dispatch（先有 pack 才有领域约束）
node src/cli.js "总目标" --pack <pack名>

# pack 体检（填知识库时用）
node src/pack-check.js <pack>          # L1 确定性检查
node src/pack-check.js <pack> --ai     # +L2 AI 语义检查

# 错题总结（跑完 dispatch 后）
node src/learn.js                      # AI 起草错题
node src/learn.js --accept <草稿>       # 人审后入库

# MCP 服务（宿主无关接入）
node src/mcp.js                        # stdio JSON-RPC，暴露 ai_dispatch tool
```

## 文档

- **[PACK-GUIDE.md](PACK-GUIDE.md)** — 领域包作者手册（写 pack 前必读）
- [PLAN.md](PLAN.md) — 开发计划书与路线图

## 架构（三层）

- **不变量层（锁死）**：三条铁律 + 流水线骨架 + fail-closed——代码硬编码，不可配置
- **策略层（可插拔）**：多 provider、路由表、裁判、工具集、交付物措辞、宿主适配
- **内容层（用户资产）**：领域包 = 零件目录 + 清单 + 模板 + 错题 + 说明书；**换领域=换目录**

## 测试

```bash
node --test test/    # 28 组离线测试，全假 chat 零网关
```

## 免责声明

pack lint（L1/L2）与 learn 错题总结都是 **AI 顾问**：只降低出错概率，不保证不会出错。
知识库内容可能含错误，导入与使用时必须人工核对，最终责任在人。
