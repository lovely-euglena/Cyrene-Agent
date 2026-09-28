# P1 安全加固批次记录（ASR 静默门控 / agent-host 配置入口 / 工具风险 closed-world）

> 日期：2026-09-26 · 线：`origin/main`（本线，实机 Electron + .NET 原生窗口）
> 提交：`20586003`（B1）`964cb348`（B2）`3aea3133`（B3）`2d23091f`（B4）`356cd8bf`（构建卫生）
> 来源：P1「应尽快修」B1/B2/B3 + P2 的 B4（本线可修部分）+ P3 的 B7/B9 运维项
> 结论：B1/B2/B3/B4（截图部分）/B7/B8/B9/B10 完成并已推送；B5/B6 待排期（前置条件见 §6）

## 0. 总览

| 项 | 状态 | 提交 / 动作 |
|---|---|---|
| B1 ASR 无 VAD 门控（静默段全量上云） | ✅ | `20586003` |
| B2 agent-host 开关散读 env / `!== "0"` | ✅ | `964cb348` |
| B3 TS 轨 risk 缺省＝safe（开放世界） | ✅ | `3aea3133` |
| B4 Linux CI 用例失败 | 🟡 本线 3 例（截图路径）已修；4 例 React 组件测试本线不存在 | `2d23091f` |
| B5 Electron 43.1.0 → 44.x | ⏳ 待排期 | — |
| B6 同步 upstream/master（落后 66 提交） | ⏳ 待排期（需云端线冲突裁决记录） | — |
| B7 远端误推分支 `refs/heads/origin` | ✅ 已确认并删除 | `3626e41d` → deleted |
| B8 测试产物文件入库 | ✅ 核查 `git ls-files` 无残留 | — |
| B9 Gitee 令牌 401 | ✅ 凭据已恢复；`main` 已推送 | `3f6707bc..356cd8bf` |
| B10 本地 `master` 分支 | ✅ 本 clone 无该分支（仅 `gitee-fork/master` 远端引用） | — |

## 1. B1 ASR 静默段不上云（VAD 门控）

### 现象与风险

通话 PCM 帧（16kHz/16bit/mono，20ms/640B 一帧）此前由渲染端全量发主进程、
主进程直通 ASR 引擎（mossland 批量上传 / 阿里云 NWS 流式上传）。用户没说话时
的环境音会持续上行到云端 ASR，违反「本地/hybrid 模式静默段不上云」铁律。

### 修复（`src/main/asr/asr-dispatcher.ts`）

新增 `createVadGate(onFrame, options)`，作为引擎会话的外层门控：

- **preRoll 320ms**：静默期帧只进环形缓冲（按字节裁剪），`speechStart` 时先
  冲缓冲再放行——防吃字头。
- **状态机**：`speechStart` 开门；`speechEnd` 立即关门（后续帧回缓冲）；
  `stop/dispose` 丢弃未上行缓冲（挂断/换轮不残留迟到音频）。
- **fail-open 1500ms**：从首帧起一直没有收到任何 VAD 事件时直通降级
  （可用性优先）——对应历史事故「所有帧滞留 preRoll、ASR 收不到音频」
  （云端线 `642c0ddb`）的兜底；**收到过 VAD 事件后不再 fail-open**，
  用户长期沉默也保持门控。
- 时钟可注入（`now`），preRoll/fail-open 阈值可注入，便于单测。

`AsrStreamSession` 增 `reportVad(speech: boolean)`；`createAsrStream` 两个引擎
统一包门控。渲染端契约：

- 新增 IPC `CALL_VAD_STATE`（preload `window.call.sendVadState`）。
- 通话页 VAD（能量阈值）：状态变化立即上报 + 静默/说话期间 500ms 心跳
  （心跳让主进程知道 VAD 在线，避免误 fail-open）。
- 主进程 `handleVadState` 仅在 `inputOwner === "builtin"` 且 `LISTENING` 时
  转发给当前 ASR 流（外部插件持有语音输入时跳过，避免双输入源）。

### 引擎命名纠正

`volcano-asr-engine.ts` 实际实现的是**阿里云 NLS**（WebSocket + JSON，
`AliyunASR` 日志前缀），重命名为 `aliyun-asr-engine.ts`、类
`VolcanoAsrStream` → `AliyunAsrStream`；dispatcher 按 `engine: "aliyun"` 显式
路由（原先靠 else 兜底）。火山引擎实现已不存在。

### 不变量（后续改动必须保持）

1. 静默期帧不得进入 `engine.sendAudio`（preRoll 缓冲不算上行）。
2. 收到过任何 VAD 事件后，不得因超时 fail-open（长静默仍门控）。
3. `stop()`/挂断必须丢弃未上行缓冲。
4. VAD 事件完全缺失时必须 fail-open（不能把 ASR 憋死）。
5. 渲染端心跳间隔（500ms）必须显著小于 fail-open 阈值（1500ms）。

### 验证

```bash
npx vitest run src/main/asr/ src/main/call/   # 28 用例（含门控 5 例 + 路由 2 例 + 转发 1 例）
```

## 2. B2 agent-host 开关统一解析（`src/main/config.ts`）

### 现象与风险

`agent-process-manager.enabled()` 散读 `process.env.CYRENE_AGENT_HOST`，且用
`!== "0"` 判定：`"false"`、`"abc"` 都会被当成启用；同时绕过了「唯一解析入口」。

### 修复

新增 `src/main/config.ts`：

- `toBool(value, fallback)`：`1/true/on/yes` → true；`0/false/off/no` → false；
  其余（含非法串）→ fallback。支持 boolean / number 直接判定。
- `resolveDotnetConfig()`：优先级 **环境变量 > `./config/cyrene.conf` > 默认**。
  conf 为 `key=value`（支持 `#` `;` 注释；键名忽略大小写与 `-/_` 分隔）；
  默认值 `DOTNET_CONFIG_DEFAULTS.agentHost = true`。
- `resetConfigCache()` 供测试/热更新清缓存；`configPath` 可注入（仅测试）。

`agent-process-manager.enabled()` 改为
`resolveDotnetConfig().agentHost && resolveNativeWindowsExe() !== null`。

### 不变量

1. 业务模块禁止再读 `process.env.CYRENE_AGENT_HOST`（读 `resolveDotnetConfig()`）。
2. 新增 .NET 侧开关时扩 `DotnetConfig` + 默认值，不改调用点解析方式。

### 验证

```bash
npx vitest run src/main/config.test.ts          # 6 用例：真假词/非法值/文件优先级/空环境变量
npx vitest run src/main/orchestrator/agent-process-manager.test.ts
```

## 3. B3 工具风险级 closed-world（缺省不再当 safe）

### 现象与风险

TS 插件轨的插件工具在 `src/plugins/context.ts` 已按 `undeclared` 注册
（未声明 risk：只读档拒绝、每次审批档询问），但**宿主多处决策点**仍以
`?? "safe"` 兜底：一旦有工具以 `undefined` risk 进入这些路径（MCP 工具、
动态注册工具、测试夹具），就会静默放行，与 .NET 插件轨 closed-world 双标。

### 修复

1. **兜底翻转**（缺省 → `"undeclared"`）：
   - `orchestrator/cyrene-agent.ts`（工具执行前权限检查）
   - `orchestrator/harness/adapter/tool-runtime.ts`（计划只读拦截 + 权限检查）
   - `orchestrator/harness/tool-round.ts`（工具完成观察事件的 risk 上报）
   - `orchestrator/tools/registry/tool-catalog.ts`（工具目录展示）
   - `orchestrator/build-options.ts`（计划只读的工具过滤）
   - `scheduler/scheduler-actions.ts`（渲染层工具列表投影）
2. **内置工具显式定级**（本轮扫描发现的缺口，缺失即契约失败）：
   - 记忆：`imported_docs` / `user_memory` / `read_memory` → `safe`；
     `write_memory`（mutation）→ `fs-write`（只读档必须拒绝）。
   - `play_live2d_action` → `safe`；`pop_quiz` → `safe`。
   - Obsidian 六工具：`list_files` / `search` / `read_file` / `read_section`
     → `fs-read`；`edit` → `fs-write`；`open_note`（拉起 Obsidian UI）
     → `input-control`。
3. **MCP 工具** `resolveMcpRisk(annotations, overrides, toolName)`：
   - 显式 `effectKindOverrides`：`read → fs-read`、`unknown → undeclared`、
     其余 → `fs-write`；
   - `destructiveHint === true` → `fs-write`（优先）；
   - `readOnlyHint === true` → `fs-read`；
   - 无 annotations / 无匹配 → `undeclared`（不再静默放行）。
4. **回归门禁** `tool-risk-contract.test.ts`：注册全部内置 + Obsidian +
   pop_quiz 工具后，任何 `risk === undefined` 立即失败。
   MCP 映射表在 `mcp-adapter-sse.test.ts` 补 3 例。

### 影响面与回退方式

未声明 risk 的工具由「全档可用」变为：完全访问档放行、每次审批档弹审批、
其余档拒绝（错误信息会提示去「设置 → 高级 → 安全/文件权限档位」调整）。
受影响工具按上面的显式定级已恢复预期行为；MCP 服务若因缺 annotations 被拒，
可在「连接手机/工具配置」中给该 server 配 `effectKindOverrides` 或调档位。

### 不变量

1. 任何 `tool.risk` 读取点一律 `?? "undeclared"`，禁止 `?? "safe"`。
2. 新增内置工具必须显式声明 `risk`（契约测试会拦）。
3. 插件侧不能主动声明 `undeclared`（`context.ts` 只允许六种合法值；缺省由宿主写）。

## 4. B4 用例跨平台（本线可修部分）

`screenshot-service.test.ts` / `helper-client.test.ts` 写死
`C:\shots`、`C:\helper`、`C:\user-data` 等 Windows 路径：Linux CI 上
`pathToFileURL` 按 POSIX 拼接出 `file:///home/.../C:%5Cshots%5C...`，3 例断言失败。

修复：路径一律 `os.tmpdir()` + `path.join` 构造；previewUrl 期望值用
`pathToFileURL(...)` 现算（不再手写 `file:///C:/...`）。校验逻辑仍保持
`path.win32` 语义（生产仅 Windows），用例不再依赖盘符。

> 清单里的另外 4 例（`ChatMessageList.last-turn` / `StreamdownMessageContent` /
> `streamdown-message-content-state`）在**本线不存在**，属云端线/上游代码，
> 待 B6 同步处理。

## 5. P3 运维动作

- **B7**：远端 `refs/heads/origin`（`3626e41d`，上游 master 快照，含
  “Merge pull request #109 from Playa-Cyrene/dependabot/npm_and_yarn/vitest-5.0.1”）
  已确认不被 main 包含、无本地引用 → `git push origin --delete origin` 删除。
- **B8**：`git ls-files | grep cyrene-test-user-data` 为空，无入库残留。
- **B9**：`git ls-remote origin` 正常（令牌/凭据已恢复），已推送
  `3f6707bc..2d23091f`、`..356cd8bf`；清单提到的 `52bbcf1d` 不在本仓库
  （属另一 clone/线）。
- **B10**：本 clone 无本地 `master`；仅 `gitee-fork/master` 远端引用。

## 6. 待排期项与前置条件

### B5 Electron 43.1.0 → 44.x

前置：确认 `Electron.WindowStatePersistence` 相关的兼容垫片位置（本线暂无
该 API 使用，升级后删除垫片）；升级窗口需专项回归：WPF 桥（native 窗口
spawn/布局/DPI）、分离托盘（named pipe）、截图 helper（Rust sidecar）、
自动更新（asar 完整性校验）。建议独立分支 + 整机冒烟后合并。

### B6 同步 upstream/master（落后 66 提交）

前置：① 配置 upstream remote（本 clone 仅有 gitee origin/fork）；② 先读云端线
`docs/handover.md` §4 的冲突裁决记录（音乐删除 / scene-embedder / 错误语义
等已有拍板）；③ 合并重点：计划模式（三档审批/副作用 fail-closed/崩溃恢复）、
模型档案（GPT-6 Sol·Luna / MiMo V2.6）、定时任务引擎、token 用量面板、
Vite 8、欢迎页/免责声明、CTA 崩溃 reconcile。合并后需重跑本记录 §1/§3 的
不变量测试（asr / tool-risk-contract）。

## 7. 高危区核对（清单 §4）

| 提示 | 本线核对结果 |
|---|---|
| 协议失配会被静默吞（RagHost op 先查 C# 分发表） | 本批未新增 Rag op；RAG 阶段的 native 调用仍以 `RagHost.cs` case 列表为准 |
| 大文件写入截断（VAD gate 曾丢订阅） | 门控自带订阅/上报链路（`reportVad` + 心跳），已跑 `src/main/asr/` 全量 |
| 测试全绿≠没 Bug | 风险语义新增契约测试 + MCP 映射单测；门控新增 fail-open/长静默/裁剪用例 |
| 错误语义：帧级 `ok:false + errorCode` | 本批未改帧协议；agent-host 退出路径已核对会 reject 全部 pending step（`steps` 清空 + resolve 失败） |
| spawn 数组 mode：`argv = mode.slice(1)` | 本线无 `LineHostClient`（云端线代码），无此风险 |

## 8. 验证命令（可复现）

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run src/main/asr/ src/main/call/ src/main/config.test.ts
npx vitest run src/main/orchestrator/tools/registry/ src/main/orchestrator/mcp-adapter-sse.test.ts
npx vitest run src/main/screenshot/
npm test                                    # 全量
npm run package:win:dir                     # 打包（asar 已确认含新代码、无旧 volcano 产物）
```
