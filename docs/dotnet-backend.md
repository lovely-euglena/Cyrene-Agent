# Cyrene .NET 后端总览（dotnet-backend）

> 状态：骨架→功能级完成；Windows 实机冒烟待跑（见 scripts/dotnet-smoke.ps1）。
> 决策记录：docs/dotnet-migration-decisions.md（A1-A19）

## 七 host 进程地图（B3：独立启停，崩溃宿主监督重启）

| Host | 入口 | 阶段 | 状态 |
|---|---|---|---|
| 原生窗口 | `cyrene-native serve`（默认） | 前置 | 生产 |
| 分离托盘 | `cyrene-native --tray` | 前置 | 生产 |
| MCP 连接 | `cyrene-native --mcp-host` | M4 前置 | 生产骨架（stdio/SSE + 重连/超时/进程树清理） |
| 内置工具 | `cyrene-native --tool-host` | D | fs/git/calculator/now/clipboard/sysinfo + ErrorCodes + 超时回退 |
| Agent 会话 | `cyrene-native --agent-host` | H/J | LLM 回调闭环 + 多轮工具环 + orchestrate/mailbox/白名单 |
| RAG | `cyrene-native --rag-host` | E | SQLite/WAL + jieba BM25 + 混合检索 + JSON 迁移 |
| 记忆 | `cyrene-native --memory-host` | I | L0/L1/冲突/反思表（L2/DMAE 建表暂缓驱动 A7） |
| 对话循环 | `cyrene-native --loop-host` | K | 状态机骨架（🔴 实机逐 token 一致性未过前禁开） |
| 语音 | `CyreneVoice.exe --voice-host` | F/G | TTS 四引擎 + minimax 骨架 + Silero VAD 三模式 + 自动校准 |

## 双轨开关（唯一解析入口 `src/main/dotnet-backend/config.ts`）

环境变量 > `./config/cyrene.conf` > 默认（表见 decisions 文档）。
所有 TS 客户端（native-tool-host/host-clients/agent-process-manager）在
开关=0/无 exe/超时/崩溃 时自动回退 TS 原路——无灰度直切（P10）。

## 铁律落实位（P 检查）

- B1 密钥不落 .NET：`agent-process-manager.ts` llm_request→streamChatWithSdk 代理
- B2 审批在 Electron：tool_request→setToolExecutor→executeToolCall（含 checkPermission）
- B8 语音边界：只动 `synthesizeByEngine` 引擎层入口（tts-dispatcher.ts），IPC/播放/转码/状态机零改动
- B9 VAD 隐私：local/hybrid 仅语音段上云（VadEngine 门控在发送方）
- B10 便携：HostConfig.cs（C#）+ config.ts（TS）同规则解析，./data 单根

## 契约文档

- 帧协议（B5）：各 host C# 源文件头注释即规范（errorCode 字段统一）
- 多 Agent：docs/multi-agent-architecture.md
- 语音/VAD：dotnet/voice/CyreneVoice/ 源头注释
- 构建/发版：docs/build-guide.md

## Windows 冒烟（C3，必跑清单）

`scripts/dotnet-smoke.ps1`：tool-host 六工具双轨 diff、agent-host 闭环、
rag-host 迁移+逐 query、voice-host TTS mock、VAD 三模式、便携开关。
