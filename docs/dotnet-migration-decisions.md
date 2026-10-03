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

## 2026-10-03 增量：T1 续——search_text 下沉（Glob/Grep 别名共用）

- **search_text（.NET）**：工作区文本/正则搜索全量对齐 TS——忽略目录/扩展名清单、
  1MB 文件上限、单行 500 字符、匹配上限 100、上下文上限 5、路径逃逸拒绝、
  message / rejectedPaths / skippedDirs 输出；regex 用 `ECMAScript` 选项贴近 JS；
  无效正则按无匹配处理。工作区根由 TS 包装器经内部参数 `__cyreneWorkspaceRoot`
  注入（模型不可见）；zcode 的 Glob/Grep 别名随底层工具一并走 .NET。
- **验证**：`search-text-native.test.ts` 3 项；`dual-track-diff` search 段 5 组
  （literal/regex/glob/未命中/逃逸）；`dotnet-tools-matrix.py` 32/32。
- **关联 Issue**：Ygwill/cyrene-agent#IKJK3V（T1 进行中）。

## 2026-10-03 增量：T1 续——str_replace 下沉（两段式保 review 时序）

- **str_replace（.NET）**：三层匹配全量移植（精确 → EOL 归一化 → 空白归一化 + 缩进
  对齐），批量 edits 原子性、not_found / multiple_matches 诊断（nearestMatch 相似度与
  上下文）逐字对齐；evidence/diff 走 ToolEvidence。
- **两段式协议（保副作用时序）**：`__dryRun=true` 只匹配返回 `{success,prepared}`；
  TS 包装器预检成功后才 `captureBefore`，再发正式调用落盘。失败无任何副作用，
  review 基线时序与 TS 完全一致；host 故障整体回退 TS。
- **验证**：`str-replace-native.test.ts` 3 项；`dual-track-diff` srepl 段 7 组
  （含诊断与 CRLF）；`dotnet-tools-matrix.py` 35/35。
- **关联 Issue**：Ygwill/cyrene-agent#IKJK3V（T1 进行中）。

## 2026-10-03 增量：T1 续——download_file 下沉

- **download_file（.NET）**：输出根由 TS 包装器经内部参数 `__cyreneRoot` 注入；
  危险字符 / 目录穿越 / 危险后缀黑名单 / 64MiB 上限 / 30s 空闲超时 / Content-Type
  补扩展名 / 先缓冲后一次性落盘，全部与 TS 同口径；失败文案字符串逐字对齐。
- **验证**：`download-file-native.test.ts` 3 项；`dual-track-diff` download 段 5 组
  （本地 HTTP 服务：显式 filename/补扩展名/404/黑名单/未知类型，落盘字节级对比）。
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

## 2026-10-03 增量：PR #1 审查修复（按件超时 + Number 语义）

- **背景**：Gitee AI 队友「PR 审查助手」对 PR #1 给出 1 阻断 + 2 改进；
  经代码核实全部成立，逐条修复（bot 意见与修复一一对应）。
- **按件超时（阻断）**：`nativeFirst` 增加 `NativeFirstOptions.timeoutMs`
  （默认仍 5s）；`download_file` 传 10min（覆盖 64MiB 慢链路，约 1Mbps 需
  9 分钟）、`exchange_rate` 传 65s（C# HttpClient 60s + 余量）。此前默认
  5s 看门狗会把长任务的 native 轨误杀并强杀 host（在途调用一并拒绝），
  native 轨形同虚设。C# `DownloadFileTool` 另补首包（连接/响应头）30s
  空闲约束——`HttpClient.Timeout=Infinite`，握手阶段不得无限挂起。
- **Number 语义（改进）**：`HostLocale.Num` 统一 JS `Number(value)` 近似
  （字符串数字可解析、失败 NaN、true/false/null → 1/0/0）；`ExchangeRateTool
  .amount` / `ExpenseTools.amount|days` 接入，消除「模型把数字写成字符串」
  时的双轨分叉。
- **str_replace 设计注释（改进）**：两段式正式提交段不做 failure payload
  检查是有意为之（TOCTOU 失败透传模型 > 静默回退重跑），已在
  `life-tools.ts` 补注释说明。
- **测试盲区**：dual-track 直连 smoke-host，覆盖不到 `NativeToolHost` 客户端
  层——新增 `native-tool-host.test.ts` 直接校验按件超时/正常返回/默认 5s。
- **验证**：`dotnet-tools-matrix.py` 38/38；`dual-track-diff.ts` 全绿
  （expense +3 用例）；`vitest src/main/orchestrator/tools` 430 passed。

## 2026-10-03 增量：T1 续——apply_patch 下沉（Codex 补丁事务 + 两段式）

- **apply_patch（.NET）**：Codex 补丁格式（Update/Move/Add/Delete + @@ 分块），
  解析/匹配/事务预检/落盘/evidence 全部与 apply-patch-tools.ts 逐字对齐；
  预验证事务（路径沙箱、存在性、全量匹配）任一失败全部不执行；保留原文件
  EOL，按 \r?\n 拆行；`__dryRun` 两段式供 TS 捕获 review 基线（含 recordRename），
  预检失败对象原样透传。
- **接线**：`apply-patch-tools.ts` 增加 executeApplyPatchNativeFirst；参数/工作区
  前置校验留在 TS，host 故障整体回退 executeApplyPatchTs。
- **顺带修复**：native-windows（WPF 工程）隐式 using 不含 System.IO/System.Net.Http，
  T0/T1 新增文件此前只在 smoke-host 下编译通过——补显式 using 后
  CyreneNative.csproj 0 错误（"冒烟壳掩盖真编译问题"的教训，后续新增文件
  须跑一次 native-windows 全量编译）。
- **验证**：`dotnet-tools-matrix.py` 51/51（+13：dry-run/Move/事务/逃逸/证据行序）；
  `dual-track-diff.ts` apply_patch 段 9 组（相对路径补丁，输出逐字 + 镜像落盘快照）；
  `apply-patch-native.test.ts` 4 项。
- **关联 Issue**：Ygwill/cyrene-agent#IKJK3V（T1 进行中）。

## 2026-10-03 增量：PR #1 复审修复（SearchTools NumOr + fs 超时接口）

- **阻断项**：`SearchTools.NumOr` 复用 `HostLocale.Num`（字符串数字可解析、失败
  NaN、true/false/null → 1/0/0），消除 search_text 数值参数（contextLines /
  maxMatches）与 JS `Number()` 的双轨分叉。
- **改进项**：`nativeFirstFs` / `wrapFsForNativeHost` 支持 `NativeFirstOptions.timeoutMs`
  透传（fs 三件入参有界，调用点保持默认 5s；接口与 nativeFirst 对齐）。
- **改进项**：`DownloadFileTool` 类头注明同步阻塞对 ToolHost 单线程帧处理的影响；
  dual-track exchange_rate SKIP 分支打印双侧错误文本（防"假一致"漏诊）。
- **验证**：`dotnet-tools-matrix.py` 52/52；`dual-track-diff.ts` 全绿（search +1）；
  `vitest src/main/orchestrator/tools` 434 passed；`tsc` 0 错误。

## 2026-10-03 增量：PR #1 影响分析修复（黑名单扩展 + 超时连带日志 + 边界加固）

- **背景**：Gitee AI 队友 `/impact` 详细影响分析（PR #1）：1 条执行级安全建议、
  若干可观测性/边界建议；核实后按如下范围修复（未全盘照搬）。
- **下载黑名单扩展（安全）**：TS/C# 两侧同步补 `.vbe/.js/.jse/.wsf/.wsh/.hta/
  .cpl/.pif`（Windows 双击即执行 / 脚本宿主类扩展名），文案与判定逐字一致；
  dual-track +2 用例、matrix +3 用例（均在联网前拒绝）。
- **超时连带影响可观测性**：`NativeToolHost` 在超时 kill 与 host 退出时记录被
  连带拒绝的 `callId(tool)` 列表；per-call 隔离属于架构演进项（影响分析"重要"），
  本轮先以日志兜底，后续单独评估。
- **边界加固**：`SearchTools.MatchesGlob` 的 `**` 占位符改 NUL 哨兵（输入先剔除
  NUL，杜绝伪造展开）；`HostLocale.Fmt` 注明适用域（0.0001～1e17 与 JS 一致，
  范围外 E 记法风格不同）；str_replace 空文件播种补 matrix/dual-track 用例。
- **暂缓（已立项登记）**：超时级联与 per-call 隔离 → #IKJLP2；C# xUnit 独立回归
  测试 → #IKJLP3；内部参数改 protocol 字段 → #IKJLP4。dual-track 的
  `Module._load` 兼容性演进与 exchange_rate 超时命中率观察不单独立项。
- **验证**：matrix 56/56；dual-track 全绿（srepl 8 / download 7）；
  `vitest src/main/orchestrator/tools` 435 passed；tsc 0 错误。

## 2026-10-03 增量：PR #1 复审阻断修复（取消链路 + 串行闸门）

- **阻断 1（取消语义）**：`NativeToolHost.call` 增加 `signal` 参数——排队中直接
  摘除；在途立即杀 host 中止（download 先缓冲后一次性落盘，杀进程保证取消后
  不落盘），以 AbortError 拒绝。全链路透传 `ctx.signal`（fs 三件/写、expense、
  exchange、search_text、download、calculator/now/clipboard、
  str_replace/apply_patch 两段式）；`nativeFirst` 与各包装层遇 AbortError
  原样上抛，绝不回退 TS 重跑。search_text 旧「已取消返回空结果」测试按新契约
  改为 AbortError。
- **阻断 2（队头阻塞 + 看门狗误杀）**：`NativeToolHost` 增加串行闸门——同一
  时刻只写一个 call 帧，看门狗从实际派发起算；排队调用暂存 TS 侧、不触达
  stdin，长任务在途时不再发生短调用看门狗误杀 host 的级联。`ensureStarted`
  启动期统一等同一 barrier（修复后进先出）；超时/取消/退出日志列在途+排队清单。
- **改进（开关一致性）**：`nativeFirst` 入口统一 `CYRENE_TOOL_HOST` 短路，
  裸接线工具（exchange/expense/search/download/calculator 等）同样零触达。
- **保留未做**：下载回退"重复下载"幂等短路（影响分析改进项）——缓冲式落盘下
  重复写内容一致、仅浪费带宽，纳入后续观察；#IKJLP2 的 per-call 隔离已由
  串行闸门 + 取消杀进程覆盖主要场景。
- **验证**：`vitest src/main/orchestrator/tools` 441 passed；tsc 0 错误；
  dual-track 全绿；native-tool-host.test 7 项（串行/两类取消/默认看门狗）。
- **第 4 轮复审（无阻断，2 条可选优化）**：`FsTools.WriteFile` 双重
  `TryGetProperty("content")` 合并为单个判断块（本批）；只读工具「轻量取消」
  （不杀 host、仅摘除 pending）需引入「已放弃在途」状态与兜底计时器，否则串行
  闸门下新调用会被旧调用看门狗误杀——列为 #IKJLP2 后续（当前杀进程语义安全，
  代价仅一次主机重启）。
