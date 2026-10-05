// VectorStore.reembedAll（模型迁移原地重嵌入）双后端回归：
// 不清库、按 id 原地替换 embedding、保留文本/权重/metadata、更新 index_meta、
// 跨实例持久化可见（sqlite 行级 UPDATE / json 整文件原子写）。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { JsonVectorStore, SqliteVectorStore, type NodeSqliteModule } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

const requireCjs = createRequire(import.meta.url);
const sqliteDriver = requireCjs("node:sqlite") as NodeSqliteModule;

function makeProvider(model: string, dims: number): EmbeddingProvider {
  const vec = (text: string) => {
    const arr = new Array<number>(dims).fill(0);
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    arr[h % dims] = 1;
    return arr;
  };
  return {
    name: "local-" + model.split("/").pop(),
    dims,
    declaredDimensions: dims,
    resolvedDimensions: dims,
    cacheIdentity: { provider: "local", model, dimensions: dims },
    async embed(text: string) { return vec(text); },
    async embedBatch(texts: string[]) { return texts.map(vec); },
  };
}

const tempDirs: string[] = [];
const stores: Array<{ dispose(): void }> = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-reembed-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.dispose(); } catch { /* ignore */ }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const backends = [
  {
    label: "json",
    create: (dir: string) => {
      const store = new JsonVectorStore(dir);
      stores.push(store);
      return store;
    },
  },
  {
    label: "sqlite",
    create: (dir: string) => {
      const store = new SqliteVectorStore(dir, sqliteDriver);
      stores.push(store);
      return store;
    },
  },
] as const;

describe.each(backends)("reembedAll: $label", ({ create }) => {
  it("原地替换 embedding + 更新 meta + 跨实例可见", async () => {
    const dir = makeDir();
    const store = create(dir);
    const oldProvider = makeProvider("Xenova/bge-m3", 8);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: new Array(8).fill(0.1), metadata: { l2Id: "l2_a" } },
      { text: "beta", source: "imported_doc", embedding: new Array(8).fill(0.2), metadata: { importId: "imp_1" } },
      { text: "gamma", source: "user_memory", embedding: new Array(8).fill(0.3) },
    ]);
    store.setIndexMetaForProvider(oldProvider);

    const newProvider = makeProvider("Xenova/multilingual-e5-small", 3);
    const rebuilt = await store.reembedAll(newProvider, { batchSize: 2 });

    expect(rebuilt).toBe(3);
    const entries = (store as unknown as { entries: Array<{ id: string; text: string; embedding: number[]; weight: number; metadata?: Record<string, unknown> }> }).entries;
    expect(entries.map((entry) => entry.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(entries.every((entry) => entry.embedding.length === 3)).toBe(true);
    expect(entries.every((entry) => entry.weight === 1)).toBe(true);
    expect(entries[0].metadata).toEqual({ l2Id: "l2_a" });
    expect(store.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });

    // 跨实例持久化可见（sqlite 行更新 / json 整文件写）
    store.dispose();
    const reopened = create(dir);
    const reloaded = (reopened as unknown as { entries: Array<{ embedding: number[] }> }).entries;
    expect(reloaded).toHaveLength(3);
    expect(reloaded.every((entry) => entry.embedding.length === 3)).toBe(true);
    expect(reopened.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });
  });

  it("同维不同模型：按模型身份全量重嵌（P1-3，不因维度相同空转）", async () => {
    const dir = makeDir();
    const store = create(dir);
    // 旧索引：与目标同维（3），但模型身份不同
    const oldProvider = makeProvider("openai/text-embedding-3", 3);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
      { text: "beta", source: "user_memory", embedding: [0.4, 0.5, 0.6] },
    ]);
    store.setIndexMetaForProvider(oldProvider);

    const newProvider = makeProvider("Xenova/multilingual-e5-small", 3);
    const rebuilt = await store.reembedAll(newProvider);

    // 旧实现按 entry.embedding.length !== 3 筛选会得到 0
    expect(rebuilt).toBe(2);
    const entries = (store as unknown as { entries: Array<{ embedding: number[] }> }).entries;
    expect(entries[0].embedding).not.toEqual([0.1, 0.2, 0.3]);
    expect(store.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });

    // 身份一致后再次调用：默认不再重嵌（幂等，无需 force）
    expect(await store.reembedAll(newProvider)).toBe(0);
  });

  it("持久化失败：抛错、meta 不更新、内存向量回滚（P2-1）", async () => {
    const dir = makeDir();
    const store = create(dir);
    const oldProvider = makeProvider("Xenova/bge-m3", 3);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(oldProvider);

    const backend = (store as unknown as { backend: { persist: (...args: unknown[]) => unknown } }).backend;
    const spy = vi.spyOn(backend, "persist").mockImplementation(() => {
      throw new Error("disk full");
    });

    const newProvider = makeProvider("Xenova/multilingual-e5-small", 3);
    await expect(store.reembedAll(newProvider)).rejects.toThrow(/disk full/);

    // 不能出现「磁盘旧向量 + 新模型 meta」：meta 保持旧身份，内存向量回滚
    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
    const entries = (store as unknown as { entries: Array<{ embedding: number[] }> }).entries;
    expect(entries[0].embedding).toEqual([0.1, 0.2, 0.3]);
    spy.mockRestore();
  });

  it("空库：返回 0 并写入目标模型 meta", async () => {
    const dir = makeDir();
    const store = create(dir);
    const provider = makeProvider("Xenova/multilingual-e5-small", 3);

    const rebuilt = await store.reembedAll(provider);
    expect(rebuilt).toBe(0);
    expect(store.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });
  });

  it("取消：抛错且不落盘（条目保持旧维度）", async () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: new Array(8).fill(0.1) },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 8));

    await expect(
      store.reembedAll(makeProvider("Xenova/multilingual-e5-small", 3), { isCancelled: () => true }),
    ).rejects.toThrow(/cancelled/);

    const entries = (store as unknown as { entries: Array<{ embedding: number[] }> }).entries;
    expect(entries.every((entry) => entry.embedding.length === 8)).toBe(true);
    expect(store.getIndexMeta()?.model).toBe("Xenova/bge-m3");
  });
});
