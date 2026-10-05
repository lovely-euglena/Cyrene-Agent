# 记忆 / RAG 第二引擎（e5-small + bge-reranker-v2-m3）设计

> 状态：已实现（2026-10-05，IKIH28）。主进程链路（模型注册表 / 路径探测 / sidecar 路由 /
> 设置类型 / 索引迁移）与 C# sidecar 多引擎池由同事完成；本文档记录 UI 接线、
> 下载/安装与协议口径，并列出已知差异。
> 用户文档见 [docs/local-models.md](../local-models.md)。

## 1. 背景与目标

第一引擎只有单一本地嵌入模型 BGE-M3（1024 维）与单档重排序 bge-reranker-base。
低配设备上 570MB 的 BGE-M3 下载/常驻成本高，且重排缺少更强档位。第二引擎引入：

- **Multilingual-E5-Small**（384 维，约 120MB）：轻量多语言嵌入，可作为 BGE-M3 的替代；
- **bge-reranker-v2-m3**（约 570MB）：多语言重排序增强档。

目标：用户可见面完整——两个设置页（React 聊天窗设置 / WPF「昔涟设置」）可选模型与档位、
模型下载窗四张卡、安装脚本与文档齐备；切换嵌入模型时**不再静默清空旧向量**。

## 2. 模型与注册表口径

| 模型键 | 展示名 | 维度 | 体积（约） | 源仓库 | 落点（项目模型目录） |
|---|---|---|---|---|---|
| `bgem3` | BGE-M3 | 1024 | 570MB | `Xenova/bge-m3` | `Xenova/bge-m3/` |
| `e5-small` | Multilingual-E5-Small | 384 | 120MB | `Xenova/multilingual-e5-small` | `Xenova/multilingual-e5-small/` |
| `standard` | bge-reranker-base | — | 279MB | `Xenova/bge-reranker-base` | `bge-reranker-base/` |
| `v2-m3` | bge-reranker-v2-m3 | — | 570MB | `onnx-community/bge-reranker-v2-m3-ONNX` | `bge-reranker-v2-m3/` |

- 注册表：`src/main/rag/embedding-pipeline.ts`（`LOCAL_MODELS`）+ `embedding-model-registry.test.ts` 锁定；
- 路径探测：`src/main/rag/model-status.ts`（embedding 用 canonical `Xenova/` 布局，
  reranker 用 bare 布局；v2-m3 源为 `onnx-community/*`，无 `Xenova/` HF 缓存兜底）；
- 设置类型：`EmbeddingModelKey = 'bgem3' | 'e5-small'`、
  `RerankerMode = 'standard' | 'v2-m3' | 'none'`（`src/main/settings/model-settings.ts`）；
- 必装文件（四模型同构）：`onnx/model_quantized.onnx`（≥50MB）、`tokenizer.json`（≥1MB）、
  `config.json`（≥10B）；可选：`tokenizer_config.json`、`special_tokens_map.json`、
  `sentencepiece.bpe.model`。大小达标由下载窗 / 脚本保证（与 `ModelDownloadSpecs`
  同口径）；TS 设置页探测只按文件是否齐全判定，不校验大小（截断文件由下载器/脚本拦截）。

## 3. 协议与数据流

### 3.1 切换 IPC

```
渲染设置页（React / 旧 settings 页）          WPF 设置窗
  settings.embeddingSetModel(model, action?)    cmd settings cyrene save
  settings.rerankerSetMode(mode)                { embeddingModel, embeddingModelAction? }
        │                                              │
        └───────────────┬──────────────────────────────┘
                        ▼
        switchEmbeddingModel(model, action)（src/main/rag/index.ts）
          - 无 action 且模型/维度变化 → { ok:false, reason:'rebuild-required', requires }
            （requires = 有数据 ? 'rebuild' : 'clear'；**不落盘、不动 provider**）
          - action='rebuild' → 备份 rag-data → 全量分批重嵌入 → 原地 upsert → IVF 重建 → meta 更新
          - action='clear'   → 显式清空（含 meta）→ 切 provider
        成功后：saveModelSettings({ embeddingModel }) + 广播 + 刷新贴纸索引
```

- 白名单：`native-settings-protocol.ts` 的 `sanitizeNativeCyreneSave` 放行
  `embeddingModel` / `embeddingModelAction`（`rebuild` / `clear`）；宿主
  `default-dependencies.ts` 的 `cyreneAction` 与 IPC 同口径调用 `switchEmbeddingModel`；
- WPF rebuild-required 回传：宿主 `nativeNotice("cyrene", "error", hint, { rebuildRequired,
  embeddingModel, requires })` → WPF `ApplyNotice` 弹 MessageBox（重建 / 清空 / 取消）→
  带 `embeddingModelAction` 重发 save；取消时 `RefreshSection` 撤销卡片乐观选中；
- Reranker：`RERANKER_SET_MODE` / cyrene save 写 `rerankerMode` 后重新 `initReranker(mode)`；
  所选档位未安装时由 reranker 模块自动降级 none（UI 状态按选中档位显示「未安装」）。

### 3.2 UI 接线

| 界面 | 位置 | 行为 |
|---|---|---|
| React 设置页 | `src/renderer/react/features/settings/CyreneSettingsPanel.tsx` | Embedding 双选（bgem3 / e5-small，显示各自安装状态）；Reranker 三档；rebuild-required 弹 antd 三键确认（重建 / 清空 / 取消）并带 action 重发；e5 选中时维度输入固定 384 禁用 |
| 旧设置页 | `src/renderer/settings/index.html` + `rag/panel.ts` | 两张 embedding 卡 + 三张 reranker 卡；rebuild-required 用既有 `showConfirm` 两步确认（重建 → 否则清空 → 否则回滚） |
| WPF 昔涟设置 | `dotnet/native-windows/SettingsWindow.Cyrene.cs` | Embedding 两张卡（选中态 + 各自安装状态 + 维度仅 bgem3 可编辑）；Reranker 三档卡；当前模式文案；rebuild-required MessageBox |
| 模型下载窗 | `dotnet/native-windows/ModelDownloadWindow.cs` | 四张卡（BGE-M3 必装 / E5-Small 可选 / bge-reranker-base 可选 / bge-reranker-v2-m3 可选），镜像切换与状态刷新沿用既有逻辑 |

设置快照（`buildCyreneSectionSnapshot`）新增四个模型的安装布尔
（`embeddingBgem3Installed` / `embeddingE5SmallInstalled` / `rerankerStandardInstalled` /
`rerankerV2M3Installed`），保留旧字段兼容。

### 3.3 下载与安装

- 下载窗（C# `ModelDownloader`）：四模型 spec 已冻结；v2-m3 从
  `onnx-community/bge-reranker-v2-m3-ONNX` 下载、落 `models/bge-reranker-v2-m3`；
- 仓库脚本：新增 `scripts/install-e5-small.ps1`、`scripts/install-bge-reranker-v2-m3.ps1`，
  共用 `scripts/lib/model-install-common.ps1`（HEAD 探测 / BITS 断点续传 / 大小校验），
  入口与既有脚本保持同参数（`-Mirror auto|hf-mirror|official`、`-Force`）。

## 4. 索引迁移（rebuild / clear）

- **默认拒绝**：`switchEmbeddingModel` 在模型或维度与索引 meta 不一致时返回
  `{ ok:false, reason:'rebuild-required', requires }`，不落盘、不切 provider；
- **rebuild**：先 `backupRagDataForRebuild`（sqlite `VACUUM INTO` / JSON 拷贝，
  保留最近 3 份）→ `store.reembedAll(newProvider)` 分批重嵌入 → upsert → IVF 重建 →
  `setIndexMetaForProvider`；
- **clear**：`store.clearAll()` + meta 重置；
- 旧数据兼容：无 meta 时按向量维度推断模型（1024 → bgem3）；
- 两个设置页与 WPF 均把 requires 呈现为「重建（保留记忆）/ 清空（不可恢复）/ 取消」。

## 5. 已知差异（后续优化）

1. **e5 的 `query:` / `passage:` 前缀未实现**：E5 系列官方建议检索侧加 `query: `、
   文档侧加 `passage: ` 前缀。当前管线未区分两端前缀，与 BGE-M3 走同一编码路径；
   不影响索引一致性（切换/重建前后同一编码），后续可作为编码层优化。
2. **transformers.js worker 回退对新模型未真机验证**：sidecar 多引擎池为主链路；
   transformers.js worker 回退路径对 e5-small / v2-m3 尚未在真实设备上验证。
3. **HF-cache-only 对 v2-m3 无兜底**：v2-m3 源仓库是 `onnx-community/*`，HF 缓存布局
   不在 `Xenova/` 下；只放 HF 缓存而不放项目 `models/bge-reranker-v2-m3/` 时探测不到。
4. **rebuild 无进度信道、暂不支持取消**：`EmbeddingSwitchOptions.onProgress` /
   `isCancelled` 已预留，但 IPC / native 通道未透出进度、也未接入取消入口
   （生产调用方均不传 options）；重建期间 UI 只显示 loading 文案（「正在重建索引…」）。
   主进程侧已做提交前取消检查（`reembedAll` 落盘前再查一次 `isCancelled`），
   后续接入 UI 时无需再改迁移核心。
5. **旧 sidecar（无池）doc-import 的路由确认**：旧 exe 忽略请求 `modelDir` 且
   doc-import 响应无 `dim`/`modelKey`，客户端在发送前按 ready 维度/启动参数确认；
   无法确认时先回退重启一次，重启后仍无法确认则失败（不写入错误维度向量）。
   新 exe 的 doc-import 响应回显 `modelKey`/`dim`，与 embed/search 同口径断言。
