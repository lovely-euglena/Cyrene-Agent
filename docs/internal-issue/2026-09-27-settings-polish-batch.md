# 设置体验修复批（插件横幅 / 子项卡片化 / MCP 弹窗 / 记忆输入框 / 本地 ASR）

> 日期：2026-09-27 · 范围：原生设置窗 + 插件管理窗 + 本地 ASR 链路
> 关联：`2026-09-26-voice-sections-native-migration.md`（本地档位口径修订）、
> `2026-09-26-plugin-market-load-and-search-fix.md`

## 0. 问题 → 处理

| # | 用户反馈 | 处理 |
|---|---|---|
| 1 | 插件管理窗「启动插件运行时」横幅在已安装/市场两处应不一样 | 市场页改为**专属空态卡片**（🛒 标题「插件市场需要插件运行时」+ 说明 + 主按钮「启用插件运行时并加载市场」）；已安装页保留琥珀提示条（「插件存在但没在跑」+「启用并恢复插件」） |
| 2 | 设置页每个项目的每个子项目要卡片样式 | 新增 `BlockMark()` + `CardifySubBlocks()`：按子块标记把内容包成白底圆角卡；已应用于 通用 / 偏好 / 外观 / 记忆 / Token / 昔涟 / 关于（插件、TTS、ASR、免责声明、定时任务、用户、API 原本已是卡片或整体卡） |
| 3 | 添加 MCP Server 窗口透明且排版不佳 | 新增 `NativeTheme.ApplyDialogShell()`（标题栏 + 内容 + 圆角/阴影）；`McpAddDialog` 与 `FullAccessConfirmDialog` 迁移（此前只设 `Content=root` → 无背景层整体透明）；MCP 弹窗补齐字段说明、宽度 480/240、按钮右对齐 |
| 4 | 记忆子项目输入框有些太小 | L2 搜索框从固定 260 改为**整行宽**（Grid star 列，对齐旧版 `.memory-search input width:100%`）；L0/L1 字段本就整宽（随卡片化继续保持） |
| 5 | 本地 ASR 无法启用 | 三处修复：WPF 档位解除禁用（「本地（插件）」）+ 本地配置卡（说明 + 运行中 speech-input 插件状态）；宿主 `asrEngine=local` 现在返回 `{engine:"local"}`（原返回 null → 通话直接报「ASR 未配置」）；`startCall()` 本地模式下**允许通话启动**（不起内置流、等插件租约接管），通话窗状态文案「等待本地语音输入插件…」 |

## 1. 本地 ASR 链路（问题 5 的完整口径）

- 语义：本地识别由**语音输入插件**提供（`speech-input` 租约，模型/麦克风/窗口全在插件侧）；
  Cyrene 只接收最终文本。原型见 `skills/cyrene-plugin-dev/references/api-spec.md`。
- `asr-config.ts`：`AsrConfig` 增加 `{ engine: "local" }`；`createAsrStream` 对 local 显式抛错
  （内置流不适用，防御性）。
- `bootstrap-config.ts`：`asrEngine === "local"` → 返回 `{ engine: "local" }`（此前落到 `null`）。
- `call-manager.ts`：
  - `startCall()`：local 视为已配置（不校验凭据），**不启动内置 ASR**，直接 LISTENING；
    插件通过 `claimExternalSpeechInput()` 接管，释放后回到等待状态（不重启内置流）。
  - `restartAsr()`：local 不重启内置流；`endTurn()`：无内置流时忽略内置 VAD 结束信号。
- 通话窗（`renderer/call`）：读 `asrEngine`，local 时 LISTENING 文案为「等待本地语音输入插件…」。
- 设置快照：`asr.localPlugins`（运行中且声明 `speech-input` 依赖的插件名，来自
  `PluginListEntry.deps`）；WPF 本地配置卡显示「已检测到运行中的语音输入插件」或引导到插件市场。
- ASR 写入白名单本就允许 `local`（`sanitizeNativeAsrSave` 未变）。

## 2. 不变量（后续改动必须保持）

1. 无边框对话框必须走 `NativeTheme.ApplyDialogShell`（或等价的背景层），不得只设
   `Content = root`（会整体透明）。
2. 设置页子块卡片化用 `BlockMark()` + `CardifySubBlocks()`：标记之间成组；面板标题/状态行
   等前导元素保持裸放；已卡片的 section（插件/TTS/ASR/免责/任务/用户/API）不得重复包裹。
3. 插件管理窗运行时横幅：已安装页 = 提示条（插件没在跑）；市场页 = 专属空态（市场取不到数据），
   两者文案与视觉必须不同。
4. 本地 ASR：`startCall` 不得因 local 报「ASR 未配置」；内置 ASR 在 local 下必须保持关闭，
   输入权完全由插件租约接管；释放后不得自动启动内置流。
5. 记忆 L2 搜索框必须整行宽（旧版 `.memory-search input width:100%`）；字段输入框随卡片保持整宽。

## 3. 验证

- 单测：`call-manager` 新增「本地 ASR 启动/接管/不重启内置流」用例；`asr-dispatcher`
  新增 local 抛错用例；`native-settings-sections` 新增 `localPlugins` 投影（含防外部数组污染）；
  `plugins/manager` 全量通过（`deps` 透出）。
- 离屏渲染（临时钩子，验后已移除）：通用 / 偏好 / 外观 / 记忆 / Token / 昔涟 / 关于
  卡片化后布局正确；记忆 L2 搜索整行宽。
- `dotnet build -c Release` / `tsc -p tsconfig.main.json` 0 错。

## 4. 遗留（有意）

- API 设置保持单张大卡（档案列表 / 表单 / 视觉模型为同一表单流，拆卡会打断编辑动线）。
- 用户信息保持整卡；定时任务列表项本就是卡片。
- 本地 ASR 的插件生态（真实识别插件、模型分发）不入核心包，由插件仓库维护。
