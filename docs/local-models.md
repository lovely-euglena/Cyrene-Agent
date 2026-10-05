# 本地向量模型安装说明（BGE-M3 / Multilingual-E5-Small / bge-reranker-base / bge-reranker-v2-m3）

> **应用内一键下载（推荐）**：设置 →「昔涟设置」→ 模型操作 →「⬇ 下载模型」
> （聊天窗设置页的「本地检索」卡片同按钮）；支持官方源 / hf-mirror、断点续传与取消。
> 本文档同时保留**手动安装**步骤与仓库脚本（适合离线环境或自行管理文件）。

## 0. 模型一览（第二引擎 IKIH28）

| 模型 | 用途 | 维度 | 体积（约） | 必装 | 落点 |
|---|---|---|---|---|---|
| BGE-M3 | 嵌入 / 检索主模型（默认） | 1024 | 570MB | 是 | `models/Xenova/bge-m3/` |
| Multilingual-E5-Small | 轻量多语言嵌入（可选引擎） | 384 | 120MB | 否 | `models/Xenova/multilingual-e5-small/` |
| bge-reranker-base | 重排序（默认档） | — | 279MB | 否 | `models/bge-reranker-base/` |
| bge-reranker-v2-m3 | 多语言重排序（增强档） | — | 570MB | 否 | `models/bge-reranker-v2-m3/` |

- 嵌入模型二选一（设置 →「昔涟设置」→ Embedding 模型卡）：切换模型会触发索引迁移
  （重建 = 备份后全量重嵌入并保留记忆；清空 = 删除旧向量记忆），详见应用内确认弹窗。
- 重排序三档（standard / v2-m3 / 关闭）：未安装所选档位时自动按关闭处理，不影响基础检索。
- v2-m3 的 ONNX 源在 `onnx-community/bge-reranker-v2-m3-ONNX`（Xenova 没有 v2-m3 的 ONNX 仓库）。

## 1. 选择下载源

设置页「下载镜像源」二选一（应用内下载窗内也可切换）：

| 镜像源 | 地址 | 说明 |
|---|---|---|
| 官方源 | https://huggingface.co | 需要能直连 HuggingFace |
| hf-mirror | https://hf-mirror.com | 国内网络建议使用 |

各模型的源仓库：

| 模型 | 官方源仓库 | hf-mirror |
|---|---|---|
| BGE-M3 | `Xenova/bge-m3` | https://hf-mirror.com/Xenova/bge-m3 |
| Multilingual-E5-Small | `Xenova/multilingual-e5-small` | https://hf-mirror.com/Xenova/multilingual-e5-small |
| bge-reranker-base | `Xenova/bge-reranker-base` | https://hf-mirror.com/Xenova/bge-reranker-base |
| bge-reranker-v2-m3 | `onnx-community/bge-reranker-v2-m3-ONNX` | https://hf-mirror.com/onnx-community/bge-reranker-v2-m3-ONNX |

## 2. 需要下载的文件

四个模型的文件结构相同（相对路径必须保持原样，`onnx/` 子目录与文件名都不要改）：

```
tokenizer.json
config.json
onnx/model_quantized.onnx
```

> 三个文件齐全且大小达标才会被判定为「已安装」；缺文件时设置页会列出缺少项。
> 建议一并下载 `tokenizer_config.json`、`special_tokens_map.json`、
> `sentencepiece.bpe.model`（transformers.js 兜底路径更稳，脚本与下载窗会自动带上）。
> 大小校验口径与 `dotnet/native-windows/ModelDownload/ModelDownloader.cs` 的
> `ModelDownloadSpecs`（onnx ≥ 50MB、tokenizer ≥ 1MB、config ≥ 10B）一致。

## 3. 放置目录

把模型的整个文件夹放到**模型目录**下（设置页「打开模型目录」可直接打开并自动创建）：

```
<模型目录>/
  Xenova/
    bge-m3/                          ← BGE-M3（注意在 Xenova 子目录下）
      tokenizer.json
      config.json
      onnx/model_quantized.onnx
    multilingual-e5-small/           ← E5-Small（同样在 Xenova 子目录下）
      tokenizer.json
      config.json
      onnx/model_quantized.onnx
  bge-reranker-base/                 ← 重排序（可选，不在 Xenova 下）
    tokenizer.json
    config.json
    onnx/model_quantized.onnx
  bge-reranker-v2-m3/                ← 重排序 v2（可选，不在 Xenova 下）
    tokenizer.json
    config.json
    onnx/model_quantized.onnx
```

模型目录按以下顺序探测（命中第一个「三个文件齐全」的目录即可）：

- **开发态**（`npm run dev`）：`CYRENE_MODELS_DIR` → 仓库根 `models/` →
  可执行文件同级 `models/` → 应用安装目录 `models/` → `resources/models/` → `resources/embed-models/`；
- **打包态**：`CYRENE_MODELS_DIR` → 可执行文件同级 `models/`（安装版/绿色版常用，
  即 `Cyrene.exe` 旁边的 `models/`）→ `resources/embed-models/` → `resources/models/` →
  应用安装目录 `models/` → 当前工作目录 `models/`。

`resources/embed-models` 是自定义内嵌构建的约定目录（`electron-builder.yml` 的
`extraResources` 映射；官方安装包不自带模型）；.NET embedding 侧车与设置页状态
使用同一套探测结果。

HF 缓存兜底：Windows 默认
`%LOCALAPPDATA%\live2d-cyrene\Cache\huggingface\Xenova\<模型名>\`
（便携模式或改过缓存目录时，把前缀换成实际缓存根即可）。
注意：v2-m3 的源仓库是 `onnx-community/*`，其 HF 缓存布局不在 `Xenova/` 下，**没有 HF 缓存兜底**，
必须使用应用内下载 / 脚本 / 手动放到项目 `models/bge-reranker-v2-m3/`。

## 4. 命令行安装（仓库用户，可选）

源码/仓库环境可直接用脚本下载（自动切源、支持断点续传、跳过已完整文件）：

```powershell
# BGE-M3 → models/Xenova/bge-m3/
powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-m3.ps1

# Multilingual-E5-Small → models/Xenova/multilingual-e5-small/
powershell -ExecutionPolicy Bypass -File .\scripts\install-e5-small.ps1

# 重排序模型（可选）→ models/bge-reranker-base/
powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-reranker.ps1

# 重排序 v2（可选）→ models/bge-reranker-v2-m3/
powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-reranker-v2-m3.ps1
```

- 默认源序：hf-mirror → 官方源（reranker-base 另带魔搭 ModelScope 兜底）；
  可用 `-Mirror hf-mirror|official`（reranker-base 还支持 `modelscope`）指定单一源，
  `-Force` 强制重新下载。
- 脚本会校验文件大小并输出结果；完成后回设置页点「刷新状态」。
- `install-e5-small.ps1` 与 `install-bge-reranker-v2-m3.ps1` 共用
  `scripts/lib/model-install-common.ps1` 的下载/校验函数。

## 5. 完成后刷新

回到 设置 → 昔涟设置 → RAG / 文档导入：

1. 手动安装后点「🔄 刷新状态」重新体检（应用内下载完成后会自动刷新）；
2. 对应模型卡显示「已下载」即安装成功；切换 Embedding 模型时按弹窗选择索引迁移方式；
3. 「删除模型」会同时删除项目 `models` 目录与 HF 缓存中的模型文件，需要重新安装。

## 常见问题

- **卡在「未下载」**：确认三个文件齐全、`onnx/model_quantized.onnx` 路径层级正确；
  E5-Small 放在 `Xenova/multilingual-e5-small/`，两个重排模型放在 `bge-reranker-base/`、
  `bge-reranker-v2-m3/`（不带 Xenova 前缀）。
- **下载很慢/超时**：在「下载模型」窗或设置页切到 `hf-mirror` 后重试（支持断点续传）；
  也可用 `scripts/install-*.ps1` 自动切源下载。
- **Rerank 显示「未安装，按关闭处理」**：属正常降级，不安装不影响基础检索。
- **切换 Embedding 模型提示需要迁移**：旧索引维度/模型与新模型不一致。选择「重建索引」
  会先备份记忆数据再全量重嵌入（保留记忆，耗时与记忆条数相关）；选择「清空索引」会删除
  旧向量记忆（不可恢复）。
