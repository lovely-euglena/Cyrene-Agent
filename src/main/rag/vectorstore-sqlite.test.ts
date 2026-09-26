import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import {
  JsonVectorStore,
  SqliteVectorStore,
  createVectorStore,
  getChosenStoreMode,
  type MemoryEntry,
  type NodeSqliteModule,
} from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

// SQLite 向量库（默认路径）回归：迁移 / rev 新鲜度 / 召回回写 / 检索对账 / 软合并 /
// clearAll。驱动直接注入（测试为 ESM，模块内部走 process.getBuiltinModule）。

const requireCjs = createRequire(import.meta.url);
const sqliteDriver = requireCjs("node:sqlite") as NodeSqliteModule;

function makeEntry(i: number): MemoryEntry {
  return {
    id: `seed_${i}`,
    text: i % 2 === 0 ? `alpha doc ${i}` : `beta doc ${i}`,
    embedding: Array.from({ length: 8 }, (_, d) => Math.fround(Math.sin(i * 0.7 + d * 0.3))),
    source: i % 4 === 0 ? "imported_doc" : "user_memory",
    weight: 1,
    createdAt: 1_700_000_000_000 + i,
    lastRecalledAt: 1_700_000_000_000 + i,
    metadata: i % 4 === 0 ? { importId: `imp_${i}` } : undefined,
  };
}

const provider: EmbeddingProvider = {
  name: "deterministic",
  async embed(text: string): Promise<number[]> {
    return text === "query" ? makeEntry(3).embedding : makeEntry(0).embedding;
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  },
};

/** 指定查询向量的 provider（维度需与目标条目一致，cosine 按 query 长度点积）。 */
function fixedProvider(vector: number[]): EmbeddingProvider {
  return {
    name: "fixed",
    async embed(): Promise<number[]> {
      return vector;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(() => vector);
    },
  };
}

const tempDirs: string[] = [];
const stores: Array<{ dispose(): void }> = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-sqlite-test-"));
  tempDirs.push(dir);
  return dir;
}

function createStore(dir = makeDir()): SqliteVectorStore {
  const store = new SqliteVectorStore(dir, sqliteDriver);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SqliteVectorStore", () => {
  it("insert/load 往返：float32 无损 + metadata + 跨实例可见", async () => {
    const dir = makeDir();
    const store = createStore(dir);
    const [entry] = store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.5, -0.25, 0], metadata: { l2Id: "l2_x" } },
    ]);
    expect(fs.existsSync(path.join(dir, "memory.db"))).toBe(true);

    const reopened = createStore(dir);
    expect(reopened.stats.total).toBe(1);
    const results = await reopened.search("alpha", "user_memory", fixedProvider([1, 0, 0]), 5, 0.0);
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe(entry.id);
    // float32 往返无损（float32-exact 值经 BLOB 读回不变）
    expect(results[0].entry.embedding).toEqual(entry.embedding);
    expect(results[0].entry.metadata).toEqual({ l2Id: "l2_x" });
  });

  it("从 memory-store.json 一次性迁移（保留原文件作回滚快照）", () => {
    const dir = makeDir();
    const json = new JsonVectorStore(dir);
    stores.push(json);
    json.addPreparedBatch([makeEntry(0), makeEntry(1)]);
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(true);

    const sqlite = createStore(dir);
    expect(sqlite.stats.total).toBe(2);
    // 原文件保留（回滚快照），后续不重复迁移
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(true);
    const reopened = createStore(dir);
    expect(reopened.stats.total).toBe(2);
  });

  it("rev 新鲜度：另一实例写入后 ensureFresh 可见", () => {
    const dir = makeDir();
    const a = createStore(dir);
    const b = createStore(dir);
    b.addPreparedBatch([{ text: "alpha", source: "user_memory", embedding: [1, 0] }]);

    expect(a.stats.total).toBe(0);
    a.ensureFresh();
    expect(a.stats.total).toBe(1);
  });

  it("召回回写跨实例可见", async () => {
    const dir = makeDir();
    const a = createStore(dir);
    const b = createStore(dir);
    a.addPreparedBatch([{ text: "alpha", source: "user_memory", embedding: [1, 0] }]);

    const results = await a.search("alpha", "user_memory", fixedProvider([1, 0]), 5, 0.1);
    expect(results).toHaveLength(1);

    b.ensureFresh();
    const entryInB = (b as unknown as { entries: MemoryEntry[] }).entries[0];
    expect(entryInB.weight).toBeGreaterThan(1);
  });

  it("检索结果与 JsonVectorStore 精确对账（全量路径）", async () => {
    const dirJson = makeDir();
    const dirSqlite = makeDir();
    const entries = [makeEntry(0), makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4), makeEntry(5), makeEntry(6), makeEntry(7)];
    const json = new JsonVectorStore(dirJson);
    stores.push(json);
    json.addPreparedBatch(entries);
    const sqlite = createStore(dirSqlite);
    sqlite.addPreparedBatch(entries);

    // 预热：让两侧召回权重进入同一状态（TS search 固定回写 topK，权重会影响打分）
    await json.search("query", "user_memory", provider, 100, 0.0);
    await sqlite.search("query", "user_memory", provider, 100, 0.0);

    const fromJson = await json.search("query", "user_memory", provider, 5, 0.0);
    const fromSqlite = await sqlite.search("query", "user_memory", provider, 5, 0.0);

    expect(fromSqlite.length).toBeGreaterThan(0);
    expect(fromSqlite.length).toBe(fromJson.length);
    // id 由 addPreparedBatch 各自生成（时间戳+随机后缀）→ 按文本与分数对账
    // 容差 1e-6：两侧召回时间戳相差毫秒级，衰减因子带来 ~1e-9 量级差异
    fromSqlite.forEach((r, i) => {
      expect(r.entry.text).toBe(fromJson[i].entry.text);
      expect(r.score).toBeCloseTo(fromJson[i].score, 6);
    });
  });

  it("JSON 更新更晚时软合并缺失条目（不覆盖库内数据）", () => {
    const dir = makeDir();
    const sqlite = createStore(dir);
    sqlite.addPreparedBatch([{ text: "alpha", source: "user_memory", embedding: [1, 0] }]);

    // 模拟 json 回退模式期间写入：JSON 含一条库内没有的条目
    const legacyFile = path.join(dir, "memory-store.json");
    fs.writeFileSync(legacyFile, JSON.stringify([makeEntry(9)], null, 2), "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(legacyFile, future, future);

    const reopened = createStore(dir);
    expect(reopened.stats.total).toBe(2);
    expect(reopened.stats.sources.user_memory).toBe(2);
  });

  it("clearAll 清空条目并删除迁移 JSON（不会被迁回）", () => {
    const dir = makeDir();
    const json = new JsonVectorStore(dir);
    stores.push(json);
    json.addPreparedBatch([makeEntry(0)]);

    const sqlite = createStore(dir);
    expect(sqlite.stats.total).toBe(1);
    expect(sqlite.clearAll()).toBe(1);
    expect(sqlite.stats.total).toBe(0);
    expect(fs.existsSync(path.join(dir, "memory-store.json"))).toBe(false);

    const reopened = createStore(dir);
    expect(reopened.stats.total).toBe(0);
  });

  it("createVectorStore：env=json 用 JsonVectorStore；默认选 sqlite", () => {
    const previous = process.env.CYRENE_RAG_STORE;
    try {
      process.env.CYRENE_RAG_STORE = "json";
      const jsonStore = createVectorStore(makeDir());
      stores.push(jsonStore);
      expect(jsonStore.mode).toBe("json");
      expect(getChosenStoreMode()).toBe("json");

      delete process.env.CYRENE_RAG_STORE;
      const defaultStore = createVectorStore(makeDir());
      stores.push(defaultStore);
      expect(defaultStore.mode).toBe("sqlite");
      expect(getChosenStoreMode()).toBe("sqlite");
    } finally {
      if (previous === undefined) {
        delete process.env.CYRENE_RAG_STORE;
      } else {
        process.env.CYRENE_RAG_STORE = previous;
      }
    }
  });
});
