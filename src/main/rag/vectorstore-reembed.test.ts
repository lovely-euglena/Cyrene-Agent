// VectorStore.reembedAll（模型迁移原地重嵌入）双后端回归：
// 不清库、按 id 原地替换 embedding、保留文本/权重/metadata、更新 index_meta、
// 跨实例持久化可见（sqlite 行级 UPDATE / json 整文件原子写）。
//
// P1-1（复审）：失败注入针对真实后端契约层——
//   - JSON：mock fs.writeFileSync 按目标文件抛错；
//   - SQLite：包装 db.exec / db.prepare 使写路径抛错；
// 断言 persist 返回 failed、saveMeta 返回 false、reembedAll 回滚且 meta 未更新。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { JsonVectorStore, SqliteVectorStore, type NodeSqliteModule } from "./vectorstore";
import type { EmbeddingIndexMetadata, EmbeddingProvider } from "./embedding";

// 真实写路径失败注入开关（JSON 后端；vi.mock 工厂在 hoist 期读取）。
const fsState = vi.hoisted(() => ({
  writeFailure: null as null | "all" | "meta",
  /** rename 恒 EPERM（触发直写回退）；unlink 失败（P2-2① 清理失败场景）。 */
  renameContended: false,
  unlinkFailure: false,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const target = String(args[0]);
      if (
        fsState.writeFailure === "all" ||
        (fsState.writeFailure === "meta" && target.includes("memory-store-meta"))
      ) {
        throw new Error("disk full (injected)");
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsState.renameContended) {
        const err = new Error("EPERM (injected)") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (fsState.unlinkFailure) throw new Error("EACCES (injected)");
      return actual.unlinkSync(...args);
    },
  };
});

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

interface BackendShape {
  persist: (all: unknown[], change: unknown) => { needsReload: boolean; failed?: boolean };
  saveMeta: (meta: EmbeddingIndexMetadata | null) => boolean;
  db?: {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };
  };
}

interface StoreShape {
  backend: BackendShape;
  entries: Array<{ id: string; text: string; embedding: number[]; weight: number; metadata?: Record<string, unknown> }>;
}

function backendOf(store: object): BackendShape {
  return (store as unknown as StoreShape).backend;
}

function entriesOf(store: object): StoreShape["entries"] {
  return (store as unknown as StoreShape).entries;
}

/** JSON 后端：按目标文件让真实写路径抛错（"all" 全失败 / "meta" 仅 meta 失败）。 */
function injectJsonWriteFailure(mode: "all" | "meta"): () => void {
  fsState.writeFailure = mode;
  return () => { fsState.writeFailure = null; };
}

/** SQLite 后端：包装 db.exec / db.prepare 让真实写路径抛错（读路径保持可用）。 */
function injectSqliteWriteFailure(store: SqliteVectorStore, mode: "all" | "meta"): () => void {
  const db = backendOf(store).db;
  if (!db) throw new Error("sqlite backend db unavailable");
  const realExec = db.exec.bind(db);
  const realPrepare = db.prepare.bind(db);
  const failingStatement = (stmt: { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }) => ({
    run: () => { throw new Error("disk full (injected)"); },
    get: (...args: unknown[]) => stmt.get(...args),
    all: (...args: unknown[]) => stmt.all(...args),
  });
  db.exec = (sql: string) => {
    if (mode === "all") throw new Error("disk full (injected)");
    return realExec(sql);
  };
  db.prepare = (sql: string) => {
    const stmt = realPrepare(sql);
    if (mode === "all" || (mode === "meta" && /INSERT INTO rag_meta/i.test(sql))) {
      return failingStatement(stmt);
    }
    return stmt;
  };
  return () => {
    db.exec = realExec;
    db.prepare = realPrepare;
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
  fsState.writeFailure = null;
  fsState.renameContended = false;
  fsState.unlinkFailure = false;
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
    injectWriteFailure: (_store: object, mode: "all" | "meta") => injectJsonWriteFailure(mode),
  },
  {
    label: "sqlite",
    create: (dir: string) => {
      const store = new SqliteVectorStore(dir, sqliteDriver);
      stores.push(store);
      return store;
    },
    injectWriteFailure: (store: object, mode: "all" | "meta") =>
      injectSqliteWriteFailure(store as SqliteVectorStore, mode),
  },
] as const;

describe.each(backends)("reembedAll: $label", ({ create, injectWriteFailure }) => {
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
    const entries = entriesOf(store);
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
    const reloaded = entriesOf(reopened);
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
    const entries = entriesOf(store);
    expect(entries[0].embedding).not.toEqual([0.1, 0.2, 0.3]);
    expect(store.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });

    // 身份一致后再次调用：默认不再重嵌（幂等，无需 force）
    expect(await store.reembedAll(newProvider)).toBe(0);
  });

  it("真实后端契约：写失败经 persist.failed / saveMeta=false 显式上报（P1-1）", () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 3));

    const backend = backendOf(store);
    const restore = injectWriteFailure(store, "all");
    try {
      expect(backend.persist(entriesOf(store), { kind: "replace" })).toMatchObject({ failed: true });
      expect(backend.saveMeta({ provider: "local", model: "Xenova/bge-m3", dimensions: 3 })).toBe(false);
    } finally {
      restore();
    }
  });

  it("persist 失败：reembedAll 抛错、内存回滚、meta 与磁盘保持旧值（P1-1）", async () => {
    const dir = makeDir();
    const store = create(dir);
    const oldProvider = makeProvider("Xenova/bge-m3", 3);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(oldProvider);

    const restore = injectWriteFailure(store, "all");
    try {
      const newProvider = makeProvider("Xenova/multilingual-e5-small", 3);
      await expect(store.reembedAll(newProvider)).rejects.toThrow(/write failure/);
    } finally {
      restore();
    }

    // 不能出现「磁盘旧向量 + 新模型 meta」：meta 保持旧身份，内存向量回滚
    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
    expect(entriesOf(store)[0].embedding).toEqual([0.1, 0.2, 0.3]);

    // 磁盘也未被写坏：重开仍是旧向量 + 旧 meta（sqlite 经 Float32 往返，按精度比对）
    store.dispose();
    const reopened = create(dir);
    expect(reopened.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
    expect(entriesOf(reopened)[0].embedding.map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.2, 0.3]);
  });

  it("meta 写失败：reembedAll 抛错、内存回滚并恢复磁盘旧向量（P1-1）", async () => {
    const dir = makeDir();
    const store = create(dir);
    const oldProvider = makeProvider("Xenova/bge-m3", 3);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(oldProvider);

    const restore = injectWriteFailure(store, "meta");
    try {
      const newProvider = makeProvider("Xenova/multilingual-e5-small", 3);
      await expect(store.reembedAll(newProvider)).rejects.toThrow(/metadata/);
    } finally {
      restore();
    }

    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
    expect(entriesOf(store)[0].embedding).toEqual([0.1, 0.2, 0.3]);

    // 补偿写回旧向量：磁盘保持旧向量 + 旧 meta（重开校验，按 Float32 精度比对）
    store.dispose();
    const reopened = create(dir);
    expect(reopened.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
    expect(entriesOf(reopened)[0].embedding.map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.2, 0.3]);
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

  it("旧 meta 无 cacheIdentity：模型未变不全量、模型变了全量（P2-5）", async () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
      { text: "beta", source: "user_memory", embedding: [0.4, 0.5, 0.6] },
    ]);
    // 模拟升级前旧 meta：无 cacheIdentity 字段
    expect(backendOf(store).saveMeta({ provider: "local", model: "Xenova/bge-m3", dimensions: 3 })).toBe(true);
    store.reload();

    // 模型未变（meta.model = identity.model）：不全量重嵌（维度也一致 → 0）
    expect(await store.reembedAll(makeProvider("Xenova/bge-m3", 3))).toBe(0);

    // 旧命名（meta.model = provider.name）：同样视为未变
    expect(backendOf(store).saveMeta({ provider: "local-bge-m3", model: "local-bge-m3", dimensions: 3 })).toBe(true);
    store.reload();
    expect(await store.reembedAll(makeProvider("Xenova/bge-m3", 3))).toBe(0);

    // 模型变了（同维、无 cacheIdentity 可比）：仍全量重嵌
    expect(backendOf(store).saveMeta({ provider: "local", model: "Xenova/bge-m3", dimensions: 3 })).toBe(true);
    store.reload();
    expect(await store.reembedAll(makeProvider("Xenova/multilingual-e5-small", 3))).toBe(2);
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

    const entries = entriesOf(store);
    expect(entries.every((entry) => entry.embedding.length === 8)).toBe(true);
    expect(store.getIndexMeta()?.model).toBe("Xenova/bge-m3");
  });

  it("最后一批 embed 期间置取消位：提交前检查生效，不提交、不写 meta（P2-3①）", async () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: new Array(8).fill(0.1) },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 8));

    // 单批场景：embed 挂起期间置取消位，只有提交前检查（reembedAll 末尾）能拦下
    const provider = makeProvider("Xenova/multilingual-e5-small", 3);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalBatch = provider.embedBatch.bind(provider);
    provider.embedBatch = async (texts: string[]) => {
      markStarted();
      await gate;
      return originalBatch(texts);
    };

    let cancelled = false;
    const pending = store.reembedAll(provider, { isCancelled: () => cancelled });
    await started;
    cancelled = true;
    release();

    await expect(pending).rejects.toThrow(/cancelled/);

    expect(entriesOf(store).every((entry) => entry.embedding.length === 8)).toBe(true);
    expect(store.getIndexMeta()?.model).toBe("Xenova/bge-m3");

    // 磁盘同样未提交（重开校验）
    store.dispose();
    const reopened = create(dir);
    expect(entriesOf(reopened).every((entry) => entry.embedding.length === 8)).toBe(true);
    expect(reopened.getIndexMeta()?.model).toBe("Xenova/bge-m3");
  });

  it("无 meta 推断补写失败：内存 meta 保持 null，下次写入再试（P2-2③）", async () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    expect(store.getIndexMeta()).toBeNull();

    const provider = makeProvider("Xenova/bge-m3", 3);
    const restore = injectWriteFailure(store, "meta");
    try {
      await store.add("beta", "user_memory", provider);
    } finally {
      restore();
    }

    // 写盘失败不能赋内存 meta（与 ensureIndexMeta 同口径）
    expect(store.getIndexMeta()).toBeNull();

    // 故障恢复后下一次写入补记 meta
    await store.add("gamma", "user_memory", provider);
    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3", dimensions: 3 });
  });

  it("clearAll strict：meta 写失败 → 抛错，内存与磁盘回滚到清空前（P2-1）", () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 3));

    const restore = injectWriteFailure(store, "meta");
    try {
      expect(() =>
        store.clearAll({
          strict: true,
          nextProvider: makeProvider("Xenova/multilingual-e5-small", 3),
        }),
      ).toThrow(/metadata/);
    } finally {
      restore();
    }

    // 内存：条目与 meta 保持旧值；磁盘同样（重开校验）
    expect(entriesOf(store)).toHaveLength(1);
    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3" });

    store.dispose();
    const reopened = create(dir);
    expect(entriesOf(reopened)).toHaveLength(1);
    expect(reopened.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3" });
  });

  it("clearAll strict 成功：清空并直接写入新 provider meta（P2-1）", () => {
    const dir = makeDir();
    const store = create(dir);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 3));

    expect(
      store.clearAll({
        strict: true,
        nextProvider: makeProvider("Xenova/multilingual-e5-small", 3),
      }),
    ).toBe(1);
    expect(store.stats.total).toBe(0);
    expect(store.getIndexMeta()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
    });

    store.dispose();
    const reopened = create(dir);
    expect(reopened.stats.total).toBe(0);
    expect(reopened.getIndexMeta()).toMatchObject({ model: "Xenova/multilingual-e5-small" });
  });
});

describe("窄失败路径：JSON 直写回退 / sqlite rev 读取 / needsReload 回滚", () => {
  it("json：主文件已直写成功、tmp 清理失败 → failed:false（P2-2①）", () => {
    const dir = makeDir();
    const store = new JsonVectorStore(dir);
    stores.push(store);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [1, 0] },
    ]);
    const backend = backendOf(store);

    fsState.renameContended = true;
    fsState.unlinkFailure = true;
    try {
      const result = backend.persist(entriesOf(store), { kind: "replace" });
      // 直写已提交：不能因 tmp 清理失败误报 failed（否则调用方回滚内存且不写 meta）
      expect(result).toEqual({ needsReload: false, failed: false });
    } finally {
      fsState.renameContended = false;
      fsState.unlinkFailure = false;
    }

    // 主文件已更新，重开可读；tmp 残留不影响
    const reopened = new JsonVectorStore(dir);
    stores.push(reopened);
    expect(entriesOf(reopened)).toHaveLength(1);
  });

  it("sqlite：COMMIT 后 rev 读取失败 → needsReload:true，不异常逃逸（P2-2②）", () => {
    const dir = makeDir();
    const store = new SqliteVectorStore(dir, sqliteDriver);
    stores.push(store);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [1, 0] },
    ]);
    const backend = backendOf(store);
    const db = backend.db;
    if (!db) throw new Error("sqlite backend db unavailable");

    const realPrepare = db.prepare.bind(db);
    let revReads = 0;
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      return {
        run: (...args: unknown[]) => stmt.run(...args),
        all: (...args: unknown[]) => stmt.all(...args),
        get: (...args: unknown[]) => {
          if (args[0] === "rev") {
            revReads++;
            // 第 1 次 = 事务前 pre（成功），第 2 次 = COMMIT 后 post（注入失败）
            if (revReads >= 2) throw new Error("rev read failed (injected)");
          }
          return stmt.get(...args);
        },
      };
    };
    try {
      const result = backend.persist(entriesOf(store), { kind: "recall", entries: [] });
      expect(result).toEqual({ needsReload: true, failed: false });
    } finally {
      db.prepare = realPrepare;
    }
  });

  it("sqlite：persist needsReload 替换 entries 后 meta 写失败 → 按 id 回滚内存与磁盘（P2-2④）", async () => {
    const dir = makeDir();
    const store = new SqliteVectorStore(dir, sqliteDriver);
    stores.push(store);
    store.addPreparedBatch([
      { text: "alpha", source: "user_memory", embedding: [0.1, 0.2, 0.3] },
    ]);
    store.setIndexMetaForProvider(makeProvider("Xenova/bge-m3", 3));

    const backend = backendOf(store);
    const db = backend.db;
    if (!db) throw new Error("sqlite backend db unavailable");
    const realPersist = backend.persist.bind(backend);
    // 模拟提交期间有外部提交：真实 persist 后 rev 再跳 1，等价于 needsReload 分支
    backend.persist = (all: unknown[], change: unknown) => {
      const result = realPersist(all, change);
      if ((change as { kind?: string }).kind === "reembed" && result.failed !== true) {
        db.exec("UPDATE rag_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'");
        return { needsReload: true, failed: false };
      }
      return result;
    };

    const restoreMeta = injectSqliteWriteFailure(store, "meta");
    try {
      await expect(
        store.reembedAll(makeProvider("Xenova/multilingual-e5-small", 3)),
      ).rejects.toThrow(/metadata/);
    } finally {
      restoreMeta();
      backend.persist = realPersist;
    }

    // needsReload 已替换 this.entries；回滚必须按 id 从当前 entries 重定位，
    // 否则内存保留新向量（磁盘已恢复旧向量）直到下次重载
    expect(entriesOf(store)[0].embedding.map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.2, 0.3]);
    expect(store.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3" });

    store.dispose();
    const reopened = new SqliteVectorStore(dir, sqliteDriver);
    stores.push(reopened);
    expect(entriesOf(reopened)[0].embedding.map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.2, 0.3]);
    expect(reopened.getIndexMeta()).toMatchObject({ model: "Xenova/bge-m3" });
  });
});
