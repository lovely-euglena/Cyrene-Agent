import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonVectorStore, type MemoryEntry } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

// ── 跨进程一致性回归（TS 与 .NET sidecar 双写同一 memory-store.json） ──
// 端到端自测抓出的两类问题在此固化为回归：
//   1. 陈旧内存副本整文件刷盘 → 覆盖 sidecar 并发写入的条目
//   2. 非原子写 / 解析失败后不重置快照 → 读到半截 JSON 后永不重试，反向覆盖
// 「embed 期间外部写盘」用自定义 provider 模拟 sidecar 的并发写入时机。

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("alpha") ? [1, 0] : [0, 1];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const tempDirs: string[] = [];

function createStore(): { store: JsonVectorStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-vectorstore-xproc-"));
  tempDirs.push(dir);
  return { store: new JsonVectorStore(dir), file: path.join(dir, "memory-store.json") };
}

function readEntries(file: string): MemoryEntry[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as MemoryEntry[];
}

function writeEntries(file: string, entries: MemoryEntry[]): void {
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("JsonVectorStore 跨进程一致性", () => {
  it("add() 以最新盘面为基准追加，不回滚 embed 期间的外部写入", async () => {
    const { store, file } = createStore();
    // seed 用 [0,1]，避免与查询 "alpha memory"（[1,0]）的 0.95 去重阈值相撞
    const [seed] = store.addPreparedBatch([{ text: "seed", source: "user_memory", embedding: [0, 1] }]);

    // 模拟 sidecar 在 embed 期间写入一条导入块（只写一次，避免去重 search 的重复 embed 叠加）
    const providerWithExternalWrite: EmbeddingProvider = {
      ...provider,
      async embed(): Promise<number[]> {
        const current = readEntries(file);
        if (!current.some((e) => e.id === "imported_doc_ext")) {
          current.push({
            ...current[0],
            id: "imported_doc_ext",
            text: "external imported chunk",
            source: "imported_doc",
            embedding: [0, 1],
          });
          writeEntries(file, current);
        }
        return [1, 0];
      },
    };

    await store.add("alpha memory", "user_memory", providerWithExternalWrite);

    const ids = readEntries(file).map((e) => e.id);
    expect(ids).toContain(seed.id);
    // 修复前：整文件覆盖 → 外部条目丢失
    expect(ids).toContain("imported_doc_ext");
    expect(ids).toHaveLength(3);
  });

  it("search() 的召回回写不清掉外部并发写入，且回写生效", async () => {
    const { store, file } = createStore();
    const [entry] = store.addPreparedBatch([{ text: "alpha memory", source: "user_memory", embedding: [1, 0] }]);

    // 外部（sidecar 导入）写入新块
    const current = readEntries(file);
    current.push({
      ...current[0],
      id: "imported_doc_ext2",
      text: "external imported chunk 2",
      source: "imported_doc",
      embedding: [0, 1],
    });
    writeEntries(file, current);

    const results = await store.search("alpha", "user_memory", provider, 5, 0.1);
    expect(results.map((r) => r.entry.id)).toContain(entry.id);

    const entries = readEntries(file);
    // 修复前：embed 期间的搜索回写整库覆盖 → 外部条目丢失
    expect(entries.map((e) => e.id)).toContain("imported_doc_ext2");
    const recalled = entries.find((e) => e.id === entry.id)!;
    expect(recalled.weight).toBeGreaterThan(1);
    expect(recalled.lastRecalledAt).toBeGreaterThanOrEqual(recalled.createdAt);
  });

  it("解析失败后重置磁盘快照：同尺寸同 mtime 的外部修复仍能被重载", () => {
    const { store, file } = createStore();
    const fixedTime = new Date(Date.now() - 60_000);

    // 合法内容（11 字节）：[1] + 填充
    fs.writeFileSync(file, "[1]      ", "utf8");
    fs.utimesSync(file, fixedTime, fixedTime);
    store.ensureFresh();
    expect(store.stats.total).toBe(1);

    // 同尺寸损坏内容 + 相同 mtime → 解析失败（快照须被重置）
    fs.writeFileSync(file, '{"broken": ', "utf8");
    fs.utimesSync(file, fixedTime, fixedTime);
    store.ensureFresh();
    expect(store.stats.total).toBe(0);

    // 外部"修复"：同尺寸同 mtime 的合法内容。
    // 若无快照重置，ensureFresh 会认为文件未变而永远停在空副本。
    fs.writeFileSync(file, "[1]      ", "utf8");
    fs.utimesSync(file, fixedTime, fixedTime);
    store.ensureFresh();
    expect(store.stats.total).toBe(1);
  });

  it("save 是原子写（tmp + rename），不残留 tmp 文件", () => {
    const { store, file } = createStore();
    store.addPreparedBatch([{ text: "alpha", source: "user_memory", embedding: [1, 0] }]);

    expect(fs.existsSync(file + ".tmp")).toBe(false);
    expect(readEntries(file)).toHaveLength(1);
  });
});
