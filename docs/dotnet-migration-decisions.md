# .NET 下沉拍板记录（A1-A19，2026-09-20）

> 依据《Cyrene-Agent .NET 下沉 + RAG/记忆重写 整合 TODO List》。
> 开发期无灰度，全部双轨 0/1 直切；未拍板项按建议默认值执行，可随时翻案——
> 翻案请改本文件并注明日期。

| ID | 事项 | 决定 |
|---|---|---|
| A1 | 工具重写顺序 | fs/git → search/apply-patch → 其余按 built-in 注册序 |
| A2 | 工具执行方式 | **同进程直接调用**（ToolHost 内 registry 直调，省一次编解码）；子进程帧保留为后备（native-tool-host 已有） |
| A3 | 沙箱 | `--sandbox-host`（AppContainer 自拼）独立立项；SRT 继续用 |
| A4 | jieba | Jieba.NET 试点（NuGet 已验证可拉）；BM25 不过关回退「分词留 TS，协议传 keywords」——协议两形态都支持 |
| A5 | SQLite | Microsoft.Data.Sqlite |
| A6 | IVF | 先惰性全量重建，实时增量索引后续优化 |
| A7 | L2 DMAE | 暂缓，独立评估，不入主线 |
| A8 | 分支 | `feature/dotnet-backend`（已建），每阶段独立 commit 可回退 |
| A9 | VAD 默认 | hybrid（本地门控+云端句尾） |
| A10 | VAD 归属 | 并入 cyrene-voice，不独立进程 |
| A11 | VAD 校准 | 列入：首帧噪声采样+阈值自适应 |
| A12 | 本地 ASR | 暂不（sherpa-onnx/whisper.cpp 另立项） |
| A13 | 语音排期 | 与工具层并行 |
| A14 | gptsovits | refAudioPath 由 .NET 侧读文件，TS 不传 buffer |
| A15 | 语音条目 | 独立 exe：`dotnet/voice/CyreneVoice`（net10.0 console sidecar） |
| A16 | 便携数据根 | exe 同级 `./data` 优先，不可写回退 %APPDATA% |
| A17 | 便携配置 | `./config` 优先，命令行可覆盖 |
| A18 | MCP HTTP | 仅 127.0.0.1，无认证；远程+token 另立项（N7） |
| A19 | MCP HTTP/stdio | 并存，同一工具注册表；`CYRENE_MCP_HTTP` 控制 |

## 统一双轨开关解析（B4/L17 共用）

优先级：**环境变量 > `./config/cyrene.conf`（KEY=VALUE 行）> 内置默认**。
代码唯一入口：`src/main/dotnet-backend/config.ts`（TS 侧）与
`CyreneNative.Runtime/HostConfig.cs`（C# 侧，便携模式共用同一解析规则）。

| 开关 | 默认 | 作用 |
|---|---|---|
| CYRENE_TOOL_HOST | 1 | 工具层 .NET 化 |
| CYRENE_AGENT_HOST | 0 | AgentHost 双轨 |
| CYRENE_LOOP_HOST | 0 | LoopHost 双轨 |
| CYRENE_RAG_HOST | 0 | RAG 数据层双轨 |
| CYRENE_MEMORY_HOST | 0 | 记忆系统双轨 |
| CYRENE_VOICE_HOST | 0 | 语音后端双轨 |
| CYRENE_VAD | hybrid | VAD 模式 local\|hybrid\|cloud |
| CYRENE_PORTABLE | 0 | 便携模式 |
| CYRENE_MCP_HTTP | 0 | Streamable HTTP MCP |
