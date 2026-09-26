# RAG 后端迁移 .NET（Phase A：reranker 下沉 + 帧协议加固）

> 日期：2026-09-26 · 状态：**Phase A 已落地**（rerank op + 协议加固 + 数值对账 0 误差）
> 关联：`docs/design/2026-09-26-agent-orchestration-plan-b.md`（同类"机制下沉、边界保留"模式）
> 代码：`dotnet/embedding-sidecar/`（RAG Host 雏形）、`src/main/rag/`

## 1. 决策与边界

RAG 后端（嵌入推理 / 重排 / 向量库 / 混合检索 / 记忆操作 / 文档导入）**分阶段**迁移到
.NET sidecar 进程。与 Plan B 相同的边界原则：

1. **密钥 / 权限审批 / 工具执行 / IPC 永不离开 TS**；
2. .NET 只做**计算与存储**，进程由 TS spawn，stdio 帧协议通信；
3. 数据文件格式沿用 `<userData>/rag-data/*.json`，.NET 直接读写同一 schema（零数据迁移，可随时切回 TS 实现对照）；
4. 每阶段必须"逐位/逐条对账 + 可回退"，不做一次性替换。

## 2. 阶段计划

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| **A** | reranker 下沉（原生 logits）+ 帧协议加固（修 P0 失步 + C# 合并写） | `verify-rerank` 0 误差；协议冒烟全绿；启动 0 次 `protocol failure` | ✅ 本提交 |
| **B** | 向量库（JSON schema 兼容 + IVF）+ 混合检索（BM25 + 融合 0.7/0.3），`search` op + TS 委托 | 生产接入冒烟全绿；分词差异质量基线：top1 6/6、topK 重叠 100%、顺序 5/6 | ✅ 本提交 |
| C | 记忆操作（L0/L1/L2、召回统计）+ 文档导入管线（分块、队列、缓存） | 端到端导入/检索/召回统计与 TS 一致；TS 降为薄客户端 | 待开始 |
| D | 场景/贴纸 embedding、TS 实现清理、打包接线（`resources/embed-models`、sidecar 路径） | 死代码删除；打包版 sidecar 正常加载模型 | 待开始 |

## 3. Phase A 协议扩展（Program.cs ↔ embedding-sidecar.ts）

沿用既有帧格式（`[4B LE 头长][JSON][可选 float32 段]`），新增 op：

| 方向 | 帧 | 说明 |
|---|---|---|
| 请求 | `{id, op:"rerank", query, documents:[...], rerankerDir}` | rerankerDir 为**完整模型目录**（TS 侧 `getProjectModelDir` 解析），.NET 惰性加载 + 目录变更重载 |
| 响应 | `{id, ok:true, count:N, dim:1}` + `N×float32` | **原始 logits**（越大越相关），不做 softmax |

加固点：

1. **客户端帧解码器**（`src/main/rag/sidecar-frame-decoder.ts`，纯状态机可单测）：
   4B 长度前缀在 JSON 头完整到达前**不得消费**。历史 P0：头被分片时前缀丢失 →
   下一轮把 `{"id` 读成长度（`bad frame length 1684611707` = `0x6469227B`，本次实锤）→ 永久失步。
2. **C# 响应/通知写合并**：长度前缀 + JSON 头合并为一次 `Write`（二进制段仍逐段零拷贝），
   消除无缓冲 stdout 上最常见的分片点。

## 4. Phase A 交付物

| 文件 | 变更 |
|---|---|
| `dotnet/embedding-sidecar/RerankerEngine.cs` | 新增：bge-reranker-base 句对打分（逐条前向，与 JS batch=1 逐位一致） |
| `dotnet/embedding-sidecar/HfUnigramTokenizer.cs` | 新增 `EncodePairToIds`（`<s> A </s></s> B </s>`，右截断语义对齐 transformers.js v2） |
| `dotnet/embedding-sidecar/Program.cs` | rerank op、`verify-rerank` 命令、写合并、RequestHeader 扩展 |
| `src/main/rag/sidecar-frame-decoder.ts` + `.test.ts` | 新增：可单测帧解码器（11 用例，含分片回归） |
| `src/main/rag/embedding-sidecar.ts` | 改用解码器；`request()` 公共路径；新增 `rerankScores()` |
| `src/main/rag/reranker.ts` | 引擎优先级：.NET sidecar → transformers.js；修复历史调用 bug（见 §6） |
| `src/main/rag/model-status.ts` | 新增 `getProjectModelDir()`（具体模型目录，供 .NET 传参） |
| `scripts/diagnostics/reranker-dump-verify.mjs` | JS 金样生成（pairs/tokenIds/logits） |
| `scripts/diagnostics/reranker-sidecar-smoke.mjs` | rerank op 协议冒烟 + 金样对账 |

## 5. 验证（实测）

```bash
dotnet build dotnet/embedding-sidecar/CyreneEmbedSidecar.csproj -c Debug   # 0 警告 0 错误
node scripts/diagnostics/reranker-dump-verify.mjs                         # 金样（4 对含 512 截断）
cyrene-embed.exe verify-rerank models/bge-reranker-base ...               # 608/608 tokens；4/4 |diff|=0
node scripts/diagnostics/reranker-sidecar-smoke.mjs                       # 9/9 PASS（含负例与同步性）
npx vitest run src/main/rag                                               # 120/120（含解码器回归 11）
npx tsc -p tsconfig.main.json --noEmit                                    # clean
```

## 6. 顺带修复的两个实测 bug

1. **sidecar 协议失步（P0）**：客户端 `take(headerLen)` 在头分片时丢前缀；触发源是
   C# 分段写 + Windows 管道读时机。修复见 §3，回归用例锁死。
2. **reranker 静默降级**：原实现把 `[[query, doc], ...]` 直接喂 text-classification
   pipeline —— transformers.js v2 tokenizer 不支持元组（`text.split is not a function`，
   被 retriever 捕获后静默回退）；且 `num_labels=1` 时 pipeline 的 softmax 让分数恒为 1。
   现改走 tokenizer `text_pair` + 原始 logits（.NET 与 JS 兜底同一语义）。

## 7. 风险与注意

- **截断语义**：transformers.js v2 对超长句对做"拼接后右截断"（不做 HF longest_first /
  特殊 token 保留）；Phase A 按实测行为对齐，升级 transformers.js 需重验 `verify-rerank`。
- **多文档请求**：rerank 逐条前向（int8 动态量化对 batch 组合敏感），批量吞吐靠调用侧并发/分批，
  不引入 batch 前向。
- **Phase B 前置**：向量库 JSON schema、IVF 构建参数（k-means++ / nprobe）、BM25 分词器
  （`@node-rs/jieba` 是 native 绑定，.NET 侧需选型 JiebaNet 或自带词典）需先做数据/行为快照。

## 8. Phase B 落地（向量库 + 混合检索，2026-09-26 更新）

**协议**（`search` op，Program.cs ↔ embedding-sidecar.ts）：

| 方向 | 帧 |
|---|---|
| 请求 | `{id, op:"search", ragDataDir, query, source?, topK?, importIds?, allowedEntryIds?, customWords?, vectorWeight?, bm25Weight?, updateRecall?}` |
| 响应 | `{id, ok, count, dim, results:[{id,text,source,weight,createdAt,lastRecalledAt,metadata,score}]}` + `count×dim` float32 embedding 段 |

**关键决策与事实**：

1. **分词方案 B（JiebaNet 自闭环）**——基于质量回归数据拍板：
   - 切分一致率（词级）61.22%（jieba-rs 与 JiebaNet 词典/算法不同，无法精确对齐）；
   - 检索质量回归（12 docs / 6 查询）：top1 一致 6/6、topK 重叠 100%、完整顺序 5/6
     （唯一差异为 0.002 差距平局互换）；复现：`cyrene-embed verify-search …`；
   - 现网 tag 全为 `"x"`（jieba-rs POS 退化）→ 名词加权/虚词降权此前从未生效；
     JiebaNet 真实词性让该逻辑首次生效（差异已计入回归）。
2. **召回回写**：由 .NET 落盘（`weight+0.05`、`lastRecalledAt`）；TS 侧搜索不再触碰
   本地副本；sidecar 失败回退本地前调用 `store.reload()` 同步磁盘状态。
3. **存储兼容**：`memory-store.json` 同 schema 读写（double 精度、字段序、`metadata`
   null 忽略写出）；RagStore 按目录缓存 + mtime 自动重载外部（TS 进程）改写。
4. **IVF**：仅无 source 且 ≥2 条时启用（k-means++ 随机初始化，与 TS 同为近似路径，
   跨引擎不做精确对账；有 source 走全量扫描，是精确对账路径）。
5. **单测隔离**：vitest 全局 `CYRENE_EMBED_SIDECAR=0`，避免单测拉起真实 sidecar 进程。

**遗留优化项**：BM25 每次全库分词（JiebaNet），大批量库需要 entry 级 token 缓存；
分词器专项（移植 jieba-rs，或基于质量回归评审后长期保留方案 B）列入 Phase D 前评估。
