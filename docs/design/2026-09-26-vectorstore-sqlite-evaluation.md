# 向量库 SQLite 化评估方案（2026-09-26）

> 结论先行：**未重写，当前仍是 JSON 单文件方案**。本方案给出「要不要换、换成什么、
> 怎么验证、怎么迁移」的完整评估路径；建议先做 1–2 天 PoC（Phase 0），用实测数据决策。

---

## 1. 现状（基线）

```
TS JsonVectorStore ──┐
                     ├── memory-store.json（全量单文件，双写，last-writer-wins）
.NET RagStore      ──┘
```

- **存储**：`userData/rag-data/memory-store.json`（条目数组，含 1024 维浮点向量）。
- **索引**：进程内 IVF（k-means++ / nprobe = K/8），变更即 `markIndexDirty`，搜索时惰性重建。
- **检索**：向量 topK×3 + 自研 BM25（JiebaNet 分词）→ max 归一化 0.7/0.3 融合 → reranker 精排。
- **一致性**：双端原子写（tmp+rename）、读前 `ensureFresh/RefreshIfChanged`、
  解析失败重置快照、Windows 共享冲突重试（commit `cd7204a5` / `04e6e643`）。
- **实测状态**：RAG e2e 14/14；单测 269/269（rag+memory）；全量 4028/4029（1 例为 Git Bash 环境基线）。
- **数据现状**：生产 `userData/rag-data` **尚未产生**（无历史包袱，迁移窗口最佳）。
- 旁注：`@lancedb/lancedb` 依赖已无实际代码使用（仅注释提及），属清理候选。

## 2. 现有方案的痛点（换库的动机，均需基准量化）

| # | 痛点 | 说明 | SQLite 对应收益 |
|---|------|------|----------------|
| P1 | **全量重写** | 每次写都是 O(n) 序列化整文件：召回回写 1 条也要重写全库；1k 块导入 ≈ 63 次全量写 | 事务 + 行级写，写入 O(新增) |
| P2 | **跨进程双写** | last-writer-wins；刚修复的一致性机制复杂、窗口毫秒级 | WAL + 单写者模型，天然并发安全 |
| P3 | **BM25 全库分词** | 每次查询重新分词整个语料（已知遗留） | token 落库缓存 / FTS5 原生 BM25 |
| P4 | **无事务** | 导入取消/异常留下孤儿块与缓存不一致窗口 | 原子事务，可回滚 |
| P5 | **冷启动解析** | 需 JSON.parse 全量（10k 块 × 1024 维 ≈ 百 MB 文本量级） | 按需读 / mmap，启动 <200ms 目标 |
| P6 | **IVF 近似召回** | nprobe 采样破坏召回（无保障） | 暴力 KNN 精确（sqlite-vec）或维持现状 |

## 3. 目标与非目标

**目标**：P1–P5 的工程性收益；保持 P6 召回质量不降级；保持「sidecar 不可用时本地回退」设计原则。
**非目标**：不换 embedding 模型；不做分布式/多用户；不引入需常驻服务的数据库。

## 4. 候选方案

| 方案 | 组成 | Node/Electron 装载 | .NET 装载 | 风险 | 评价 |
|------|------|-------------------|-----------|------|------|
| **A. sqlite-vec + FTS5** | `vec0` 虚拟表（float[1024], cosine）+ FTS5 BM25 + WAL | `sqlite-vec` npm（better-sqlite3 / node:sqlite） | Microsoft.Data.Sqlite + LoadExtension | 扩展装载/打包（最大） | 收益最大，需 PoC 先验 |
| **B. SQLite 持久层 + 现有内存索引** | 仅换存储：entries 表 + embedding BLOB；IVF/BM25 逻辑不动；token 缓存可落库 | 不需要（.NET 单写者；TS 走 op） | 内置能力，无需扩展 | 低 | **最小迁移**，解决 P1/P2/P4/P5 |
| **C. 双端直连 SQLite** | TS 与 .NET 各自开连接，WAL 并发 | node:sqlite（Electron 43 内置）或 better-sqlite3（ABI 重编译） | Microsoft.Data.Sqlite | 两套装载/迁移/测试 | 仅当 TS 兜底必须保持同等检索能力时考虑 |
| **D. Vectorlite（HNSW）** | ANN 扩展 | 有 Node 预编译 | .NET 装载未见成熟案例 | 高 | 备选，非首选 |
| **E. 保持 JSON + IVF** | 现状（基线/回退） | — | — | 低 | P1/P3 痛点持续 |

**推荐路线**：优先验证 **A**；若 A 的扩展装载/打包不成立，退 **B**（仍能拿到大部分收益，
且无任何原生扩展依赖）。**C 不作为首选**——生产链路已 sidecar 优先，TS 本地仅兜底，
为兜底维护双栈装载不划算。**D 排除**（.NET 生态不成熟）。

## 5. 架构决策点：谁写库？

- **推荐：.NET sidecar 唯一写者**。向量/BM25/导入/召回回写全部走现有 op
  （`search` / `doc-import` / `embed`），TS 只是调用方；JSON 保留为 sidecar 禁用时的回退。
- 好处：单写者 → 不存在双写竞态；SQLite 扩展只需 .NET 侧打包；TS 侧零 ABI 风险。
- 代价：sidecar 不可用时本地检索仅能走 JSON 回退（现状已如此，可接受）。

## 6. PoC 计划（Phase 0，1–2 天，可独立丢弃）

验证 5 个假设：

| 假设 | 验证内容 | 方法 |
|------|---------|------|
| H1 装载 | win-x64：.NET `LoadExtension(sqlite-vec)` 成功；Electron/Node 侧（node:sqlite）探测作为加分项 | 最小 spike 程序 + `SELECT vec_version()` |
| H2 能力 | `vec0` 支持 `float[1024]` cosine；metadata/partition 过滤（source/importId）可用；`allowedEntryIds` 用「KNN 超采样 + 后过滤」对齐现有语义 | spike SQL + 与现 `verify-search` 对账 |
| H3 BM25 | FTS5 在两端构建中可用；Jieba 预分词 + `bm25()` vs 现自研 BM25 的 topK/排序差异（沿用 jieba-rs 决策方法：给出质量回归数据） | 对账脚本输出 overlap/排序差异 |
| H4 性能 | 1k / 10k / 50k 三档：KNN p50/p95、混合检索、1k 块导入、单条写、冷启动加载 | 基准脚本，见 §7 |
| H5 一致性 | WAL 下：kill -9 写入中 / 导入+搜索+记忆写并发 10 分钟 / 断电模拟 | 崩溃脚本 + e2e 并发场景复用 |

PoC 交付物：`scripts/diagnostics/sqlite-vec-spike.mjs`（Node）、sidecar `verify-sqlite`
子命令（.NET）、合成数据生成器（1024 维 + 真实块文本）、基准报告（Markdown 表格）。

## 7. 基准与验收（go/no-go 阈值）

基线 = 当前 JSON+IVF 实测（先跑一遍固定数据集存档）。

| 指标 | 测量方法 | 门槛 |
|------|---------|------|
| 召回质量 | 暴力全扫为 ground truth：recall@10；与现实现 topK overlap | ≥ 现 IVF；overlap ≥ 95% |
| 混合检索延迟 | p50/p95（不含 rerank）@1k/10k/50k | p95 ≤ 现实现 ×1.2，且 @50k ≤ 300ms |
| 写入 | 1k 块导入总耗时；单条记忆写 | ≤ 现 50%；单条 ≤ 10ms |
| 冷启动 | 10k 块首次可用时间 | ≤ 现 JSON（目标 <200ms） |
| 一致性 | kill -9 后零丢失/零损坏；并发 10 分钟无条目丢失 | 全过 |
| 打包 | Release publish + electron-builder 产物含所需 dll；增量 ≤ ~2MB | 通过安装验证 |

任一门槛不达 → no-go，保留 JSON 方案（现状已修好一致性），并可单独立项做
**BM25 token 缓存**（该优化对 JSON 方案同样适用）。

## 8. Schema 草案（方案 A）

```sql
PRAGMA journal_mode=WAL;          -- 并发读 + 单写
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA user_version=1;            -- schema 版本/迁移

CREATE TABLE entries (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL,
  embedding BLOB NOT NULL,                     -- float32 LE, 1024 维
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL, last_recalled_at INTEGER NOT NULL,
  metadata TEXT                               -- JSON（importId/fileName/chunkIndex/l2Id…）
);
CREATE INDEX idx_entries_source ON entries(source);

CREATE VIRTUAL TABLE vec_entries USING vec0(
  embedding float[1024] distance_metric=cosine,
  source TEXT,                                 -- metadata 过滤列
  import_id TEXT
);                                            -- 或 partition key（需 PoC 定）

CREATE VIRTUAL TABLE fts_entries USING fts5(tokens);  -- Jieba 预分词结果（空格连接）
-- document-cache.json 可一并入库（缓存表），也可留 JSON
```

要点：`weight/lastRecalledAt` 的时序语义（衰减×权重）在 KNN 后二次排序，与现实现一致
（超采样 topK×3 → 重算加权分 → minScore/topK），避免 ANN 分数与加权分排序错位。

## 9. 迁移与回退

- **迁移**：`migrate-json` op（幂等；`memory-store.json` → SQLite；写 `.bak` 备份）；
  当前生产无数据，迁移成本≈0，但仍保留 op 以备老用户。
- **开关**：`CYRENE_RAG_STORE=sqlite|json`（默认 sqlite；json 走现有路径）。
- **影子对账**：切换期同一查询双跑（`verify-search` 扩展），输出 topK/分数差异报告。
- **回退**：`export-json` op + 保留 JSON 写路径一个版本周期后删除。

## 10. 工作量与分期

| 阶段 | 内容 | 估计 |
|------|------|------|
| Phase 0 | PoC（H1–H5）+ 基准 + 报告 | 1–2 人日 |
| Phase 1 | SQLite 存储层（RagStore 替换）+ migrate + verify 对账 | 2–3 人日 |
| Phase 2 | 接线（单写者 + TS 读切换 + 开关 + 影子对账 + e2e） | 1–2 人日 |
| Phase 3 | BM25 token 缓存/FTS5 + 清理（含 lancedb 依赖）+ 文档 | 1–2 人日 |

每阶段独立可停、可回退；Phase 0 结论先行。

## 11. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| sqlite-vec 在 .NET 装载/打包失败 | 高 | H1 先验；失败退方案 B（无扩展依赖） |
| Electron 内置 node:sqlite 不可用/扩展开关缺失 | 中 | 推荐架构下 TS 不写库，不阻塞；必要时 only .NET |
| FTS5 与自研 BM25 质量差异 | 中 | 沿用 jieba 决策流程（数据 + 用户确认）；或仅做 token 缓存不改打分 |
| sqlite-vec 为暴力扫描，50k+ 延迟超标 | 中 | 实测；超标则保留内存 IVF（方案 B）+ SQLite 存储 |
| WAL 多文件（-wal/-shm）分发/备份遗漏 | 低 | 备份/导出走 SQL 接口；文档注明 |
| 版本升级 schema 迁移失败 | 低 | `user_version` + 事务迁移 + 自动 .bak |

## 12. 结论与建议

1. **确认现状**：未 SQLite 化；JSON+IVF 已过 Phase B/C 验证且一致性刚修好，不存在"必须换"的紧迫缺陷。
2. **建议启动 Phase 0 PoC**：收益（事务/并发/增量写/BM25 缓存）正对当前痛点，
   且生产无数据、迁移成本最低；最大风险（H1 扩展装载）可在 1–2 天内排除。
3. **默认路线**：方案 A（sqlite-vec + FTS5，.NET 单写者，JSON 回退）；
   若 H1/H3 不成立则降级方案 B（SQLite 持久层 + 现有索引，仍解决 P1/P2/P4/P5）。
4. **决策门**：按 §7 阈值 go/no-go；no-go 则维持现状并单独立项 BM25 token 缓存。
