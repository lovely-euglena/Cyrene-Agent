# Cyrene-Agent .NET 后端交接文档

> 最后更新：2026-09-24 · 分支 `feature/dotnet-backend`（HEAD `565ce62f`）
> 前任维护者交接笔记——接手者从本文档出发可独立完成构建/测试/发版/排障全链路。

---

## 1. 这是什么

Electron + TypeScript 桌面 AI 伴侣（fork 自 Playa-0v0/Cyrene-Agent）。
本 fork 两条主线：

1. **七 host .NET 后端**（`dotnet/`）：把内置工具 / RAG / 记忆 / Agent 会话 / 对话循环 / MCP / 语音下沉到 `cyrene-native`（单 exe 多模式）+ `CyreneVoice.exe`（独立语音），stdio JSON 行协议，**双轨开关**可整体回退 TS 原路。
2. **性能线**：.NET 原生窗口（splash/侧栏/日程/设置）、分离托盘（~20MB 常驻）、流式 100ms 批量吐 token、聊天窗按需启动、Live2D 空闲降频、拖动抖动修复。

**已删除**：音乐播放器全功能（2026-09-07 用户拍板，素材保留；上游后续的音乐修复一律不采纳）。

## 2. 仓库布局

```
dotnet/
  native-windows/          # cyrene-native：七 host 单 exe
    Tools/  Rag/  MemoryStore/  Agents/  LoopHost/  Mcp/  voice→独立
    Program.cs             # --tool-host/--rag-host/--memory-host/
                           # --agent-host/--loop-host/--mcp-host/--selftest
  voice/CyreneVoice/       # 语音独立 exe（TTS 四引擎+Silero VAD 三模式）
  plugin-sdk/Cyrene.PluginSdk/  # .NET 插件 SDK（CyrenePluginBase）
  smoke-host/              # Linux 冒烟壳（同源编译协议类，排除 WinForms）
src/main/dotnet-backend/   # TS 侧：config.ts（双轨开关唯一解析）、
                           # host-clients.ts（LineHostClient IPC）、native-tool-host
src/plugins/               # 插件层（含 dotnet-adapter.ts：.NET 插件进程适配）
scripts/                   # 测试/发版脚本（见 §5）
release/                   # 打包产物（gitignore 外的工作区）
docs/dotnet-backend.md     # 后端总览（测试矩阵+安全加固节）
docs/dotnet-migration-decisions.md  # A1-A19 决策记录
docs/build-guide.md        # 构建/发版流程
```

## 3. 关键机制

### 双轨开关（P10）
`resolveDotnetConfig()`（`src/main/dotnet-backend/config.ts`）是**唯一解析入口**：
环境变量 > `./config/cyrene.conf` > 默认。C# 侧 `HostConfig.cs` 同规则。
开关关闭/exe 缺失/超时/崩溃 → 自动回退 TS 原路，无灰度直切。
开关项：`CYRENE_NATIVE_WINDOWS`（窗口）、`CYRENE_DETACHED_TRAY`、`CYRENE_TOOL_HOST`、`CYRENE_RAG_HOST`、`CYRENE_MEMORY_HOST`、`CYRENE_AGENT_HOST`、`CYRENE_MCP_HTTP`、`CYRENE_PORTABLE`、`CYRENE_VAD`。

### 铁律（P 阶段定死，动前必读）
- **B1 密钥不落 .NET**：vendor key 绑 TS 侧，llm_request 帧只含 messages/config
- **B2 审批在 Electron**：tool_request → setToolExecutor → checkPermission
- **B8 语音边界**：只动 synthesizeByEngine 引擎层，IPC/播放/状态机零改动
- **B9 VAD 隐私**：local/hybrid 仅语音段上云（asr-dispatcher 的 createVadGate）
- **B10 便携**：./data 单根，不写注册表/系统目录，卸载=删目录
- **closed-world 插件**：.NET 插件工具不声明 risk=拒注册（unknown 非 full 档全 deny）

### 帧协议（B5）
每 host C# 源文件头注释即规范。统一 `{"op":...,"callId":...,"ok":bool,"error","errorCode"}`；
`llm_response` 的 `ok` 缺省=成功；tool_result 兼容单对象/数组双形态。
已知坑：`Task.Run` fire-and-forget 处理帧会在 EOF 丢在途帧——必须同步顺序处理（已修，勿回退）。

## 4. 上游同步策略

- upstream：`https://gitee.com/playa0/cyrene-agent`（master）
- 流程：`git fetch upstream` → 建分支 `sync/<日期>` → merge → 解冲突 → tsc+vitest+.NET 七套全绿 → 并回 feature/dotnet-backend
- **音乐模块冲突一律保持删除**；上游对 scene-embedder 已整体移除（跟随）
- ASR 已按用户指令切**阿里云**引擎（保留我方 VAD 门控）
- 冲突高发区：`default-dependencies.ts`（核心装配，我方插件总开关/启动装配 vs 上游服务注入——两侧都要）、`rag/index.ts`（上游 flush/预热 vs 我方 E7 双轨 store）
- 上游节奏很快（154 提交/2 周），建议每 1-2 周同步一次

## 5. 测试矩阵（全部必须绿才能发版）

| 套件 | 命令 | 结果基线 |
|---|---|---|
| 冒烟 | `python3 scripts/dotnet-smoke-linux.py` | 24/24 |
| 边缘 | `python3 scripts/dotnet-edge-test.py` | 16/16 |
| 工具矩阵 | `python3 scripts/dotnet-tools-matrix.py` | 30/30 |
| Agent 循环 | `python3 scripts/dotnet-agent-loop-test.py` | 13/13 |
| IPC 压力 | `npx tsx scripts/ipc-stress-test.ts` | ALL PASS |
| 双轨 diff | `npx tsx scripts/dual-track-diff.ts` | 12/12 |
| 插件安全 | `npx tsx scripts/plugin-security-test.ts` | ALL PASS |
| node 单测 | `npx vitest run` | 4329 passed（7 失败=Linux 路径/上游 React 组件，Windows 过） |

前置：`export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH`（脚本已 env 自足）。
.NET 测试脚本跑 `dotnet/smoke-host`（Linux 冒烟壳）；Windows 实机用 `scripts/dotnet-smoke.ps1`。
**改 dotnet/ 下 C# 后必须**：`cd dotnet/smoke-host && dotnet build -c Release` 再跑七套。

## 6. 发版流程（test.N）

1. `dotnet publish -c Release -r win-x64 --self-contained false`（注意 jieba 词典 Resources 已在 csproj 配置拷贝）
2. `rsync -a --delete dotnet/native-windows/bin/Release/net10.0-windows/win-x64/publish/ release/win-unpacked/resources/native-windows/`
3. 压缩链（~50min）：`tar -cf - -C win-unpacked . | xz -6 -T1 - > Cyrene-Portable-<ver>-x64.tar.xz` → `xz -t` 验证 → `split -b 95m`（仅 Gitee）→ SHA256SUMS；**zip 版**（S3 用，顶层结构同 tar）
4. Gitee：建 release（prerelease）→ 传分卷+bat+SUMS → 下载回验 SHA256（test.4 传输损坏教训）
5. S3：`python3 scripts/upload-release-s3.py <file>`（需 `CYRENE_S3_AK/SK`；全量 tar.xz + zip，不分卷）
6. 一键脚本：`一键解压运行-<ver>.bat`（GBK 编码，sed 换版本号生成）

## 7. 已知坑（血泪）

- **属主坑**：root 建的文件 Edit 报 EACCES → `mv f /tmp/x && cp /tmp/x f`
- **C# raw string** 起始行不能带内容（CS8997）
- **Jieba.NET** 是老式 content 包：SDK 项目不自动拷 Resources——csproj 已配 `NuGetPackageRoot` 拷贝，新 csproj 抄 smoke-host 的写法
- **TS 侧 spawn**：数组 mode 的 argv[0] 是可执行本身，参数是 `mode.slice(1)`（曾双传炸过）
- **vitest 5**：`--reporter=basic` 没了，用默认
- **Electron 43**：无 `WindowStatePersistence` 类型（44 才有），create-aux-windows.ts 有垫片声明
- **cosine 相似度**：必须除双范数 dot/(|q||e|)（曾漏除 entry 范数）
- **jieba**：检索用 `CutForSearch`（精确模式整词导致查询失配）；标点过滤不进倒排
- Windows 侧 Gitee token 有时效，失效重新生成（账号 Ygwill2022）

## 8. 未竟事项（下任优先级）

1. **Windows 实机冒烟**：`scripts/dotnet-smoke.ps1` 从未在真 Windows 跑过——这是双轨开关打开前的最后一道闸
2. **7 个 Linux 环境测试失败**：screenshot×3（写死 `C:\shots` 路径，`pathToFileURL` Linux 语义差异）+ 上游 React 组件×4——需要路径参数化或标记 win-only
3. **electron 44 升级**：上游已用 `WindowStatePersistence`，本地垫片可删
4. **S3 test.6 zip 未传**：凭据过期，待用户提供 AK/SK 后 `upload-release-s3.py` 传 tar.xz+zip
5. **B7 CI**：GitHub Actions 已有（上游拆 9 目录步骤），但我们的 .NET 七套未进 CI——建议加 Linux job 跑 smoke-host
6. **loop-host 实机**：逐 token 一致性未过前禁开（🔴 上游契约标注）

## 9. 联系与上下文

- 用户：ygwill（Gitee），沟通极简直接，"骨架≠完成"，完成必被追问真实度
- 汇报节奏由用户控制："做完先汇报，不慌编译产物"
- 本文档对应的完整决策链：`docs/dotnet-migration-decisions.md`（A1-A19）+ `AGENTS.md`/`SOUL.md`（workspace）
