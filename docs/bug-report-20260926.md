# Cyrene-Agent 遗留 Bug 报告（供修复 AI 使用）

> 生成：2026-09-26 · 基于 `origin/main`（HEAD `3f6707bc`）与 `upstream/master`（`b11b8851`）
> 历史修复记录见 §5，避免重复修。分级：P0 阻断 / P1 应尽快 / P2 排期 / P3 卫生。

---

## 0. 先读：仓库现状地图（不看这个会修错地方）

仓库存在**两条分叉的演进线**，merge-base 在 `9e47b6ee`（2026-09 初）：

| 线 | HEAD | 有什么 | 没有什么 |
|---|---|---|---|
| **origin/main**（实机线，其他 AI 正在修的） | `3f6707bc` | native 设置窗六 section（API/记忆/定时任务/Tokens/免责声明/Runtime）、插件市场修复链（自持仓库→恢复双源）、native-ui 主题化全套、sidecar 默认启用+打包、拖动/git 身份修复、.NET 插件修复（分帧/超时/指纹/Task<T> 卡死） | **云端线（feature/dotnet-backend）9/20-25 的全部后端整合**：RagHost/MemoryStore/LoopHost、统一 config 解析层、closed-world 插件闸门、ASR 阿里云+VAD 门控、IPC 五项修复、错误语义统一 |
| **云端线**（本地 `main` 含合并提交 `52bbcf1d`，未推送——token 失效） | `52bbcf1d` | 上游 154+66 提交合并、七 host 整合、五套测试 96+ 项、安全闸门、9/25 三修复 | 实机线的 native-settings 六 section 等 59 提交 |

**修复前必读**：两线合并是终局（本地 `52bbcf1d` 已做好一版，token 失效未推）。在 origin/main 上修 Bug 时，**改动的文件若同时存在于云端线，合并时会冲突**——修复请保持代码形状简单、注释写清意图。

---

## 1. P1 — 应尽快修

### B1【隐私】ASR 无 VAD 门控：静默段全量上云
- **位置**：`src/main/asr/asr-dispatcher.ts`（origin/main，全文仅 32 行）
- **现状**：mossland/火山引擎直通 `sendAudio`，**无任何静默过滤**。用户没说话时的环境音持续上传 ASR 云引擎
- **违反**：B9 铁律（本地/hybrid 模式静默段不上云）
- **参考实现**：云端线同名文件的 `createVadGate`（voice host 的 Silero VAD，`vad_result` 帧驱动 speechStart/speechEnd 状态机 + 320ms preRoll 防吃字头 + fail-open 直通）
- **注意**：①直接照抄云端版有坑——云端版曾因丢事件订阅导致"所有帧滞留 preRoll、ASR 收不到音频"（642c0ddb 修过），务必带订阅逻辑；②`vadConfig(mode)` 的 mode 只接受 `local|hybrid|cloud`（C# `VadEngine.Configure` 白名单，非法值静默降级 hybrid）
- **上游已换阿里云**（`9bbb9e69`），火山引擎上游已删——换引擎时一并处理

### B2【架构】agent-host 开关散读 env，绕过统一解析层
- **位置**：`src/main/orchestrator/agent-process-manager.ts:54`
- **现状**：`return process.env.CYRENE_AGENT_HOST !== "0" && resolveNativeWindowsExe() !== null;`
- **问题**：①违背"唯一解析入口"铁律（环境变量 > `./config/cyrene.conf` > 默认，应走 `resolveDotnetConfig()`）；②`!== "0"` 把 `"abc"`、`"false"` 都当启用
- **修复**：云端线方案——`config.ts` DEFAULTS `agentHost: true` + `toBool` 解析（`0/false/off` 关闭），此处改 `resolveDotnetConfig().agentHost && ...`

### B3【一致性】TS 插件轨 risk 缺省 = safe 放行（与 .NET 轨双标）
- **位置**（origin/main 上 5 处）：
  - `src/main/orchestrator/cyrene-agent.ts`：`tool.risk || "safe"`（1 处）
  - `src/main/scheduler/scheduler-ipc.ts:116`、`orchestrator/harness/tool-round.ts:38`、`orchestrator/build-options.ts:767`、`tools/registry/tool-catalog.ts`：`?? "safe"`
- **问题**：TS 插件（node runtime）不声明 `risk` 时按 safe 放行——**.NET 轨已 closed-world（未声明拒注册），TS 轨还在开放世界**，同一插件写两轨安全语义不同
- **修复建议**：TS 插件 loader 注册进 toolRegistry 时，未声明 risk 的插件工具补 `risk: "unknown"`；`ToolRiskLevel` 加 `"unknown"`；`policyFor` 非 full 档对 unknown 全 deny（云端线 `src/shared/permission-approval.ts` 有现成实现）
- **影响面**：存量 TS 插件若未声明 risk 会从"可用"变"拒绝"——需扫描现有插件确认（编译期断言 `plugin-port-contract.ts` 同步改）

---

## 2. P2 — 排期修

### B4【测试】7 个用例在 Linux CI 环境失败（Windows 通过）
- `src/main/screenshot/screenshot-service.test.ts` ×2 + `helper-client.test.ts` ×1：写死 `C:\shots`、`C:\helper\...` 路径，`pathToFileURL` 在 Linux 产生 `file:///home/.../C:%5Cshots%5C...`——**修复方向：路径经依赖注入或 `mkdtemp` 构造**
- `src/renderer/react/features/chat/components/ChatMessageList(.last-turn).test.ts`、`StreamdownMessageContent.test.ts`、`streamdown-message-content-state.test.ts` ×4：上游 React 组件测试在 Linux worker 环境失败（上游 CI `b11b8851` 修过同类 CHATS_SHELL_FILE 8.3 短路径问题，可参考其 native realpath 思路）
- 注意：`origin/main` 的 screenshot-service.test.ts 仍有 13 处 `shots` 硬编码

### B5【依赖】Electron 43.1.0 → 44.x 升级
- 上游生态已用 `Electron.WindowStatePersistence` 类型（44 新增）；实机线 package.json 仍 `^43.0.0`
- 升级后删除各处兼容垫片；重点回归：native 窗口（WPF 桥）、托盘、截图 helper

### B6【上游同步】origin/main 落后 upstream/master 66 提交
- 重点内容：计划模式（三档审批/副作用 fail-closed/崩溃恢复）、GPT-6 Sol·Luna + MiMo V2.6 模型档案、定时任务引擎、token 用量面板、Vite 8、欢迎页/免责声明、CTA 崩溃 reconcile
- 建议合并前先读云端线 `0b13dc02` 的冲突裁决记录（`docs/handover.md` §4）——同类冲突（音乐删除/scene-embedder/错误语义）已有拍板

---

## 3. P3 — 卫生

- **B7** 远端 `refs/heads/origin` 分支（指向上游 master 快照 `3626e41d`）——疑似误推，确认后删除
- **B8** `C:\cyrene-test-user-data\...` 测试产物文件曾入库（实机线已删）；云端线同步时保持删除态
- **B9** Gitee 私人令牌失效（401）——生成新 token（projects+groups 权限）后 `git push origin main` 推送本地待推提交 `52bbcf1d`
- **B10** 本地 `master` 分支（`82d8dc38`）已被 main 完全包含，可删

---

## 4. 修复时的高危区提示（前人踩过的坑）

1. **协议失配会被静默吞**：`try { void ragHostClient.call(...) } catch { /* ignore */ }` 模式遍布 dotnet-store——TS 侧调用了 C# 不存在的 op（如曾调 `delete_all`）不会有任何报错，只会在运行时留下脏数据。新增 op 时**先查 C# 侧分发表**（`dotnet/native-windows/Rag/RagHost.cs` 的 `case` 列表）
2. **Write/粘贴大文件可能截断**：VAD gate 曾因截断丢失事件订阅而 tsc 仍通过（语法完整但逻辑残缺）——改完必须跑 `npx vitest run src/main/asr/`
3. **测试全绿≠没 Bug**：上游 asr 测试只测路由不测 gate 逻辑；安全语义（closed-world/审批）要有专门用例
4. **错误语义统一**：帧级 `ok:false + errorCode`（勿用 `ok:true + data:"[错误]..."` 文本）；agent-host 异常路径必须回 result 帧（否则 TS pending promise 挂死）
5. **spawn 数组 mode**：`LineHostClient` 的 `mode` 若为数组，`argv = mode.slice(1)`（argv[0] 是可执行本身）——曾双传导致 dotnet 把自身路径当 dll

---

## 5. 已修复清单（勿重复修）

| # | 修复 | 提交 |
|---|---|---|
| 1 | RagHost 建表 SQL 丢括号 / Jieba 词典 Resources 未拷 / Cosine 漏除范数 | `ca91d0a6` |
| 2 | ToolHost 帧竞态丢帧 / MemoryHost get+append / llm_response ok 缺省误判 | `35eff464` |
| 3 | git commit 漏子命令 / fs_list_dir 错误语义统一 | `0b7f020b` |
| 4 | Agent 白名单主路径拦截（P0）/ tool_result 双形态+生命周期断链 | `0b7f020b` |
| 5 | agent-host 异常补 result 帧（promise 挂死） | 边缘测试轮 |
| 6 | IPC argv 双传 / resourcesPath / 超时 kill 竞态 / shutdown 清 pending / spawn error | `0b7f020b` |
| 7 | prewarm 懒启动 + helper 600s 空闲自杀 | `0e17d842` |
| 8 | .NET 插件 closed-world 闸门 + MAX_TOOLS=64 | `d44a0c85` |
| 9 | clearForRebuild 调不存在 op（→ C# Delete all:true）/ VAD gate 订阅丢失 / 幽灵字段 | `642c0ddb` |
| 10 | MCP HTTP Host 头白名单（DNS rebinding） | `d44a0c85` |
| 11 | 桌宠拖动抖动/校准（pointerId 过滤 + 自适应单位 k）| `8fff86a3` + `3b01d683` |
| 12 | 插件市场恒空 / SDK Task<T> 卡死 / 按行分帧 / 指纹 | `89fbf918` 等（实机线） |
| 13 | git dubious ownership + 提交身份 | `44720566` |
| 14 | 234 个构建产物出库 / dotnet bin/obj 忽略 | `abb57aa1` + `38950253` |

## 6. 待推送清单（token 恢复后）
- `52bbcf1d`（main ← feature 合并：云端收尾成果——handover 文档/安全闸门/9·25 三修复/插件闸门融合版）→ `git push origin main`
- 之后 `git push origin feature/dotnet-backend` 对齐指针
