# 本地向量模型安装说明（BGE-M3 / bge-reranker-base）

> **应用内一键下载（推荐）**：设置 →「昔涟设置」→ 模型操作 →「⬇ 下载模型」
> （聊天窗设置页的「本地检索」卡片同按钮）；支持官方源 / hf-mirror、断点续传与取消。
> 本文档同时保留**手动安装**步骤与仓库脚本（适合离线环境或自行管理文件）。

## 应用内一键下载（推荐）

- 入口：设置 →「昔涟设置」→「模型操作」→「⬇ 下载模型」（聊天窗设置页：昔涟 → 本地检索 →「下载模型」）；
- 支持官方源 / hf-mirror 切换、断点续传（中断后重开继续）与下载中取消；
- 文件直接落到当前生效的模型目录（探测顺序见下文「放置目录」），完成后设置页状态自动刷新；
- BGE-M3 与 bge-reranker-base 分开下载：前者必装，后者可选（开启 Rerank 时建议安装）。

下载失败或较慢时，切换镜像源后重试即可（已下载部分会复用）。以下为手动安装方式。

## 1. 选择下载源

设置页「下载镜像源」二选一（应用内下载窗内也可切换）：

| 镜像源 | 地址 | 说明 |
|---|---|---|
| 官方源 | https://huggingface.co/Xenova/bge-m3 | 需要能直连 HuggingFace |
| hf-mirror | https://hf-mirror.com/Xenova/bge-m3 | 国内网络建议使用 |

重排序模型（可选，Rerank 开启时需要）：`Xenova/bge-reranker-base`。

## 2. 需要下载的文件

BGE-M3（约 570MB，实际取决于量化文件版本）：

```
tokenizer.json
config.json
onnx/model_quantized.onnx
```

bge-reranker-base（约 279MB，可选）：

```
tokenizer.json
config.json
onnx/model_quantized.onnx
```

> 相对路径必须保持原样：`onnx/` 子目录与文件名都不要改。
> 三个文件齐全才会被判定为「已安装」；缺文件时设置页会列出缺少项。
> 建议一并下载 `tokenizer_config.json`、`special_tokens_map.json`、
> `sentencepiece.bpe.model`（transformers.js 兜底路径更稳，脚本会自动带上）。

## 3. 放置目录

把模型的整个文件夹放到**模型目录**下（设置页「打开模型目录」可直接打开并自动创建）：

```
<模型目录>/
  Xenova/
    bge-m3/                 ← BGE-M3（注意在 Xenova 子目录下）
      tokenizer.json
      config.json
      onnx/model_quantized.onnx
  bge-reranker-base/        ← 重排序模型（可选，不在 Xenova 下）
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

另外也支持 HuggingFace 缓存兜底：Windows 默认
`%LOCALAPPDATA%\live2d-cyrene\Cache\huggingface\Xenova\bge-m3\`
（便携模式或改过缓存目录时，把前缀换成实际缓存根即可）。

## 4. 命令行安装（仓库用户，可选）

源码/仓库环境可直接用脚本下载（自动切源、支持断点续传、跳过已完整文件）：

```powershell
# BGE-M3 → models/Xenova/bge-m3/
powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-m3.ps1

# 重排序模型（可选）→ models/bge-reranker-base/
powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-reranker.ps1
```

- 默认源序：hf-mirror → 官方源（reranker 另带魔搭 ModelScope 兜底）；
  可用 `-Mirror hf-mirror|official`（reranker 还支持 `modelscope`）指定单一源，
  `-Force` 强制重新下载。
- 脚本会校验文件大小并输出结果；完成后回设置页点「刷新状态」。

## 5. 完成后刷新

回到 设置 → 昔涟设置 → RAG / 文档导入：

1. 手动安装后点「🔄 刷新状态」重新体检（应用内下载完成后会自动刷新）；
2. BGE-M3 模型卡显示「已下载」即安装成功；
3. 「删除模型」会同时删除项目 `models` 目录与 HF 缓存中的模型文件，需要重新安装。

## 常见问题

- **卡在「未下载」**：确认三个文件齐全、`onnx/model_quantized.onnx` 路径层级正确；重排模型放在 `bge-reranker-base/`（不带 Xenova 前缀）。
- **下载很慢/超时**：在「下载模型」窗或设置页切到 `hf-mirror` 后重试（支持断点续传）；也可用 `scripts/install-bge-m3.ps1` 自动切源下载。
- **Rerank 显示「未安装，按关闭处理」**：属正常降级，不安装不影响基础检索。
