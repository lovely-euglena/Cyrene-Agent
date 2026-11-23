# .NET 插件层现状盘点（2026-11-23）

> 盘点触发：插件层重写攻坚回看（#90-#94 系列）。对照上游 origin/master（f6d8a5ed）——
> **上游无 dotnet/ 目录（纯 Electron/TS），本仓 .NET 插件层是 fork 独有资产**。

## 工程清单（9 个 csproj，全部 net10.0）

| 工程 | 规模 | 角色 | 状态 |
|---|---|---|---|
| `cyrene-core` | 69 文件 / 16.4K 行 | 核心引擎：Agents / Channels / Llm / LoopHost / Mcp / MemoryStore / Rag / Scheduler / Secrets / Sync / Tools / HostProtocol | 既有"七 host"已整合于此 |
| `plugin-sdk`（Cyrene.PluginSdk） | 10 文件 / 1.55K 行 | 插件契约层：CyrenePluginBase（abstract，OnStartup/OnShutdown/OnOpen 三个 virtual 生命周期）/ CyreneToolAttribute（工具注册）/ PluginDeps / PluginEvents / PluginStorage / PromptProvider / PluginHostException | **契约已定，尚无真实插件接入**（仅 Example/HelloDotnet 示例） |
| `native-windows` | 65 文件 / 24K 行 | Win32 层：TrayHost / 桌宠分层窗口 / Live2D 窗口壳 / 渲染壳 | #257 Live2D sidecar 的窗口面 |
| `cloud-server` | 51 文件 / 14.5K 行 | 云端服务（云同步/渠道托管服务端） | |
| `embedding-sidecar` | 26 文件 / 4.9K 行 | 向量嵌入 sidecar | RAG 链路 |
| `voice/CyreneVoice` | 5 文件 / 704 行 | 语音独立 exe（ASR/TTS 引擎并轨） | #253 DeepSeek 语音接入 |
| `smoke-host` | 13 文件 / 2.3K 行 | 冒烟宿主（CI 可无头跑） | |
| `ocr-sidecar` | 3 文件 / 399 行 | OCR sidecar | |
| `token-stats` | 1 文件 / 428 行 | token 统计 | |

## 插件契约面（plugin-sdk）

- **装载模型**：`CyrenePluginBase` abstract + 三个生命周期钩子（OnStartupAsync / OnShutdownAsync / OnOpenAsync）
- **工具注册**：`CyreneToolAttribute` 标注 → 主进程工具面
- **依赖注入**：`PluginDeps` / 事件 `PluginEvents` / 隔离存储 `PluginStorage`
- **示例**：`plugin-sdk/Example/HelloDotnet`（HelloDotnet.csproj + Plugin.cs + Program.cs）

## 与上游的关系

- 上游 origin/master 无任何 .NET 工程——吸收上游 commit 时 `dotnet/` 目录**天然无冲突**
- 本仓 .NET 层的演进完全独立于上游版本节奏（当前基线 main=8448dee7，上游已到 f6d8a5ed）

## 镜像现状

- Gitea（主仓）→ GitHub（镜像，Actions 用）push mirror 持续同步
- dotnet-backend workflow（!264）在镜像仓跑 win 构建矩阵；本仓 CI 尚未覆盖 live2d（!264 已修）
