# Cyrene .NET 后端总览（dotnet-backend）

> 状态：功能级完成 + **Linux 侧五套实测全绿**（96+ 项，见下「测试矩阵」）；Windows 实机冒烟待跑（scripts/dotnet-smoke.ps1）。
> 决策记录：docs/dotnet-migration-decisions.md（A1-A19）

## 测试矩阵（Linux 冒烟壳 dotnet/smoke-host，同源编译协议类）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/dotnet-smoke-linux.py` | 六 host 全链帧序（fs/计算器/RAG 迁移+混合检索/Agent 闭环/loop/记忆六表/越权自测） | 23/23 |
| `scripts/dotnet-edge-test.py` | 畸形帧/路径穿越/SQL 注入/1e308 权重/5MB payload/幽灵会话 | 13/13 |
| `scripts/dotnet-tools-matrix.py` | 工具逐个真实调用（calculator/now/sysinfo/fs 三件/expense/search_text/str_replace 两段式/apply_patch 事务/下载黑名单/**git 八件（真实仓库 + 本地 bare 远程）**；含 write 三态 changes 证据、账本与字符串数字校验、git 校验拒绝路径） | 79/79 |
| `scripts/dotnet-agent-loop-test.py` | 多轮工具环闭环/MaxTurns 硬闸/并发会话隔离/destroy 语义/畸形回注/白名单环内拦截 | 13/13 |
| `scripts/ipc-stress-test.ts` | 并发 20 call 路由/2MB payload/超时恢复/shutdown 清 pending | ALL PASS |
| `scripts/dual-track-diff.ts` | calculator + fs 三件（输出/字节）+ exchange_rate + expense（输出/账本）+ search_text（6）+ str_replace（8，含诊断/空文件播种）+ apply_patch（9，事务/迁移/EOL）+ download_file（7，本地 HTTP/字节/黑名单）+ git（29，镜像仓库/本地 bare 远程/commit-log-revert hash 归一/截断与 staged） | 计算器 12 + fs 7 + life 10 + search 6 + srepl 8 + apply_patch 9 + download 7 + git 29 |
| `scripts/plugin-security-test.ts` | .NET 插件 risk 闸门（未声明拒注册/透传/invoke 闭环/优雅关停） | ALL PASS |

实测修复的代表性缺陷：RagHost 建表 SQL 丢括号、Jieba 词典 Resources 不拷贝
（rag-host 从未真正跑通）、Cosine 漏除 entry 范数、ToolHost 帧竞态丢帧、
Agent 白名单只在自测验函数未接线（P0）、tool_result 生命周期断链、
git commit 漏子命令、IPC argv 双传。

## 七 host 进程地图（B3：独立启停，崩溃宿主监督重启）

| Host | 入口 | 阶段 | 状态 |
|---|---|---|---|
| 原生窗口 | `cyrene-native serve`（默认） | 前置 | 生产 |
| 分离托盘 | `cyrene-native --tray` | 前置 | 生产 |
| MCP 连接 | `cyrene-native --mcp-host` | M4 前置 | 生产骨架（stdio/SSE + 重连/超时/进程树清理） |
| 内置工具 | `cyrene-native --tool-host` | D | calculator/now/clipboard/sysinfo + fs 三件 + exchange_rate/expense/search_text + git 八件/apply_patch/download 接线（evidence 帧协议 v1 + config 帧，79 项矩阵实测） |
| Agent 会话 | `cyrene-native --agent-host` | H/J | LLM 回调闭环 + 多轮工具环 + orchestrate/mailbox/白名单**主路径拦截**（13 项实测） |
| RAG | `cyrene-native --rag-host` | E | SQLite/WAL + jieba BM25（CutForSearch+标点过滤）+ 混合检索（余弦修正）+ JSON 迁移 |
| 记忆 | `cyrene-native --memory-host` | I | L0/L1/冲突/反思表 + get/append op（L2/DMAE 建表暂缓驱动 A7） |
| 对话循环 | `cyrene-native --loop-host` | K | 状态机骨架（🔴 实机逐 token 一致性未过前禁开） |
| 语音 | `CyreneVoice.exe --voice-host` | F/G | TTS 四引擎 + minimax 骨架 + Silero VAD 三模式 + 自动校准 |

## 双轨开关（唯一解析入口 `src/main/dotnet-backend/config.ts`）

环境变量 > `./config/cyrene.conf` > 默认（表见 decisions 文档）。
所有 TS 客户端（native-tool-host/host-clients/agent-process-manager）在
开关=0/无 exe/超时/崩溃 时自动回退 TS 原路——无灰度直切（P10）。

## 铁律落实位（P 检查）

- B1 密钥不落 .NET：`agent-process-manager.ts` llm_request→streamChatWithSdk 代理
  - ⚠️ 2026-10-03 起拟迁移：密钥保存下沉 .NET DPAPI 密钥库（分阶段，见 [design/2026-10-03-secrets-migration-to-dotnet.md](./design/2026-10-03-secrets-migration-to-dotnet.md)）；切换前按 B1 执行
- B2 审批在 Electron：tool_request→setToolExecutor→executeToolCall（含 checkPermission）
- B8 语音边界：只动 `synthesizeByEngine` 引擎层入口（tts-dispatcher.ts），IPC/播放/转码/状态机零改动
- B9 VAD 隐私：local/hybrid 仅语音段上云（VadEngine 门控在发送方）
- B10 便携：HostConfig.cs（C#）+ config.ts（TS）同规则解析，./data 单根

## 安全加固（实测驱动）

- **MCP HTTP**（M5）：127.0.0.1 绑定 + 回环校验双保险 + **Host 头白名单**
  （DNS rebinding 防护——恶意页面把 evil.com 解析到 127.0.0.1 时 403）
- **.NET 插件 risk 闸门**（closed world）：SDK `CyreneToolAttribute.Risk`
  （缺省 unknown）→ adapter 白名单校验——未声明/unknown **拒注册**；
  `MAX_TOOLS_PER_PLUGIN=64` 防注册表撑爆；policyFor 非 full 档对 unknown 全 deny
- **IPC**（host-clients）：spawn `error` 事件立即反馈（ENOENT 不等超时）；
  超时 kill 先置 exited 防竞态；shutdown 清 pending；数组 mode argv 防双传
- **Agent 循环**：工具白名单在 MakeContinuation 主路径拦截（J6 落地）；
  tool_result 缺字段给明确 errorCode（不裸抛 KeyNotFound）
- **截图 helper**：prewarm 懒启动（路径预检不 spawn）+ 600s 空闲自杀
  （`SCREENSHOT_HELPER_IDLE_MS` 覆盖，0=永不），与 embedding sidecar 语义对齐

## 契约文档

- 帧协议（B5）：各 host C# 源文件头注释即规范（errorCode 字段统一）；
  ToolHost `config` 帧（timezone/dateLocale/dataDir 运行时注入）见 `ToolHostConfig`（C#）与
  `NativeToolHost.setRuntimeSettings`（TS）
- 写类工具 evidence 帧协议 v1：`docs/design/2026-10-03-tool-evidence-frame-protocol.md`
  （`changes: ToolFileChange[]` 随 result `data` 返回；策略层留 TS，见下）
- 多 Agent：docs/multi-agent-architecture.md
- 语音/VAD：dotnet/voice/CyreneVoice/ 源头注释
- 构建/发版：docs/build-guide.md

## Windows 冒烟（C3，必跑清单）

`scripts/dotnet-smoke.ps1`：tool-host 五工具双轨 diff、agent-host 闭环、
rag-host 迁移+逐 query、voice-host TTS mock、VAD 三模式、便携开关。
