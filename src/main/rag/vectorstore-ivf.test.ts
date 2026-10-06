// IVF 索引回归（IKJSNG）：buildIvfIndex 收敛/maxIter 退出时，clusters 必须与
// 最终 centroids 同代——否则搜索按最终中心选簇、却读到按旧中心归的成员，
// 近边界条目会被漏检。函数未导出，这里经 rebuildIndex() 后读私有 ivf 做间接断言。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonVectorStore, cosineSimilarity, type MemoryEntry } from "./vectorstore";

interface IvfShape {
  centroids: number[][];
  clusters: number[][];
  entryCount: number;
}

/** 可复现的伪随机序列（k-means++ 初始化依赖 Math.random）。 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function unit(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * 构造「近边界点」分布（n=18 → K=2）：
 * - 8 条 c1=(1,0) 副本、8 条 c2=(0,1) 副本；
 * - p 在 c1/c2 角平分线上略偏 c2（45°+0.001rad），首轮按初始中心归 c2；
 * - q 在 90°+1rad，把 c2 的均值拉离 p；
 * 首轮更新 c2→90.837°（sim≥0.999 即 break），而 p 在最终中心下最近的是 c1。
 * 修复前 clusters 停留在旧中心分配（p 仍归 c2），与最终 centroids 错位一代。
 */
function makeEntries(): MemoryEntry[] {
  const embeddings: number[][] = [];
  for (let i = 0; i < 8; i++) embeddings.push(unit(0));
  for (let i = 0; i < 8; i++) embeddings.push(unit(Math.PI / 2));
  embeddings.push(unit(Math.PI / 2 + 1)); // q, idx 16
  embeddings.push(unit(Math.PI / 4 + 0.001)); // p, idx 17
  return embeddings.map((embedding, i) => ({
    id: `e_${i}`,
    text: `doc ${i}`,
    embedding,
    source: "user_memory",
    weight: 1,
    createdAt: 0,
    lastRecalledAt: 0,
  }));
}

const tempDirs: string[] = [];
const stores: JsonVectorStore[] = [];

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

describe("buildIvfIndex（经 rebuildIndex 间接断言）", () => {
  it("收敛退出后簇成员与最终中心一致，近边界条目不落错簇（IKJSNG）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-ivf-test-"));
    tempDirs.push(dir);
    const store = new JsonVectorStore(dir);
    stores.push(store);
    store.addPreparedBatch(makeEntries());

    // 固定 k-means++ 初始化序列（seed=1：初始中心恰为 c1、c2）
    const spy = vi.spyOn(Math, "random").mockImplementation(seededRandom(1));
    try {
      store.rebuildIndex();
    } finally {
      spy.mockRestore();
    }

    const entries = (store as unknown as { entries: MemoryEntry[] }).entries;
    const ivf = (store as unknown as { ivf: IvfShape }).ivf;
    expect(ivf.centroids).toHaveLength(2);

    // 覆盖性：每个条目恰好出现在一个簇里
    const seen = new Set<number>();
    for (const cluster of ivf.clusters) {
      for (const idx of cluster) {
        expect(seen.has(idx)).toBe(false);
        seen.add(idx);
      }
    }
    expect(seen.size).toBe(entries.length);

    // 一致性：每个条目最近的中心就是它所在簇的中心
    // （修复前近边界条目 p 仍留在按旧中心分配的簇里 → 此处失败）
    for (let c = 0; c < ivf.clusters.length; c++) {
      for (const idx of ivf.clusters[c]) {
        let best = 0;
        let bestSim = -Infinity;
        for (let k = 0; k < ivf.centroids.length; k++) {
          const sim = cosineSimilarity(entries[idx].embedding, ivf.centroids[k]);
          if (sim > bestSim) {
            bestSim = sim;
            best = k;
          }
        }
        expect(best).toBe(c);
      }
    }

    // p（idx 17）应随最终中心归入 c1 簇：两簇各 9 条（修复前为 8/10）
    expect(ivf.clusters.map((cluster) => cluster.length)).toEqual([9, 9]);
  });
});
