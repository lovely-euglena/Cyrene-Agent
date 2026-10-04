# PR 审查规则

> 状态：现行（2026-10-04 起）
>
> 适用：向 `main` 提交的全部 PR（含 .NET 双轨与云端批次）。
>
> 配套：[.github/CONTRIBUTING.md](../.github/CONTRIBUTING.md)（哪些改动需要先开 Issue 讨论）、[.github/pull_request_template.md](../.github/pull_request_template.md)（作者自查清单）。
>
> 审查方式：维护者按本规则逐项人工审查；如后续接入自动审查，以本文件为规则源。

## 0. 通用门槛（每个 PR 必查）

- **单一目标**：只含与 PR 目标直接相关的改动；无夹带格式化、重构、无关文件。
- **先讨论后动手**：核心模块（Harness / Memory / Plugin API / 工具系统 / 上下文 / 权限 / 调度器）的行为、契约或安全边界改动，必须有 Issue 讨论记录并在 PR 中关联。
- **可复现验证**：给出验证命令与实际输出（计数、日志）；「本地跑过」不作为证据。
- **跨模块链路**：涉及多模块时验证实际运行链路，不只看单函数或单测。
- **生命周期资源**：新增进程 / 缓存 / 锁 / 临时文件 / `AbortSignal` 时，清理覆盖正常、失败、中止、退出四类路径。
- **文档同步**：行为变化更新对应「现行」文档；批次结束更新决策记录（如 `docs/dotnet-migration-decisions.md`）。
- **分支与提交**：分支命名 `issue/<编号>`；一件一批；更新分支用 merge，禁止 rebase 后强推共享分支。
- **合并方式**：PR 由维护者确认后合并；合并前所有阻断项必须清零。

## 1. 模块审查矩阵（全量）

> 🔴 = 高危敏感模块，除本表审查点外必须逐条核对 §2 对应专项。

### 1.1 主进程 · 智能体核心

| 模块 | 路径 | 审查要点 |
| --- | --- | --- |
| Harness / 主循环 | `src/main/orchestrator/harness/`、`src/main/orchestrator/` 下 `agent-runtime.ts`、`chat-loop.ts`、`cyrene-agent.ts`、`harness-adapter.ts` | run 生命周期与终态、统一结算语义、取消/超时/错误的区分、重试策略、`AbortSignal` 贯穿、AG-UI 事件顺序 |
| 工具系统 | `src/main/orchestrator/tools/` | 工具参数/返回契约、模式（chat / work / learn / code）暴露规则、写保护（阈值 / 快照 / 熔断）、evidence 帧协议、native 回退语义 |
| 上下文与提示词 | `src/main/orchestrator/` 下 `build-options.ts`、`context-manager.ts`、`prompt-layers.ts`、`src/main/runtime-policy/token-budget.ts`、`src/main/prompts/` | 提示词分层与缓存命中、压缩/裁剪阈值与恢复、token 预算分配、注入顺序与格式（记忆 / Worldbook / 工具结果 / 历史） |
| 记忆 | `src/main/memory/` | 判定与冲突策略、淘汰/压缩、schema 迁移、注入选择与排序、DMAE 行为 |
| 权限 | `src/main/permission/`、`src/main/permission.ts`、`src/main/user-choice.ts`、`src/main/shell-execution-policy.ts`、sandbox | 任何放宽必须先讨论；审批流结算/重播/终态清理；沙箱与 shell 策略规则；新增审批操作类型 |
| 调度器 | `src/main/scheduler/`、`src/main/orchestrator/task-runtime.ts` | 错过任务处理、`nextFireAt` 重排、插件任务宿主不变量（enabled / toolMode / 授权指纹 / 所有权）、存储 schema |
| 任务与编排 | `src/main/tasks/`、`src/main/orchestrator/agent-orchestration/`、`src/main/orchestrator/review/` | 任务编排接口契约、子 Agent 边界、review tracker 生命周期 |
| 插件运行时 | `src/main/plugin-host/`、`src/main/plugin-panel/`、`src/plugins/` 🔴 | 生命周期状态机、事件总线命名空间、动态提示词配额/超时、ZIP 导入防护、manifest 契约 |
| 运行时策略 | `src/main/runtime-policy/` | 预算 / 限流 / 模式判定规则变更的影响面 |

### 1.2 主进程 · 领域模块

| 模块 | 路径 | 审查要点 |
| --- | --- | --- |
| 会话与聊天 | `src/main/chat/`、`src/main/chats/` | 会话持久化与迁移、消息分段、导出（HTML / Markdown） |
| 渠道 | `src/main/channels/` 🔴 | 适配器契约、飞书 / QQ / NapCat 凭据与回调校验、会话绑定、断线重连 |
| 主动对话 | `src/main/proactive/` | 触发频率与抑制、投递目标（invalidate 语义）、消息来源边界 |
| 朋友圈与社交 | `src/main/moments/`、`src/main/relationship/`、`src/main/social-context/`、`src/main/news/` | 发布/互动行为、频率与内容策略、隐私数据出站 |
| 媒体 | `src/main/music/`、`src/main/tts/`、`src/main/asr/`、`src/main/call/`、`src/main/mossland/`、`src/main/screenshot/`、`src/main/ocr/` | 外部二进制（mpv / pandoc）生命周期、音频设备、TTS / OCR 密钥、sidecar 超时与取消 |
| 本地能力 | `src/main/browser/`、`src/main/lsp/`、`src/main/ssh/`、`src/main/cloud-storage/`、`src/main/knowledge-base/`、`src/main/rag/`、`src/main/learn/` | 导航与文件访问边界、语言服务进程管理、SSH / 云存储凭据、向量库迁移与检索质量回归 |
| 技能 | `src/main/skills/` | 技能目录扫描与解析安全、模式覆盖（skillModeOverrides）、技能文件引用 |
| CITA | `src/main/cita/`（装配见 `src/main/services/cita/`） | 引擎选择与装配边界、行为回归 |
| Git 与同步 | `src/main/code-git/`、`src/main/sync/`、`src/main/dotnet-backend/`、`src/main/protocols/` 🔴 | 见 §2.7；sync-protocol 契约（`fixtures/sync-protocol/`）双轨一致 |
| 平台与设置 | `src/main/settings/`、`src/main/windows/`、`src/main/application/`、`src/main/startup/`、`src/main/services/`、`src/main/updater/`、`src/main/portable/`、`src/main/token-stats/`、`src/main/toast/`、`src/main/sim/`、`src/main/utils/` | 设置 schema / 迁移 / 敏感键、窗口与托盘生命周期、组合根启动顺序与退出注册、更新源与便携数据目录 |

### 1.3 界面与桥接

| 模块 | 路径 | 审查要点 |
| --- | --- | --- |
| 渲染进程（React） | `src/renderer/react/`、`src/renderer/react-perf/` | 组件行为与回归、i18n 三语（zh-CN / en / ja-JP）同步、长列表/流式渲染性能 |
| 渲染进程（其余） | `src/renderer/`（`settings` 旧页、`sidebar`、`tasks`、`toast`、`live2d`、`sticker-manager`、`call`、`call-react`、`ui`、`lib`、`types`、`i18n-runtime`、`shared`、`tast`、`public`） | 与主进程契约一致、新旧页面行为对齐 |
| IPC 桥 | `src/preload/`、`src/shared/ipc-channels.ts` 🔴 | 见 §2.3：通道白名单、参数校验、contextBridge 边界 |
| 共享层 | `src/shared/` | 类型/常量契约变更的影响面（主进程 / 渲染进程 / 测试） |
| CLI | `src/cli/` | 命令行为与文档一致、退出码 |

### 1.4 .NET 与原生

| 模块 | 路径 | 审查要点 |
| --- | --- | --- |
| cyrene-core | `dotnet/cyrene-core/` 🔴 | 保持 net10.0 洁净（无 WPF / WinForms，`scripts/check-cyrene-core-clean.py` 断言）；工具执行器与 TS 双轨同构；内部参数信任边界 |
| native-windows | `dotnet/native-windows/` | 窗口 / 宿主生命周期、与 TS 的消息协议 |
| sidecar | `dotnet/voice/`、`dotnet/ocr-sidecar/`、`dotnet/embedding-sidecar/`、`dotnet/token-stats/` | 进程启动/退出/超时、模型与资源路径、随包发布完整性 |
| 插件 SDK | `packages/plugin-sdk/`、`dotnet/plugin-sdk/` | manifest schema 契约、打包内容校验、示例编译冒烟 |
| 云端 | `dotnet/cloud-server/` 🔴 | 见 §2.6：鉴权 / 权限、存储加固、限流、代理头、healthz |
| 测试宿主 | `dotnet/smoke-host/`、`fixtures/` | selftest fixtures 与契约用例同步；测试计数口径与文档一致 |

### 1.5 工具链与交付

| 模块 | 路径 | 审查要点 |
| --- | --- | --- |
| 脚本与验证 | `scripts/` | 跨平台（Linux 可跑）；矩阵 / 冒烟 / dual-track 计数口径与文档一致；失败必须非零退出 |
| 打包与资源 | `electron-builder.yml`、`resources/`、`native/`、`vendor/`、`models/` | 产物校验（`verify:installer`）、随包二进制清单、模型下载与许可 |
| 流水线 | `.github/workflows/` | 触发分支/路径过滤与仓库现状一致（禁止死触发）；权限最小化 |
| 资源与示例 | `skills/`、`prompts/`、`examples/`、`poc/`、`assets/` | 示例可运行、提示词/技能文件编码与引用正确 |
| 文档 | `docs/` | 按 `docs/README.md` 维护约定：状态行、索引登记、命名规范 |

## 2. 高危敏感专项（逐项必查）

### 2.1 权限与沙箱 🔴

- 放宽权限（默认放行、白名单扩大、跳过/降低审批）必须有 Issue 讨论记录；无讨论即阻断。
- 审批流：结算路径、pending 重播、终态清理；新增状态必须覆盖「重播 + 取消 + 重启」。
- shell 守卫 / 沙箱：规则变更需正反测试（应放行 + 应拦截），并说明绕过面。
- 工具模式暴露变化：新增暴露面要有测试覆盖；写入类工具保持写保护。

### 2.2 凭据与密钥 🔴

- 密钥不得出现在日志、错误消息、渲染进程、测试快照与提交内容；新增字段默认脱敏。
- 密钥存储变更（如迁移到 .NET / 密钥库）：兼容旧数据读取 + 失败回退，不破坏已保存配置。
- 云侧令牌：常量时间比较、比较后清零、日志不回显；设备 / 主令牌权限规则见 §2.6。
- Git / 渠道 / 云存储凭据：不得写入仓库与临时文件；credential helper 凭据链行为不破坏。

### 2.3 信任边界与内部参数 🔴

- `__` 前缀内部参数（`__cyreneRoot`、`__sessionId`、`__gitCommand`、`__gitIdentity`、`__gitConfigGlobal` 等）只能由主进程可信装配注入；来自模型 / 渲染层的一律视为攻击并拒绝。
- 新增 IPC 通道：preload 白名单 + 主进程校验；渲染层输入（路径 / 命令 / URL）不可信。
- 插件边界：ZIP 导入防护、资源所有权、事件命名空间（`host:*` / `plugin:<id>:`）；放宽需先讨论。

### 2.4 进程与命令执行 🔴

- 子进程参数用参数数组传递（`ArgumentList`），禁止字符串拼接；路径与参数必须校验。
- 环境隔离：内置 git 的 `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL` 语义、独立配置文件开关；其他外部二进制的 env 最小化。
- 下载 / 解压（MinGit / mpv / 模型 / 更新）：校验和与清单校验必须保留；新增来源需固定且可验证。
- 外部进程必须可中止（超时 + 取消），错误分级（哪些可重试）。

### 2.5 数据与存储 🔴

- 存储加固：Linux 目录 0700 / 文件 0600 / `umask 0077`，含 WAL / SHM 附属文件；新增落盘文件必须补权限断言（Linux 环境验证）。
- schema 迁移：向前兼容、失败回退、并发写安全；必须有测试与回滚说明。
- 生命周期资源（临时文件、锁、DB 连接、`AbortSignal`）：正常 / 失败 / 中止 / 退出四路径清理。
- 云端事件存储：水位、有界队列、窗口化安全语义变更需说明并保持不变量。

### 2.6 网络与云服务 🔴

- 新端点必须有 principal 校验与反向断言（越权 403）；设备管理规则：`GET /v1/devices` 仅 master，rotate / revoke = master 任意 / device 仅自身。
- 转发头与限流：`KnownProxies` 语义变更需验证真实客户端 IP 与 healthz 鉴权。
- 出网调用：超时、重试分级、取消；不得静默吞错；错误信息不泄密。
- healthz / 探针：性能敏感路径不得物化整表（用聚合查询）。

### 2.7 Git 操作 🔴

- 所有写操作（commit / revert 等）必须注入提交身份；新增操作不得绕过身份校验（缺邮箱拒绝并提示）。
- 独立配置文件（IKJMO8）：开关关闭时维持隔离语义；快照 / `include` / 覆盖的优先级（应用覆盖最后生效）；凭据链不破坏。
- 命令确定性：不依赖全局 / 系统配置的隐含假设；CI 环境（无全局身份）必须可复现验证。
- 双轨同构：TS 与 .NET 行为一致；`scripts/dual-track-diff.ts` 基线必须绿。

### 2.8 更新与打包 🔴

- 更新源固定：不得静默改变已安装客户端的更新来源；`--publish never` 保持至发布流程启用。
- 产物校验：`verify:installer`、latest.yml、随包二进制（MinGit / mpv / 截图 / OCR / 语音）齐全。
- 工作流权限最小化（`contents: read`）；发布权限单独授予并人工核对。

### 2.9 上下文与提示词 ⚠️

- 注入顺序 / 格式变更需说明缓存命中与 token 预算影响。
- 外部内容（网页 / 文件 / 渠道消息）不得提升为系统指令，防提示词注入。
- 记忆写入边界：敏感信息过滤、用户数据最小化。

## 3. 验证证据要求（按改动类型）

| 改动类型 | 最低验证 |
| --- | --- |
| TS 任意 | `tsc` main / preload / renderer 均 0 错误 + 相关 `vitest` |
| 核心运行时（orchestrator / harness / tools） | 上述 + 相关集成或循环冒烟 |
| .NET 任意 | smoke-host 构建 + 相关脚本（`scripts/dotnet-tools-matrix.py`、`scripts/dotnet-edge-test.py`、`scripts/dotnet-agent-loop-test.py`） |
| git / sync 双轨 | 矩阵 + `scripts/dual-track-diff.ts` + selftest fixtures（`fixtures/sync-protocol/cases`） |
| cloud-server | `scripts/dotnet-cloud-sync-test.py` 冒烟（含 Linux 权限断言）+ 越权反向断言 |
| 打包 / 更新 | 产物构建 + `verify:installer`（无法本地验证时说明原因与替代证据） |
| 文档 / 流水线 | 链接有效、无死引用；工作流触发条件与仓库现状一致 |

口径要求：文档中出现的测试计数（矩阵 N、冒烟 N、dual-track N）必须与脚本实际输出一致；计数变化时同步更新所有引用处。

## 4. 阻断标准（未清零不得合并）

1. 核心模块方向性改动无 Issue 讨论；
2. 安全 / 权限 / 凭据 / 存储加固倒退；
3. 破坏契约（sync-protocol、插件 manifest、工具参数/返回、IPC）；
4. 高危敏感改动无验证证据或证据不可复现；
5. 测试红，或新增行为无测试；
6. 夹带无关改动、rebase 强推共享分支、新增死触发工作流。

## 5. 审查记录

- 每批完成后更新对应文档：设计稿状态行、`docs/dotnet-migration-decisions.md` 决策增量、`docs/internal-issue/` 记录（按需）。
- 阻断项与修复轮次写入 PR 评论；合并前逐项确认清零。
