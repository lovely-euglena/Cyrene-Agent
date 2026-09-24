/**
 * DotnetRagStore——RAG 数据层 .NET 轨适配器（E7 主链路接线）。
 *
 * 实现 JsonVectorStore 被 retriever/index/memory 消费的公共面，
 * 存储与向量检索委托 cyrene-native --rag-host（SQLite/WAL + 二进制
 * embedding，E9），embedding 计算仍在 TS（provider 在主进程）。
 * 任何 host 故障（超时/崩溃/未启用）按操作级回退 JsonVectorStore
 * （fallback 实例始终同步持有全量数据的旧路径——仅当 ragHost 开启时
 * .NET 是唯一事实源，JSON 退为首启迁移源）。
 */
import * as fs from "fs";
import * as path from "path";
import type { MemoryEntry, SearchResult, VectorSearchOptions } from "./vectorstore";
import { JsonVectorStore } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";
import { ragHostClient } from "../dotnet-backend/host-clients";

const LOG = "[RAG-Dotnet]";

interface HostEntry {
  id: string; text: string; source: string; weight: number;
  createdAt: number; lastRecalledAt: number; metadata?: Record<string, unknown>;
  /** host 的混合分（0.3*BM25+0.7*cos）×weight×衰减——融合层必须拿到，否则向量轨全零分 */
  score?: number;
}

export class DotnetRagStore {
  private readonly fallback: JsonVectorStore;
  private readonly dataDir: string;
  private opened = false;

  constructor(dataDir: string, fallback: JsonVectorStore) {
    this.dataDir = dataDir;
    this.fallback = fallback;
  }

  /** 打开 host（含 legacy memory.json 首启迁移 E1）。失败返回 false → 全走 fallback。 */
  async open(): Promise<boolean> {
    try {
      if (!await ragHostClient.ensureStarted()) return false;
      const dbPath = path.join(this.dataDir, "rag.sqlite");
      const jsonPath = path.join(this.dataDir, "memory.json");
      await ragHostClient.call("open", {
        dbPath,
        jsonImportPath: fs.existsSync(jsonPath) ? jsonPath : undefined,
      });
      this.opened = true;
      console.log(LOG, "host 就绪:", dbPath);
      return true;
    } catch (error) {
      console.warn(LOG, "host 打开失败，RAG 走 TS 存储:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  get stats(): { total: number; sources: Record<string, number> } {
    // 同步接口：读 fallback 的内存态近似（host 异步 stats 只用于冒烟）。
    // 主消费方（retriever 空库短路）语义一致。
    return this.fallback.stats;
  }

  getIndexMeta() { return this.fallback.getIndexMeta(); }

  async add(text: string, source: string, provider: EmbeddingProvider, metadata?: Record<string, unknown>): Promise<MemoryEntry> {
    try {
      const embedding = await provider.embed(text);
      const entry: MemoryEntry = {
        id: `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        text, embedding, source,
        weight: 1.0,
        createdAt: Date.now(), lastRecalledAt: 0,
        metadata,
      };
      await this.upsert([entry]);
      return entry;
    } catch (error) {
      console.warn(LOG, "add 回退 TS:", error instanceof Error ? error.message : error);
      return this.fallback.add(text, source, provider, metadata);
    }
  }

  async addUnique(text: string, source: string, provider: EmbeddingProvider, metadata?: Record<string, unknown>): Promise<MemoryEntry> {
    try {
      const embedding = await provider.embed(text);
      const entry: MemoryEntry = {
        id: `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        text, embedding, source,
        weight: 1.0,
        createdAt: Date.now(), lastRecalledAt: 0,
        metadata,
      };
      await this.upsert([entry]);
      return entry;
    } catch (error) {
      return this.fallback.addUnique(text, source, provider, metadata);
    }
  }

  async search(
    query: string,
    source?: string,
    provider?: EmbeddingProvider | null,
    topK = 5,
    minScore = 0.3,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    // 与 JsonVectorStore.search 同语义：无 provider 时返回空（BM25 由 retriever 做）
    if (!provider) return [];
    try {
      const embedding = await provider.embed(query);
      const r = (await ragHostClient.call("query", {
        embedding, text: query, topK: topK * 2, source,
      })) as { results?: HostEntry[] } | null;
      const list = r?.results ?? [];
      const out: SearchResult[] = [];
      for (const h of list) {
        if (options.allowedEntryIds && !options.allowedEntryIds.includes(h.id)) continue;
        const entry = this.fallbackUpsertCache(h);
        // score 透传 host 混合分（cos×weight×衰减）——retriever 融合层的
        // vectorScore 就取它做归一，置 0 会把向量轨在融合中清零
        out.push({ entry, score: h.score ?? 0 } as unknown as SearchResult);
      }
      return out.slice(0, topK);
    } catch (error) {
      console.warn(LOG, "search 回退 TS:", error instanceof Error ? error.message : error);
      return this.fallback.search(query, source, provider, topK, minScore, options);
    }
  }

  private fallbackUpsertCache(h: HostEntry): MemoryEntry {
    // retriever 融合需要完整 MemoryEntry（含 embedding 参与 rerank 归一）——
    // host 不回传 embedding（省带宽），fallback 内存索引按 id 补齐。
    const cached = this.fallback.getById?.(h.id);
    if (cached) return cached;
    return {
      id: h.id, text: h.text, embedding: [],
      source: h.source, weight: h.weight,
      createdAt: h.createdAt, lastRecalledAt: h.lastRecalledAt,
      metadata: h.metadata,
    };
  }

  deleteEntriesByIds(ids: string[], source?: string): number {
    // host 轨 fire-and-forget 同步接口（调用方不消费精确计数时正确性可接受；
    // 保守做法：同步删 fallback，异步镜像 host）
    try { void ragHostClient.call("delete", { ids }); } catch { /* host 故障时 host 已非事实源场景 */ }
    return this.fallback.deleteEntriesByIds(ids, source);
  }

  deleteImportedDoc(importId: string, fileName?: string): number {
    try { void ragHostClient.call("delete", { importId, fileName }); } catch { /* ignore */ }
    return this.fallback.deleteImportedDoc(importId, fileName);
  }

  /** 维度切换清库（转发 host 清空 + fallback 本地清，防旧维度写回）。 */
  clearForRebuild(): void {
    try { void ragHostClient.call("delete_all", {}); } catch { /* ignore */ }
    this.fallback.clearForRebuild();
  }

  /** 受控退出（before-quit）：异步刷盘（上游 2026-09-24 新增协议，转发 fallback）。 */
  async flush(): Promise<void> {
    await this.fallback.flush();
  }

  /** 会话紧急结束（Windows session-end）：同步落盘（转发 fallback）。 */
  flushSync(): void {
    this.fallback.flushSync();
  }

  /** index.ts 的 getEntriesBySource 直捅 entries 私有数组（as any）——
   * 这里暴露同形访问器保持兼容。 */
  hasImportedDocumentChunks(importId: string): boolean {
    return this.fallback.hasImportedDocumentChunks(importId);
  }

  get entries(): MemoryEntry[] {
    return (this.fallback as unknown as { entries: MemoryEntry[] }).entries;
  }

  async addBatch(items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>, provider: EmbeddingProvider): Promise<MemoryEntry[]> {
    const embeddings = await provider.embedBatch(items.map((i) => i.text));
    const entries: MemoryEntry[] = items.map((item, i) => ({
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: item.text,
      embedding: embeddings[i],
      source: item.source,
      weight: 1.0,
      createdAt: Date.now(),
      lastRecalledAt: 0,
      metadata: item.metadata,
    }));
    await this.upsert(entries);
    return entries;
  }

  async addPreparedBatch(prepared: Array<{ text: string; embedding: number[]; source: string; metadata?: Record<string, unknown> }>): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = prepared.map((p) => ({
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: p.text, embedding: p.embedding, source: p.source,
      weight: 1.0, createdAt: Date.now(), lastRecalledAt: 0, metadata: p.metadata,
    }));
    try { await this.upsert(entries); } catch (e) { console.warn(LOG, "addPreparedBatch host 轨失败:", e instanceof Error ? e.message : e); }
    return entries;
  }

  private async upsert(entries: MemoryEntry[]): Promise<void> {
    await ragHostClient.call("upsert", {
      entries: entries.map((e) => ({
        id: e.id, text: e.text, embedding: e.embedding, source: e.source,
        weight: e.weight, createdAt: e.createdAt, lastRecalledAt: e.lastRecalledAt,
        metadata: e.metadata,
      })),
    });
    // 双写 fallback：保持同步回退能力（B6 对比基准），成本为一次内存 append
    for (const e of entries) this.fallback.appendExternal?.(e);
  }
}

/** CYRENE_RAG_HOST=1 时 initRAG 用本函数构造 store（失败自动降级）。 */
export async function createStore(dataDir: string, fallback: JsonVectorStore): Promise<DotnetRagStore | JsonVectorStore> {
  const store = new DotnetRagStore(dataDir, fallback);
  if (await store.open()) return store;
  return fallback;
}
