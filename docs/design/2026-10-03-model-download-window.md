# 模型一键下载（独立 .NET 窗口）设计

> 状态：已实现（2026-10-03；`cyrene-native --selftest model-download` 14/14）。
> 用户文档见 [docs/local-models.md](../local-models.md)。

## 1. 背景与目标

本地检索（RAG / 贴纸语义 / Worldbook 召回）依赖 BGE-M3（必装）与
bge-reranker-base（可选）。此前只有两条安装路径：手动放置文件
（`docs/local-models.md`）或仓库脚本（`scripts/install-bge-*.ps1`）；设置页只提供
「安装说明 / 打开下载站」。

目标：应用内一键下载 + 进度可见 + 可取消 + 断点续传，且**落点与运行链路探测一致**
（项目模型目录，而不是 HuggingFace 缓存——旧的 transformers.js 缓存路径会造成
「设置页显示已装、检索却加载不到」）。

## 2. 形态决策

- **独立 .NET（WPF）窗口**（`kind="model-download"`），不嵌入设置页：
  文件体量大（约 570MB / 279MB）、耗时长，需要持续进度、取消与重试；独立窗口可
  重复打开、不打断设置页交互（用户拍板此形态）。
- **下载核心用 C#（HttpClient）**：cyrene-native 侧车本就常驻，不新增进程/运行时；
  避免 TS 侧再维护一套下载实现。
- 入口沿用既有 `cyreneModelAction` 词汇：新增动作 `open-model-downloader`，
  React（聊天窗设置）与 WPF（昔涟设置）两个设置页各放一枚「下载模型」按钮。

## 3. 架构与数据流

```
React 设置页（聊天窗内）              WPF 设置窗（cyrene 段）
  cyreneModelAction(verb)              RequestRouter.SendSettingsAction("cyrene", verb)
        │                                      │
        └──────────────┬───────────────────────┘
                       ▼
            宿主 runCyreneModelAction("open-model-downloader")
                       ▼
        spawnNativeWindow("model-download", { modelsDir, mirror })
                       ▼
   cyrene-native RequestRouter → ModelDownloadWindow（kind="model-download"）
                       ▼
               ModelDownloader（C#，官方源 / hf-mirror）
```

- `modelsDir` 由宿主 `getProjectModelsDir()` 传入（与设置页状态同一口径）；
  `mirror` 取 `general.ragDownloadMirror`，窗口内切换即写回同键。
- 窗口内「打开模型目录」「完成后刷新」复用既有 `open-model-dir` /
  `check-model-update` 动作；下载完成后宿主重推设置快照，设置页状态自动同步。
- 协议白名单 `NATIVE_SECTION_ACTIONS.cyrene` 增 `open-model-downloader`（契约测试
  同步）；窗口类型联合（`spawnWindow` / `isNativeWindowActive`）增 `model-download`，
  spawn 即显（与 music 窗口同策略）。

## 4. 下载行为规格

- 文件清单/镜像口径对齐 `scripts/install-bge-*.ps1`：
  - BGE-M3 → `<模型目录>/Xenova/bge-m3/`；reranker → `<模型目录>/bge-reranker-base/`；
  - 必装三件套：`onnx/model_quantized.onnx`（≥50MB）、`tokenizer.json`（≥1MB）、
    `config.json`；可选：`tokenizer_config.json`、`special_tokens_map.json`、
    `sentencepiece.bpe.model`（缺失仅记入 Skipped）。
- 探测：HEAD 优先，失败退 `Range: 0-0` 拿总长；404/403 视为缺文件。
- 续传：`.part` + HTTP `Range`；服务器返回 200（忽略 Range）时自动从头重下、不拼接；
  文件达到 MinBytes 后原子改名（覆盖旧文件）。
- 已完整文件直接跳过（规划期不发请求）；取消（CancellationToken）保留 `.part`，
  重开可续传；进度节流 250ms，窗口经 Dispatcher 回 UI 线程。
- `IsInstalled` 只认三个必装文件 + 大小阈值（与 TS 侧 `model-status` 同口径）。

## 5. 验证与遗留

- 自检：`cyrene-native --selftest model-download`（假网络覆盖全量/跳过/续传/忽略
  Range/必装缺失/可选缺失/镜像切换/取消/IsInstalled），14/14 绿。
- 编译：CyreneNative（Debug）0 错误；TS `tsc main/renderer` 干净；
  `native-settings-protocol.test.ts`（白名单契约）通过；
  `settings-in-chat-smoke.mjs` 的 cyrene 段断言补「下载模型」。
- 遗留：真机网络冒烟（官方源 + hf-mirror 大文件完整链路）随下次打包验证；
  旧 Electron 设置页（legacy fallback）未接线——该路径缺 .NET 组件时本窗不可用，
  仍走手动安装说明。

## 6. 文件地图

- 核心/自检：`dotnet/native-windows/ModelDownload/{ModelDownloader,ModelDownloadSelfTest}.cs`
- 窗口/路由：`dotnet/native-windows/{ModelDownloadWindow,RequestRouter}.cs`
- 宿主接线：`src/main/application/default-dependencies.ts`（`open-model-downloader`）
- 协议/类型：`src/main/windows/{native-settings-protocol,native-windows-bridge,native-windows-host}.ts`、
  `src/preload/index.ts`、`src/renderer/global.d.ts`
- 入口 UI：`src/renderer/react/features/settings/CyreneSettingsPanel.tsx`、
  `dotnet/native-windows/SettingsWindow.Cyrene.cs`、三语 i18n
