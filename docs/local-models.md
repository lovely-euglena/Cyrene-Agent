# 本地向量模型安装说明（BGE-M3 / bge-reranker-base）

> 设置 → 昔涟设置 → RAG / 文档导入 也内置了同样的步骤（「安装说明」按钮）。
> 模型为**手动安装**，应用不提供在线一键下载。

## 1. 选择下载源

设置页「下载镜像源」二选一：

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

模型目录按以下顺序探测（命中第一个完整目录即可）：

1. 环境变量 `CYRENE_MODELS_DIR` 指定的目录；
2. 当前工作目录下的 `models/`；
3. 应用可执行文件同级目录下的 `models/`（绿色版常用）。

另外也支持 HuggingFace 缓存兜底：`~/.cache/huggingface/Xenova/bge-m3/`。

## 4. 完成后刷新

回到 设置 → 昔涟设置 → RAG / 文档导入：

1. 点「🔄 刷新状态」重新体检；
2. BGE-M3 模型卡显示「已下载」即安装成功；
3. 「删除缓存」会删除已下载模型，需要按本说明重新安装。

## 常见问题

- **卡在「未下载」**：确认三个文件齐全、`onnx/model_quantized.onnx` 路径层级正确；重排模型放在 `bge-reranker-base/`（不带 Xenova 前缀）。
- **下载很慢/超时**：切换到 `hf-mirror` 镜像源后重试；应用内的「打开下载站」会按当前镜像源打开。
- **Rerank 显示「未安装，按关闭处理」**：属正常降级，不安装不影响基础检索。
