# Token 精确统计接入（cyrene-agent）

> 2026-10-02 · 状态：P1（.NET 宿主）已落地，TS 接线/设置/上下文计量接入待做
> 关联：`dotnet/token-stats/`（cyrene-token）· `D:\code\token-offline-statistics`（词表来源/离线基线）

## 1. 目标

- 在设置中提供「启用精确 token 统计」开关，**默认关闭**；关闭时保持现有启发式估算。
- tokenizer 文件**不随包分发**，按需从 **ModelScope / HuggingFace 官方及其镜像**下载。
- **下载管理全部在 .NET**（清单、URL、镜像回退、超时重试、原子落盘、内容校验、缓存目录）；
  Node/TS 只负责把**文本与模型名**传进来，以及设置开关/来源偏好。

## 2. 架构

```
Electron 主进程（TS，仅传参）
  └─ token-stats-client.ts（待做）：spawn/driver cyrene-token serve --data-dir <userData>/token-stats
         │ 帧协议（4B LE + JSON）：count / status / delete / ping
         ▼
cyrene-token（dotnet/token-stats，下载与计数唯一实现）
  ├─ tokenizer-sources.json     模型 → 官网仓库（HF / ModelScope）
  ├─ TokenizerStore             源顺序（请求 source → 其余回退）、URL 构造、
  │                             120s 超时、原子落盘（.part → move）、内容校验
  ├─ TokenizerCache             按模型缓存已加载 tokenizer（libtokenizers 初始化串行）
  └─ 计数：texts[] → counts[]（字符串→token 数，逐条）
```

- 数据目录：`<userData>/token-stats/tokenizers/<model>/tokenizer.json`。
- 安全：TS 不能传任意 URL；只能传清单内的模型名与来源枚举。

## 3. 协议（P1 已实现）

| op | 请求 | 响应 |
| --- | --- | --- |
| `ping` | — | `{ok, runtime}` |
| `count` | `{model, texts[], source?, allowDownload?}` | `{ok, model, counts[], downloaded, path}`；失败 `{ok:false, error}` |
| `status` | `{model?}` | `{ok, models:[{model, installed, known, path?}], dir}` |
| `delete` | `{model}` | `{ok, removed}` |

- `allowDownload=false` 且本地无词表 → 明确拒绝（等待用户/设置允许）。
- 未知模型/清单外模型 → `{ok:false,error:"模型 x 暂无官方 tokenizer 下载源"}`（TS 回退启发式）。

## 4. 下载源清单与验证（2026-10-02）

- 20 个模型与 `token-offline-statistics` 的离线词表逐一做了**语义比对**：
  - 18/20 规范化 JSON 完全一致；
  - `qwen3`：仅 `merges` 序列化形式差异（字符串 vs 数组）——行为实测同文本计数一致；
  - `deepseek-v3.2`：仅 5 个特殊标记 token（`<dsml:…>` 类）差异，普通文本计数一致。
- 即：从官方源下载的词表与离线基线**计数等价**。
- 源回退顺序：请求 `source` → `modelscope` → `hf-mirror` → `huggingface`（无仓库的源自动跳过）。
- 清单文件：`dotnet/token-stats/tokenizer-sources.json`（可独立更新，无需改代码）。

## 5. 缓存与开关

- `GeneralSettings`（待做）：`tokenStatsEnabled: boolean`（默认 false）、
  `tokenStatsSource: "modelscope" | "hf-mirror" | "huggingface"`（默认 modelscope）。
- 设置页（React 偏好设置「Token 统计」分组）：开关 + 来源选择 + 已安装词表管理
  （下载/删除/当前模型状态）。
- 关闭或词表缺失/下载失败时：调用方回退现有 `estimateTokens`，行为与今日完全一致。

## 6. 分阶段

- **P1（已完成）**：`cyrene-token` .NET 宿主（清单/下载/缓存/校验/计数）+ 打包接线
  （`build:token-stats`、`resources/token-stats`）+ 冒烟 `verify:token-stats`（11/11）。
- **P2**：TS 客户端 + 设置字段/开关/来源/管理 UI + 上下文用量环精确计量
  （`context-usage.ts` 异步精确计数，失败回退估算）。
- **P3（可选）**：`count_tokens` Agent 工具；按会话模型自动选词表；下载进度/断点续传。

## 7. 验收口径

1. 开关默认关闭；关闭时行为与现状零差异（无进程、无下载）。
2. 打开后：当前模型在清单内 → 首次按需下载（可看到状态），计数与离线基线一致；
   清单外模型 → 自动回退估算并提示原因。
3. 下载管理可观测、可清理；断网/源不可用时明确报错且不阻塞对话。
4. `verify:token-stats` 通过；全量 vitest 不回归。
