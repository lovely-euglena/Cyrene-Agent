# MCP 工具注入策略调研（#166 / 工具瘦身④）

> 2026-10-23 · 云端线 · 父 issue #161（工具组瘦身）· 调研型，本 PR 不动注入行为（#152/#167 同 PR 另计）

## 一、现状（带文件行号）

### 1. 注册链：装即注册，全模式常驻

- `src/main/orchestrator/mcp-adapter.ts:214-269`：`connectMcpServer()` → `client.listTools()` → 逐工具组装 `ToolDefinition` → `toolRegistry.register(toolDef)`（:268）
- **toolDef 不带 `modes` 字段**（:222-249 组装面）——`tool-registry.ts:162 getEnabledToolsForMode` 对无 modes 工具恒可见 → **三 mode 全部进 prompt**
- `description` 原样透传（:226）、`inputSchema` 原样透传（:230-233）——**无截断、无压缩**
- 同名冲突跳过（:220）、effectKind 由 annotations/override 解析（:224）

### 2. 生命周期：启动全量自动重连，无 enabled 开关

- `mcp-manager.ts:80 initMcpManager`：读 `mcp-servers.json` 全量 `connectMcpServer`；由 `default-dependencies.ts:2364 restoreMcp` 装配（应用启动/恢复）
- `McpServerConfig`（mcp-adapter.ts:13）**没有 enabled 布尔**——装了就连，删除配置才停
- 断连唯一入口 `disconnectMcpServer`（mcp-adapter.ts:294）由删除/退出触发

### 3. 注入路径：main 侧 registry 单点消费

- `build-options.ts` 权威路径 `resolveRunCapabilities`（run-capabilities.ts）→ `buildToolSystemPrompt(resolvedMode, runTools)` 注入工具目录（进入 stablePrefix）
- **七 host 边界**：过滤发生在 **main 侧 toolRegistry/orchestrator**；mcp host（.NET）只管协议传输，无过滤概念——策略实现落 main 侧最薄

### 4. 会话级 opt-in：不存在

- `ToolModeOverrides` 来自 `styleSettings`（全局 style 配置），非会话维度——没有"本会话先不启用某 server"的通道

## 二、成本曲线（估算口径）

工具目录 token ≈ Σ(name + description + inputSchema 的 JSON 字节) ÷ 3.5（中文/JSON 混合保守换算）。

| 场景 | 工具数 | 估算 |
|---|---|---|
| filesystem-mcp | 11 | ~3-5K tokens |
| playwright-mcp | 21（browser_* schema 偏大） | ~8-15K tokens |
| 典型三 server 并装 | 40+ | **20K+ tokens/轮，恒定** |

对照：#162（PR #184）管的是"未配置的内置工具"（最多省 ~10K）；MCP 侧是**已配置但本会话未必用**——量级相当且随装机数线性涨，是瘦身第二大头。

## 三、方案对比

### A. server 级会话 opt-in + 默认注入元信息（推荐）

- `McpServerConfig` 加 `sessionScope: "always" | "on-demand"`（默认 on-demand，兼容项显式 always）
- on-demand server 启动**不自动连接**；prompt 只注入一行元信息（"已装 N 个 MCP server：a、b——需要时用 enable_mcp_server"）+ 新内置工具 `enable_mcp_server`/`disable_mcp_server`（会话生命周期内注册/反注册）
- **迁移成本：中**。mcp-manager 加 per-session 启用态（会话结束反注册）；settings UI 一处；启动行为变化需回归七 host restore 链
- 与 #184 互补：#184 管"未配置内置工具"，A 管"已装但本会话不用"的 MCP

### B. schema 懒加载（否）

首轮只给 name 清单、调用时补 schema——function calling 协议要求 tools+schema 每轮全量下发，两段式需厂商支持且破坏协议兼容。**不可行**，仅自研 harness 内部可做但得不偿失。

### C. host 侧过滤（否，边界错位）

过滤点在 main 侧 registry（mcp host 无过滤概念）——把策略塞进 host 需要新增 host↔main 状态同步，比 A 更贵。**不采纳**；但 A 的实现在 main 侧，与七 host 架构无冲突。

### D. description 长度治理（低成本补充，可与 A 同批）

部分 MCP server 的 description 写长文（原样透传是最大 token 来源）。`McpServerConfig.descriptionMaxChars` + adapter 截断。成本低、收益线性，治标——建议随 A 一起做。

## 四、结论与影响面

- **推荐**：A + D 组合，作为工具瘦身第二批次（等 PR #184 合并后开工，复用其 token 基线回归门禁做前后对照）
- **协议影响**：tool host ↔ main **无协议变更**（tools 列表本就每 run 组装）；新增的是 main 侧会话级启用态 + 两个内置工具 + settings 字段
- **风险点**：启动不自动连接改变 restore 语义——`always` 白名单兜底内置二 server（playwright/filesystem）；会话结束反注册要处理 pending 调用（`registeredIds` 已支持逐工具 unregister，mcp-adapter.ts:301）

## 验收对照

- [x] 现状描述（带行号）✓ 本文第一节
- [x] 成本曲线估算 ✓ 第二节
- [x] 推荐方案 + 迁移成本 ✓ 第三节 A
- [x] 协议影响面 ✓ 第四节（无协议变更，main 侧实现）
