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
| A20 | 密钥保存 | 分阶段迁移 .NET：Phase 1 统一 DPAPI 密钥库（模型/视觉/TTS/ASR），TS 按需取用不落盘；Phase 2 请求处理是否下沉待议；过渡期 B1 保留 |

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

## 2026-10-03 增量：记忆系统 .NET 双轨接线（A7 落地）

- **A7 更新**：L2 DMAE **存储层**不再暂缓——`MemoryHost` 七表（`l0_working` / `l1_longterm` /
  `l2_dmae` / `evidence` / `conflicts` / `reflections` / `dmae_state`）全部可读写；
  **DMAE 算法本身仍在 TS**（`l2-dmae-manager.ts`），.NET 只做 SQLite 持久化。
- `CYRENE_MEMORY_HOST=1` 时 `memory-store` 的 `load/save` 直切 `--memory-host`（SQLite 为真值，
  成功后镜像一份 `memory.json` 供回退）；开关关 / exe 缺失 / 超时 / 崩溃自动回退 TS 原路。
- 首次 open 时导入对象形 `memory.json`（l0/l1/l2/evidence/conflictLogs/reflectionLogs/l2DmaeStates）；
  之后不再重复导入，避免旧快照覆盖 host 真值。
- 冒烟：`node scripts/diagnostics/memory-host-smoke.mjs`（8 项，对象导入 + replace/query/get/delete/clear/stats）。

## 2026-10-03 增量：D 阶段收口——fs 三件接线 + evidence 帧协议 v1（T0）

- **fs 三件自本日起由 TS 宿主包装器接线（nativeFirst）**：`read_file` / `write_file` /
  `list_dir` 在 `fs-tools.ts` 注册时包装——host 可用走 `--tool-host`，任何故障/错误载荷
  整体回退 TS 原实现；`CYRENE_TOOL_HOST=0` 时零触达。
- **分工**：路径解析 / 覆盖防骤降（`checkOverwriteDrop`）/ review 基线（`captureBefore`）
  留在 TS 包装器（语义拒绝不因轨道切换改变）；落盘与 `changes` 证据由 .NET 产出
  （`ToolEvidence.cs`，上限 60/200/200 与 `tool-evidence.ts` 对齐）。
- **协议**：`docs/design/2026-10-03-tool-evidence-frame-protocol.md`（不新增帧类型，
  写类工具 result `data` 必须携带 `changes`）。
- **对齐修复**：C# `list_dir` 截断 500→200、`read_file` 仅绝对路径、`humanBytes` 精度与 TS 对齐。
- **死代码清理**：`native-tool-router.ts` 白名单（fs 三件）从未被任何注册点触达，
  随接线删除；`built-in-tools.ts` 去包装（各工具在自身 execute 内接 native）。
- **验证**：`dotnet-tools-matrix.py` 22/22（含 write 三态证据）；
  `dual-track-diff.ts` fs 段（输出投影+字节级）；`fs-tools-native.test.ts` 9 项。
- **关联 Issue**：Ygwill/cyrene-agent#IKJK3V（T0 完成；T1 启动）。

## 2026-10-03 增量：T1 首件——exchange_rate 下沉 + ToolHost config 帧

- **ToolHost config 帧**：`{op:"config", timezone, dateLocale, dataDir}` 运行时注入
  （TS `NativeToolHost.setRuntimeSettings`；host 未启动存为启动配置）。
  `now` 工具每次调用实时下发时区——修复此前 `setTimezone` 是死接口、.NET `now`
  永远按 Asia/Shanghai 返回的双轨偏差。
- **exchange_rate（.NET）**：frankfurter.app 免 key HTTP + 30 分钟 TTL 缓存，
  日期展示走 config 帧的 timezone/dateLocale；网络异常抛错误帧 → TS 包装层回退原实现。
  接线在 `life-tools.ts`（调用前实时下发 locale/时区）。
- **bootstrap**：启动时注入 `dataDir`（userData）+ `dateLocale`，为宿主侧落盘工具（expense 等）铺路。
## 2026-10-03 增量：T1 续——expense 三件下沉（record/query）

- **record_expense / query_expense（.NET）**：本地 JSON 账本 `{dataDir}/expenses.json`
  （dataDir 随 config 帧注入，bootstrap 已接）；record 正数校验 + 追加，query
  天数/分类过滤、汇总 `toFixed(2)` 与分类键序、明细按 config 时区+locale 格式化。
  dataDir 未注入 / IO 异常 → 错误帧 → TS 包装层回退。
- **口径对齐助手**：新增 `HostLocale.cs`（`Fmt` / `FormatDate` / `FormatDateTimeLocal` /
  `Truthy`），exchange_rate 一并改用，JS 数字/日期输出逐字对齐有唯一来源。
- **验证**：`dotnet-tools-matrix.py` 28/28（+6 expense 断言，含账本 JSON 校验）；
  `dual-track-diff` life 段扩为 exchange 1 + expense 6（record/query 输出逐字 +
  账本结构），TS 基线经 `scripts/dual-track-env.ts` 注入隔离 userData。
- **关联 Issue**：Ygwill/cyrene-agent#IKJK3V（T1 进行中）。

## 2026-10-03 增量：密钥保存下沉 .NET（A20，分阶段）

- **决策**：密钥等敏感信息分阶段迁移 .NET 保存处理。**Phase 1** 在 `cyrene-native` 新增
  DPAPI（CurrentUser）统一密钥库宿主，模型 / 视觉 / TTS / ASR 密钥全部迁入；TS 仅在组装
  请求时经本地帧协议取用，不再持久化明文；渲染进程只拿掩码。**Phase 2**（LLM 请求处理
  是否下沉）待 Issue 讨论后另定。
- **B1 过渡**：铁律「密钥不落 .NET」在切换完成前仍然有效；`handover.md` / `dotnet-backend.md` /
  `multi-agent-architecture.md` / `plan-b` 设计稿均已加「拟迁移」标注。
- **设计文档**：`docs/design/2026-10-03-secrets-migration-to-dotnet.md`（现状盘点、宿主协议、
  迁移清痕、失败回退、验收用例与开放问题）；Phase 2 细化方案见
  `docs/design/2026-10-03-llm-service-dotnet-job-polling.md`（.NET 厂商服务 + TS 轮询）；
  关联 Issue：Ygwill/cyrene-agent#IKJLB2。
- **实施状态**：本批仅文档与决策，未开工。
