import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProvider, EmbeddingProvider, type EmbeddingIndexMetadata } from "./embedding";

export type { EmbeddingIndexMetadata };

// ── 类型 ──
export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  source: string;       // "user_memory" | "worldbook" | "imported_doc"
  weight: number;       // 1.0 初始，每次召回 +0.1，24h 未提 ×0.95
  createdAt: number;    // timestamp
  lastRecalledAt: number;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;        // 加权后的综合分数（余弦 × weight × 衰减）
}

export interface VectorSearchOptions {
  importIds?: string[];
  allowedEntryIds?: string[];
}

// ── 余弦相似度（嵌入已归一化，等价于点积） ──
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ── IVF 倒排文件索引 ──
// 用 k-means 把向量聚成 K 个簇，搜索时只查最近的 nprobe 个簇，
// 将 O(n) 变为 O(n / K * nprobe) ≈ O(√n)。
interface IvfIndex {
  /** 簇中心向量（已归一化） */
  centroids: number[][];
  /** 每个簇中的条目 index（指向 this.entries） */
  clusters: number[][];
  /** 建索引时的条目数，用于判定是否需要重建 */
  entryCount: number;
}

function kmeansPlusPlusInit(
  vectors: number[][],
  K: number,
  dim: number,
): number[][] {
  const centroids: number[][] = [];
  // 1. 随机选第一个中心
  const firstIdx = Math.floor(Math.random() * vectors.length);
  centroids.push(vectors[firstIdx].slice());

  // 2. 按距离平方加权选剩下的
  for (let c = 1; c < K; c++) {
    const dists = vectors.map((v) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const sim = cosineSimilarity(v, cent);
        const d = 1 - sim; // 余弦距离 = 1 - cos
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist <= 0) {
      while (centroids.length < K) {
        centroids.push(vectors[centroids.length % vectors.length].slice());
      }
      break;
    }
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push(vectors[i].slice());
        break;
      }
    }
  }
  return centroids;
}

function buildIvfIndex(
  entries: MemoryEntry[],
  K: number,
  maxIter = 20,
): IvfIndex {
  const vectors = entries.map((e) => e.embedding);
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0 || vectors.length === 0) {
    return { centroids: [], clusters: [], entryCount: entries.length };
  }

  const effectiveK = Math.min(K, vectors.length);
  const clusters: number[][] = Array.from({ length: effectiveK }, () => []);

  // k-means++ 初始化
  let centroids = kmeansPlusPlusInit(vectors, effectiveK, dim);

  for (let iter = 0; iter < maxIter; iter++) {
    // 分配
    for (let i = 0; i < effectiveK; i++) clusters[i] = [];
    let changed = false;

    for (let i = 0; i < vectors.length; i++) {
      let bestIdx = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const sim = cosineSimilarity(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = c;
        }
      }
      clusters[bestIdx].push(i);
    }

    // 更新中心
    const newCentroids: number[][] = [];
    for (let c = 0; c < effectiveK; c++) {
      const members = clusters[c];
      if (members.length === 0) {
        // 空簇保留原中心
        newCentroids.push(centroids[c].slice());
        continue;
      }
      const sum = new Array(dim).fill(0);
      for (const idx of members) {
        const v = vectors[idx];
        for (let d = 0; d < dim; d++) sum[d] += v[d];
      }
      // 归一化新中心
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += sum[d] * sum[d];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < dim; d++) sum[d] /= norm;
      }
      newCentroids.push(sum);
    }

    // 检查收敛
    for (let c = 0; c < effectiveK; c++) {
      const sim = cosineSimilarity(newCentroids[c], centroids[c]);
      if (sim < 0.999) { changed = true; break; }
    }
    centroids = newCentroids;
    if (!changed) break;
  }

  return { centroids, clusters, entryCount: entries.length };
}

// ── 存储后端抽象 ──
// 检索/召回/融合等逻辑全部在 VectorStore 基类；后端只负责持久化与新鲜度令牌。
// - json：整文件原子写（回退路径；跨进程 last-writer-wins）
// - sqlite：行级写 + WAL + rev 版本号（默认路径；双进程并发安全）
export type StoreChange =
  | { kind: "insert"; entries: MemoryEntry[] }
  | { kind: "recall"; entries: MemoryEntry[] }
  | { kind: "remove"; ids: string[] }
  | { kind: "replace" };

export type VectorStoreMode = "sqlite" | "json";

export interface VectorStoreBackend {
  /** 全量读取条目与索引元数据（解析失败时返回空并置 null 令牌，见 revision） */
  load(): { entries: MemoryEntry[]; meta: EmbeddingIndexMetadata | null };
  /** 新鲜度令牌：内容变化则不同；null = 读取不可用（调用方应重试加载） */
  revision(): string | null;
  /** 持久化变更；needsReload = 检测到外部并发写入（需整体重载） */
  persist(all: MemoryEntry[], change: StoreChange): { needsReload: boolean };
  saveMeta(meta: EmbeddingIndexMetadata | null): void;
  /** 清空后清理遗留存储（sqlite 删除迁移用 JSON，避免下次启动把旧条目迁回） */
  resetLegacy(): void;
  dispose(): void;
}

// ── JSON 后端（原子写 + Windows 共享冲突重试；原实现语义保持不变） ──
class JsonStoreBackend implements VectorStoreBackend {
  private filePath: string;
  private metaFilePath: string;
  /** 最近一次 load 是否解析失败（失败时不缓存令牌 → ensureFresh 持续重试） */
  private lastLoadFailed = false;

  constructor(dir: string) {
    this.filePath = path.join(dir, "memory-store.json");
    this.metaFilePath = path.join(dir, "memory-store-meta.json");
  }

  load(): { entries: MemoryEntry[]; meta: EmbeddingIndexMetadata | null } {
    let entries: MemoryEntry[] = [];
    this.lastLoadFailed = false;
    try {
      if (fs.existsSync(this.filePath)) {
        entries = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as MemoryEntry[];
      }
    } catch (err) {
      console.warn("[RAG] failed to load vector store:", err);
      this.lastLoadFailed = true;
      entries = [];
    }
    let meta: EmbeddingIndexMetadata | null = null;
    try {
      if (fs.existsSync(this.metaFilePath)) {
        meta = JSON.parse(fs.readFileSync(this.metaFilePath, "utf8")) as EmbeddingIndexMetadata;
      }
    } catch {
      meta = null;
    }
    return { entries, meta };
  }

  revision(): string | null {
    if (this.lastLoadFailed) return null;
    try {
      if (!fs.existsSync(this.filePath)) return "missing";
      const info = fs.statSync(this.filePath);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return null;
    }
  }

  persist(all: MemoryEntry[], _change: StoreChange): { needsReload: boolean } {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 原子写：先写 tmp 再 rename（.NET 侧并发读时不会读到半截 JSON）。
      // Windows 下目标可能被读取占用（EPERM/EBUSY）→ 有界重试；仍失败降级直写。
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
      let renamed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.renameSync(tmp, this.filePath);
          renamed = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
          if (attempt < 9) JsonStoreBackend.sleepSync(5);
        }
      }
      if (!renamed) {
        console.warn("[RAG] atomic rename contended, falling back to direct write");
        fs.writeFileSync(this.filePath, fs.readFileSync(tmp, "utf8"), "utf8");
        fs.unlinkSync(tmp);
      }
    } catch (err) {
      console.warn("[RAG] failed to save vector store:", err);
    }
    return { needsReload: false };
  }

  saveMeta(meta: EmbeddingIndexMetadata | null): void {
    try {
      const dir = path.dirname(this.metaFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.metaFilePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
      fs.renameSync(tmp, this.metaFilePath);
    } catch (err) {
      console.warn("[RAG] failed to save index metadata:", err);
    }
  }

  resetLegacy(): void {
    /* JSON 后端：主存储即 JSON 文件，无遗留 */
  }

  dispose(): void {
    /* 无外部资源 */
  }

  /** 同步短睡眠（Windows 文件共享冲突重试用；避免把整条写入链 async 化）。 */
  private static sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// ── node:sqlite 驱动（Electron 43 / Node 24 内置；不可用时工厂回退 json） ──
export interface NodeSqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

export interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

let cachedSqliteModule: NodeSqliteModule | null | undefined;

function loadNodeSqliteModule(): NodeSqliteModule | null {
  if (cachedSqliteModule !== undefined) return cachedSqliteModule;
  // Node 22.3+：CJS/ESM 通吃（Electron 主进程与 vitest 均可）
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin === "function") {
      cachedSqliteModule = getBuiltin.call(process, "node:sqlite") as NodeSqliteModule;
      return cachedSqliteModule;
    }
  } catch (error) {
    console.warn("[RAG] node:sqlite unavailable:", error);
  }
  // 旧运行时回退：CommonJS require
  try {
    if (typeof module !== "undefined" && module && typeof module.require === "function") {
      cachedSqliteModule = module.require("node:sqlite") as NodeSqliteModule;
      return cachedSqliteModule;
    }
  } catch (error) {
    console.warn("[RAG] node:sqlite require failed:", error);
  }
  cachedSqliteModule = null;
  return null;
}

export function isSqliteStoreAvailable(): boolean {
  return loadNodeSqliteModule() !== null;
}

// ── SQLite 后端（memory.db；schema/语义与 .NET SqliteRagStore 一致） ──
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS rag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dim INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
INSERT OR IGNORE INTO rag_meta(key, value) VALUES ('rev', '0');
INSERT OR IGNORE INTO rag_meta(key, value) VALUES ('schema_version', '1');
`;

type SqliteRow = Record<string, unknown>;

class SqliteStoreBackend implements VectorStoreBackend {
  private readonly db: NodeSqliteDatabase;
  private readonly legacyJsonPath: string;
  private readonly legacyMetaPath: string;
  /** 最近一次 load 是否失败（失败时不缓存令牌 → ensureFresh 持续重试） */
  private lastLoadFailed = false;

  constructor(private readonly dir: string, driver: NodeSqliteModule) {
    this.legacyJsonPath = path.join(dir, "memory-store.json");
    this.legacyMetaPath = path.join(dir, "memory-store-meta.json");
    fs.mkdirSync(dir, { recursive: true });
    this.db = new driver.DatabaseSync(path.join(dir, "memory.db"));
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(SQLITE_SCHEMA);
    this.migrateLegacyJsonIfNeeded();
    this.softMergeLegacyJsonIfNewer();
  }

  load(): { entries: MemoryEntry[]; meta: EmbeddingIndexMetadata | null } {
    let entries: MemoryEntry[] = [];
    this.lastLoadFailed = false;
    try {
      const rows = this.db
        .prepare("SELECT id, text, source, embedding, weight, created_at, last_recalled_at, metadata FROM entries")
        .all() as SqliteRow[];
      entries = rows.map(rowToEntry);
    } catch (err) {
      console.warn("[RAG] sqlite load failed:", err);
      this.lastLoadFailed = true;
      entries = [];
    }

    let meta: EmbeddingIndexMetadata | null = null;
    try {
      const metaRaw = this.getMeta("index_meta");
      if (metaRaw) meta = JSON.parse(metaRaw) as EmbeddingIndexMetadata;
    } catch {
      meta = null;
    }
    return { entries, meta };
  }

  revision(): string | null {
    if (this.lastLoadFailed) return null;
    try {
      return this.readRev() ?? "missing";
    } catch {
      return null;
    }
  }

  persist(all: MemoryEntry[], change: StoreChange): { needsReload: boolean } {
    let pre: string | null = null;
    try {
      pre = this.readRev();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        switch (change.kind) {
          case "insert":
            this.insertRows(change.entries, "replace");
            break;
          case "recall":
            this.updateRecallRows(change.entries);
            break;
          case "remove":
            if (change.ids.length > 0) this.deleteRows(change.ids);
            break;
          case "replace":
            this.db.exec("DELETE FROM entries");
            this.insertRows(all, "replace");
            break;
        }
        this.bumpRev();
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    } catch (err) {
      console.warn("[RAG] sqlite persist failed:", err);
      return { needsReload: false };
    }
    // 本地提交后发现 rev 跳变 > 1：期间有外部提交 → 内存副本可能不完整，需整体重载
    const post = this.readRev();
    return { needsReload: post !== nextRev(pre) };
  }

  saveMeta(meta: EmbeddingIndexMetadata | null): void {
    try {
      if (meta === null) {
        this.db.prepare("DELETE FROM rag_meta WHERE key = 'index_meta'").run();
      } else {
        this.setMeta("index_meta", JSON.stringify(meta));
      }
    } catch (err) {
      console.warn("[RAG] sqlite save metadata failed:", err);
    }
  }

  dispose(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  resetLegacy(): void {
    // 清空后删除迁移源，避免下次启动 entryCount()==0 时把旧条目迁回
    try {
      if (fs.existsSync(this.legacyJsonPath)) fs.unlinkSync(this.legacyJsonPath);
      if (fs.existsSync(this.legacyMetaPath)) fs.unlinkSync(this.legacyMetaPath);
    } catch {
      /* best effort */
    }
    try {
      this.setMeta("json_merged_mtime", String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  // ── 内部：行操作 ──
  private insertRows(entries: MemoryEntry[], conflict: "replace" | "ignore"): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT ${conflict === "ignore" ? "OR IGNORE " : "OR REPLACE "}INTO entries ` +
        "(id, text, source, embedding, dim, weight, created_at, last_recalled_at, metadata) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const entry of entries) {
      stmt.run(
        entry.id,
        entry.text,
        entry.source,
        embeddingToBlob(entry.embedding),
        entry.embedding.length,
        entry.weight,
        entry.createdAt,
        entry.lastRecalledAt,
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
      );
    }
  }

  private updateRecallRows(entries: MemoryEntry[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare("UPDATE entries SET weight = ?, last_recalled_at = ? WHERE id = ?");
    for (const entry of entries) {
      stmt.run(entry.weight, entry.lastRecalledAt, entry.id);
    }
  }

  private deleteRows(ids: string[]): void {
    const stmt = this.db.prepare("DELETE FROM entries WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  // ── 内部：元数据 / rev ──
  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO rag_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private readRev(): string | null {
    return this.getMeta("rev");
  }

  private bumpRev(): void {
    this.db.exec("UPDATE rag_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'");
  }

  private entryCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n?: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  // ── 内部：JSON 迁移 / 软合并（语义与 .NET SqliteRagStore 一致） ──
  private migrateLegacyJsonIfNeeded(): void {
    if (!fs.existsSync(this.legacyJsonPath)) return;
    if (this.entryCount() > 0) return; // 已有数据：交给软合并

    let legacy: MemoryEntry[];
    try {
      legacy = JSON.parse(fs.readFileSync(this.legacyJsonPath, "utf8")) as MemoryEntry[];
    } catch (err) {
      console.warn("[RAG] legacy json parse failed:", err);
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (Array.isArray(legacy) && legacy.length > 0) {
        this.insertRows(legacy, "ignore");
        this.bumpRev();
      }
      this.setMeta("json_merged_mtime", String(legacyJsonMtimeMs(this.legacyJsonPath)));
      if (fs.existsSync(this.legacyMetaPath)) {
        try {
          this.setMeta("index_meta", fs.readFileSync(this.legacyMetaPath, "utf8"));
        } catch {
          /* 尽力而为 */
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (legacy.length > 0) {
      console.log(`[RAG] migrated ${legacy.length} entries from memory-store.json`);
    }
  }

  private softMergeLegacyJsonIfNewer(): void {
    if (!fs.existsSync(this.legacyJsonPath)) return;
    const mtime = legacyJsonMtimeMs(this.legacyJsonPath);
    const recorded = Number(this.getMeta("json_merged_mtime") ?? "0");
    if (mtime <= recorded) return;

    let legacy: MemoryEntry[];
    try {
      legacy = JSON.parse(fs.readFileSync(this.legacyJsonPath, "utf8")) as MemoryEntry[];
    } catch (err) {
      console.warn("[RAG] legacy json merge skipped:", err);
      return;
    }

    const existing = new Set<string>(
      (this.db.prepare("SELECT id FROM entries").all() as SqliteRow[]).map((row) => String(row.id)),
    );
    const missing = (Array.isArray(legacy) ? legacy : []).filter((entry) => !existing.has(entry.id));
    if (missing.length > 0) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.insertRows(missing, "ignore");
        this.bumpRev();
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
      console.log(`[RAG] soft-merged ${missing.length} entries from newer memory-store.json`);
    }
    this.setMeta("json_merged_mtime", String(mtime));
  }
}

function nextRev(rev: string | null): string {
  const value = Number(rev ?? "0");
  return String(Number.isFinite(value) ? value + 1 : 1);
}

function legacyJsonMtimeMs(filePath: string): number {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

function embeddingToBlob(embedding: number[]): Buffer {
  const f32 = Float32Array.from(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToEmbedding(value: unknown): number[] {
  if (!(value instanceof Uint8Array)) return [];
  const copy = value.slice(); // 对齐副本：Float32Array 视图要求 4 字节对齐
  const f32 = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
  return Array.from(f32);
}

function rowToEntry(row: SqliteRow): MemoryEntry {
  return {
    id: String(row.id),
    text: String(row.text),
    embedding: blobToEmbedding(row.embedding),
    source: String(row.source),
    weight: Number(row.weight),
    createdAt: Number(row.created_at),
    lastRecalledAt: Number(row.last_recalled_at),
    metadata:
      row.metadata === null || row.metadata === undefined
        ? undefined
        : (JSON.parse(String(row.metadata)) as Record<string, unknown>),
  };
}

// ── 共享逻辑基类（检索/召回/CRUD；后端无关） ──
export abstract class VectorStore {
  readonly mode: VectorStoreMode;

  protected entries: MemoryEntry[] = [];
  protected indexMeta: EmbeddingIndexMetadata | null = null;

  private readonly dir: string;
  private readonly backend: VectorStoreBackend;
  /** 磁盘新鲜度令牌缓存（外部写入检测；见 ensureFresh） */
  private cachedRevision = "";

  /** IVF 索引，null = 未构建或需要重建 */
  private ivf: IvfIndex | null = null;

  protected constructor(dir: string, backend: VectorStoreBackend, mode: VectorStoreMode) {
    this.dir = dir;
    this.backend = backend;
    this.mode = mode;
    this.reload();
  }

  /**
   * 跨进程一致性：外部写入时重载内存副本（sqlite 对比 rev，JSON 对比 mtime/size）。
   * 同步读路径（getEntriesBySource / stats / hasImported）调用前应先 ensureFresh()。
   */
  ensureFresh(): void {
    try {
      const rev = this.backend.revision();
      if (rev === null || rev !== this.cachedRevision) {
        this.reload();
      }
    } catch {
      // 读不到时保持现状（调用方按内存副本继续）
    }
  }

  /** 从后端全量重载（sidecar 回写召回统计后，本地回退前同步内存副本）。 */
  reload(): void {
    const snapshot = this.backend.load();
    this.entries = snapshot.entries;
    this.indexMeta = snapshot.meta;
    this.markIndexDirty();
    const rev = this.backend.revision();
    if (rev !== null) this.cachedRevision = rev;
    // rev=null（读取失败）：不更新令牌 → 下次 ensureFresh 继续重试
  }

  /** 库目录（.NET sidecar search / doc-import 需要显式传入）。 */
  getDirectory(): string {
    return this.dir;
  }

  /**
   * 获取当前索引元数据（只读）。
   */
  getIndexMeta(): Readonly<EmbeddingIndexMetadata> | null {
    return this.indexMeta;
  }

  // ── 索引元数据校验 ──

  /**
   * 校验 provider 的维度与索引元数据是否一致。
   * - 无元数据 + 有旧数据：尝试从现有向量推断并补写元数据（兼容迁移）
   * - 无元数据 + 无数据：首次写入时创建元数据
   * - 有元数据：严格校验维度一致性
   */
  protected validateDimensionsForProvider(provider: EmbeddingProvider): void {
    const providerDims = provider.resolvedDimensions ?? provider.declaredDimensions;
    if (providerDims === undefined) {
      // 维度尚未解析（cloud provider 首次调用前），允许通过
      // 后续 embed() 调用会自行解析并校验
      return;
    }

    if (!this.indexMeta) {
      // 无元数据：尝试兼容迁移
      if (this.entries.length > 0) {
        const inferredDims = this.entries[0].embedding.length;
        if (inferredDims !== providerDims) {
          throw new Error(
            `[RAG] Index dimension mismatch: existing index has ${inferredDims}-dim vectors, ` +
            `but provider declares ${providerDims}-dim. Rebuild the index first.`
          );
        }
        // 维度一致，补写元数据
        this.indexMeta = this.buildIndexMeta(provider, providerDims);
        this.backend.saveMeta(this.indexMeta);
        console.log("[RAG] migrated index metadata (inferred from existing vectors):", this.indexMeta);
      }
      return;
    }

    // 有元数据：严格校验
    if (this.indexMeta.dimensions !== providerDims) {
      throw new Error(
        `[RAG] Index dimension mismatch: index was built with ${this.indexMeta.dimensions}-dim ` +
        `(model: ${this.indexMeta.model}), but current provider declares ${providerDims}-dim. ` +
        `Rebuild the index or switch back to the original model.`
      );
    }
  }

  /**
   * 首次写入时，如果还没有元数据，根据 provider 创建并保存。
   */
  protected ensureIndexMeta(provider: EmbeddingProvider, resolvedDims: number): void {
    if (this.indexMeta) return;
    this.indexMeta = this.buildIndexMeta(provider, resolvedDims);
    this.backend.saveMeta(this.indexMeta);
    console.log("[RAG] created index metadata:", this.indexMeta);
  }

  private buildIndexMeta(provider: EmbeddingProvider, dimensions: number): EmbeddingIndexMetadata {
    const identity = provider.cacheIdentity;
    return {
      provider: identity?.provider ?? provider.name,
      model: identity?.model ?? provider.name,
      dimensions,
      cacheIdentity: identity ? JSON.stringify(identity) : provider.name,
    };
  }

  // ── IVF 索引管理 ──

  /** 强制重建 IVF 索引 */
  rebuildIndex(): void {
    const n = this.entries.length;
    if (n < 2) {
      this.ivf = null;
      return;
    }
    // K ≈ sqrt(n)/2，上限 512，下限 2
    const K = Math.max(2, Math.min(512, Math.round(Math.sqrt(n) / 2)));
    const t0 = Date.now();
    this.ivf = buildIvfIndex(this.entries, K);
    console.log(`[RAG] IVF index rebuilt: K=${K}, entries=${n}, took ${Date.now() - t0}ms`);
  }

  /** 检查是否需重建索引，每次数据库变化后调用 */
  private markIndexDirty(): void {
    this.ivf = null;
  }

  /** 搜索前确保索引可用（惰性重建） */
  private ensureIndex(): void {
    if (this.ivf) return;
    if (this.entries.length >= 2) {
      this.rebuildIndex();
    }
  }

  // ── 持久化钩子 ──

  private persistNow(change: StoreChange): void {
    try {
      const result = this.backend.persist(this.entries, change);
      if (result.needsReload) {
        this.reload();
      } else {
        const rev = this.backend.revision();
        if (rev !== null) this.cachedRevision = rev;
      }
    } catch (err) {
      console.warn("[RAG] failed to persist vector store:", err);
    }
  }

  // ── CRUD ──

  // 添加记忆（自动去重）
  async add(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    this.ensureFresh();
    this.validateDimensionsForProvider(provider);

    // 去重检查
    const existing = await this.search(text, source, provider, 1, 0.95);
    if (existing.length > 0) {
      // 跨进程安全：search 含 await（embed），完成后基于最新盘面更新权重
      this.ensureFresh();
      const fresh = this.entries.find((e) => e.id === existing[0].entry.id);
      if (fresh) {
        fresh.weight = Math.min(fresh.weight + 0.1, 5.0);
        fresh.lastRecalledAt = Date.now();
        this.persistNow({ kind: "recall", entries: [fresh] });
      }
      return fresh ?? existing[0].entry;
    }

    const embedding = await provider.embed(text);
    // embed 期间 .NET 侧可能已写入：基于最新盘面追加，避免整文件覆盖
    this.ensureFresh();
    // 首次成功写入后记录索引元数据
    this.ensureIndexMeta(provider, embedding.length);
    const entry: MemoryEntry = {
      id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      embedding,
      source,
      weight: 1.0,
      createdAt: Date.now(),
      lastRecalledAt: Date.now(),
      metadata,
    };

    this.entries.push(entry);
    this.markIndexDirty();
    this.persistNow({ kind: "insert", entries: [entry] });
    return entry;
  }

  async addUnique(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    this.ensureFresh();
    this.validateDimensionsForProvider(provider);
    const embedding = await provider.embed(text);
    this.ensureIndexMeta(provider, embedding.length);
    return this.addPreparedBatch([{ text, source, embedding, metadata }])[0];
  }

  // 批量添加（用于导入文档 chunk）
  async addBatch(
    items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>,
    provider: EmbeddingProvider,
    options?: { isCancelled?: () => boolean },
  ): Promise<MemoryEntry[]> {
    this.ensureFresh();
    this.validateDimensionsForProvider(provider);
    const results: MemoryEntry[] = [];
    const batchSize = 16;
    for (let start = 0; start < items.length; start += batchSize) {
      if (options?.isCancelled?.()) throw new Error("cancelled");
      const batch = items.slice(start, start + batchSize);
      const embeddings = await provider.embedBatch(batch.map((item) => item.text));
      if (options?.isCancelled?.()) throw new Error("cancelled");
      // 首次成功批量写入后记录索引元数据
      if (embeddings.length > 0) {
        this.ensureIndexMeta(provider, embeddings[0].length);
      }
      results.push(...this.addPreparedBatch(batch.map((item, index) => ({ ...item, embedding: embeddings[index] }))));
    }
    return results;
  }

  addPreparedBatch(
    items: Array<{ text: string; source: string; embedding: number[]; metadata?: Record<string, unknown> }>,
  ): MemoryEntry[] {
    // 跨进程安全：基于最新盘面做读-改-写（避免覆盖外部写入的条目）
    this.ensureFresh();
    const results: MemoryEntry[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry: MemoryEntry = {
        id: `${items[i].source}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        text: items[i].text,
        embedding: items[i].embedding,
        source: items[i].source,
        weight: 1.0,
        createdAt: Date.now(),
        lastRecalledAt: Date.now(),
        metadata: items[i].metadata,
      };
      this.entries.push(entry);
      results.push(entry);
    }

    this.markIndexDirty();
    this.persistNow({ kind: "insert", entries: results });
    return results;
  }

  // 搜索（使用 IVF 索引加速）
  async search(
    query: string,
    source?: string,
    provider?: EmbeddingProvider,
    topK = 5,
    minScore = 0.3,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    this.ensureFresh();
    if (this.entries.length === 0) return [];

    const embeddingProvider = provider ?? getEmbeddingProvider();
    if (!embeddingProvider) return [];

    this.validateDimensionsForProvider(embeddingProvider);

    const queryEmbedding = await embeddingProvider.embed(query);

    // 确保索引已构建
    this.ensureIndex();

    const now = Date.now();
    const results: SearchResult[] = [];
    const allowedImportIds = new Set(options.importIds ?? []);
    const allowedEntryIds = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const shouldKeep = (entry: MemoryEntry) =>
      (!allowedImportIds.size || allowedImportIds.has(String(entry.metadata?.importId ?? ""))) &&
      (!allowedEntryIds || allowedEntryIds.has(entry.id));

    if (this.ivf && !source) {
      // ── IVF 加速路径（无 source 过滤时） ──
      const K = this.ivf.centroids.length;
      // nprobe：搜索约 1/8 的簇（至少 2 个）
      const nprobe = Math.max(2, Math.round(K / 8));

      // 找最近的 nprobe 个簇
      const clusterDists: Array<{ idx: number; dist: number }> = [];
      for (let c = 0; c < K; c++) {
        const sim = cosineSimilarity(queryEmbedding, this.ivf.centroids[c]);
        clusterDists.push({ idx: c, dist: 1 - sim });
      }
      clusterDists.sort((a, b) => a.dist - b.dist);
      const probeClusters = new Set(clusterDists.slice(0, nprobe).map((c) => c.idx));

      // 只在选中簇内搜索
      for (const clusterIdx of probeClusters) {
        for (const entryIdx of this.ivf.clusters[clusterIdx]) {
          const entry = this.entries[entryIdx];
          if (!shouldKeep(entry)) continue;
          const sim = cosineSimilarity(queryEmbedding, entry.embedding);
          const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
          const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
          const weightedScore = sim * entry.weight * decayFactor;

          if (weightedScore >= minScore) {
            results.push({ entry, score: weightedScore });
          }
        }
      }
    } else {
      // ── 全量搜索路径（有 source 过滤时，或索引未就绪） ──
      for (const entry of this.entries) {
        if (source && entry.source !== source) continue;
        if (!shouldKeep(entry)) continue;

        const sim = cosineSimilarity(queryEmbedding, entry.embedding);
        // 时间衰减：24h 未提及权重 ×0.95
        const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
        const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
        const weightedScore = sim * entry.weight * decayFactor;

        if (weightedScore >= minScore) {
          results.push({ entry, score: weightedScore });
        }
      }
    }

    // 排序并取 topK
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    // 更新召回时间（仅对 topK 结果）
    if (top.length > 0) {
      // 跨进程安全：embed 期间外部可能已写入，先同步盘面再回写召回统计
      this.ensureFresh();
      const updated: MemoryEntry[] = [];
      for (const r of top) {
        const fresh = this.entries.find((e) => e.id === r.entry.id);
        if (!fresh) continue;
        fresh.lastRecalledAt = now;
        fresh.weight = Math.min(fresh.weight + 0.05, 5.0);
        updated.push(fresh);
      }
      if (updated.length > 0) {
        this.persistNow({ kind: "recall", entries: updated });
      }
    }

    return top;
  }

  // 清理低权重记忆
  prune(minWeight = 0.1): number {
    this.ensureFresh();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.weight >= minWeight);
    this.markIndexDirty();
    this.persistNow({ kind: "replace" });
    return before - this.entries.length;
  }

  deleteEntriesByIds(ids: string[], source?: string): number {
    this.ensureFresh();
    const idSet = new Set(ids);
    if (idSet.size === 0) return 0;
    const before = this.entries.length;
    const removed: string[] = [];
    this.entries = this.entries.filter((entry) => {
      const shouldRemove = idSet.has(entry.id) && (source === undefined || entry.source === source);
      if (shouldRemove) removed.push(entry.id);
      return !shouldRemove;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.markIndexDirty();
      this.persistNow({ kind: "remove", ids: removed });
    }
    return deleted;
  }

  // 删除导入文档
  deleteImportedDoc(importId: string, fileName?: string): number {
    this.ensureFresh();
    const before = this.entries.length;
    const removed: string[] = [];
    this.entries = this.entries.filter((e) => {
      if (e.source !== "imported_doc") return true;
      // 新数据：按 importId 精确匹配
      if (e.metadata?.importId) {
        const match = e.metadata.importId === importId;
        if (match) removed.push(e.id);
        return !match;
      }
      // 旧数据：按 fileName 匹配
      if (fileName && e.metadata?.fileName === fileName) {
        removed.push(e.id);
        return false;
      }
      return true;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.markIndexDirty();
      this.persistNow({ kind: "remove", ids: removed });
    }
    return deleted;
  }

  hasImportedDocumentChunks(importId: string): boolean {
    return this.entries.some(
      (entry) => entry.source === "imported_doc" && String(entry.metadata?.importId ?? "") === importId,
    );
  }

  /**
   * 清空全部条目 + 索引元数据（换 embedding 模型维度不匹配时使用）。
   * 同时清理迁移用 JSON，避免下次启动把旧条目迁回。
   */
  clearAll(): number {
    this.ensureFresh();
    const removed = this.entries.length;
    this.entries = [];
    this.markIndexDirty();
    this.indexMeta = null;
    this.persistNow({ kind: "replace" });
    this.backend.saveMeta(null);
    this.backend.resetLegacy();
    return removed;
  }

  /** 释放后端资源（SQLite 连接；进程退出/测试重置时调用）。 */
  dispose(): void {
    this.backend.dispose();
  }

  // 统计
  get stats() {
    const sources: Record<string, number> = {};
    for (const e of this.entries) {
      sources[e.source] = (sources[e.source] || 0) + 1;
    }
    return { total: this.entries.length, sources };
  }
}

// ── 具体实现 ──

/** JSON 整文件实现（回退路径；CYRENE_RAG_STORE=json 或 node:sqlite 不可用时）。 */
export class JsonVectorStore extends VectorStore {
  constructor(dbPath: string) {
    super(dbPath, new JsonStoreBackend(dbPath), "json");
  }
}

/**
 * SQLite 实现（默认路径）：行级写 + WAL + rev 版本号。
 * driver 可注入（测试环境 ESM 下用 createRequire 拿到 node:sqlite）。
 */
export class SqliteVectorStore extends VectorStore {
  constructor(dbPath: string, driver?: NodeSqliteModule) {
    const resolved = driver ?? loadNodeSqliteModule();
    if (!resolved) {
      throw new Error("node:sqlite is not available in this runtime");
    }
    super(dbPath, new SqliteStoreBackend(dbPath, resolved), "sqlite");
  }
}

// ── 工厂：按 env / 运行时可用来选实现 ──
let activeStoreMode: VectorStoreMode = "sqlite";

export function getChosenStoreMode(): VectorStoreMode {
  return activeStoreMode;
}

export function createVectorStore(dbPath: string): VectorStore {
  const requested = (process.env.CYRENE_RAG_STORE ?? "").toLowerCase();
  let store: VectorStore;
  if (requested === "json") {
    store = new JsonVectorStore(dbPath);
  } else if (isSqliteStoreAvailable()) {
    store = new SqliteVectorStore(dbPath);
  } else {
    if (requested === "sqlite") {
      console.warn("[RAG] CYRENE_RAG_STORE=sqlite but node:sqlite is unavailable; falling back to json");
    }
    store = new JsonVectorStore(dbPath);
  }
  activeStoreMode = store.mode;
  return store;
}

/**
 * 一致性备份 SQLite 库（VACUUM INTO；WAL 下安全，目标文件须不存在）。
 * 供记忆对账备份使用；driver 不可用时返回 false（调用方跳过）。
 */
export function backupSqliteStore(dbPath: string, targetPath: string): boolean {
  const driver = loadNodeSqliteModule();
  if (!driver) return false;
  try {
    const db = new driver.DatabaseSync(dbPath);
    try {
      db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    return true;
  } catch (error) {
    console.warn("[RAG] sqlite backup failed:", error);
    return false;
  }
}
