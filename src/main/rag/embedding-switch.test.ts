// embedding 模型切换 + 索引迁移（IKIH28 关键防丢数据语义）：
//   - 默认（无 action）：模型/维度变化返回 rebuild-required，不静默 clearAll；
//   - action="rebuild"：先备份 → 全量分批重嵌入 → 原地 upsert → meta 更新；
//   - action="clear"：显式清空；
//   - 旧数据无 meta.model：按维度兼容推断（1024 → bgem3）；
//   - 取消：中途失败不落盘，旧数据保持原样。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";

const state = vi.hoisted(() => {
  // one-hot 文本向量：不同文本近似正交（避免 store.add 的去重误判为重复）
  const vec = (text: string, dims: number) => {
    const arr = new Array<number>(dims).fill(0);
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    arr[h % dims] = 1;
    return arr;
  };
  const make = (model: string, dims: number) => ({
    name: "local-" + model.split("/").pop(),
    dims,
    declaredDimensions: dims,
    resolvedDimensions: dims,
    cacheIdentity: { provider: "local", model, dimensions: dims },
    async embed(text: string) { return vec(text, dims); },
    async embedBatch(texts: string[]) { return texts.map((text) => vec(text, dims)); },
  });
  return {
    userDataDir: "",
    bgem3: make("Xenova/bge-m3", 1024),
    e5: make("Xenova/multilingual-e5-small", 384),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => state.userDataDir,
    getAppPath: () => state.userDataDir,
  },
}));

vi.mock("./embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding")>();
  return {
    ...actual,
    // 与真实 getEmbeddingProvider 同口径：按传入 modelKey 返回对应 provider
    getEmbeddingProvider: (_mode?: string, _baseUrl?: string, _apiKey?: string, modelKey?: string) =>
      (modelKey === "e5-small" ? state.e5 : state.bgem3) as unknown as EmbeddingProvider,
    createLocalEmbeddingProvider: (key?: string) =>
      (key === "e5-small" ? state.e5 : state.bgem3) as unknown as EmbeddingProvider,
  };
});

import {
  addMemory,
  getEntriesBySource,
  getIndexMetadata,
  getRAGStats,
  initVectorMemory,
  resetRAG,
  switchEmbeddingModel,
} from "./index";

let tmpDir = "";
const originalStoreMode = process.env.CYRENE_RAG_STORE;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-switch-test-"));
  state.userDataDir = tmpDir;
  process.env.CYRENE_RAG_STORE = "json";
  await initVectorMemory();
  await addMemory("alpha memory", "user_memory");
  await addMemory("beta memory", "user_memory");
});

afterEach(() => {
  resetRAG();
  if (originalStoreMode === undefined) delete process.env.CYRENE_RAG_STORE;
  else process.env.CYRENE_RAG_STORE = originalStoreMode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("switchEmbeddingModel: 默认拒绝（不静默清库）", () => {
  it("维度/模型变化 → rebuild-required + requires=rebuild，库与 provider 不动", async () => {
    const result = await switchEmbeddingModel("e5-small");

    expect(result).toMatchObject({
      ok: false,
      modelKey: "e5-small",
      reason: "rebuild-required",
      requires: "rebuild",
      clearedEntries: 0,
    });
    expect(getRAGStats().total).toBe(2);
    expect(getEntriesBySource("user_memory").every((entry) => entry.embedding.length === 1024)).toBe(true);
    expect(getIndexMetadata()?.model).toBe("Xenova/bge-m3");
  });

  it("空库但存在陈旧 meta → requires=clear（仍需显式确认）", async () => {
    await switchEmbeddingModel("e5-small", "clear");
    expect(getRAGStats().total).toBe(0);
    expect(getIndexMetadata()?.model).toBe("Xenova/multilingual-e5-small");

    // 再切回 bgem3：没有数据，但 meta 身份不符 → 默认拒绝且建议 clear
    const result = await switchEmbeddingModel("bgem3");
    expect(result).toMatchObject({ ok: false, reason: "rebuild-required", requires: "clear" });
    expect(getIndexMetadata()?.model).toBe("Xenova/multilingual-e5-small");
  });

  it("未知模型键 → 直接报错，不触碰索引", async () => {
    const result = await switchEmbeddingModel("nope");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown embedding model/);
    expect(getRAGStats().total).toBe(2);
  });

  it("切换到当前同款模型 → ok 且不清库", async () => {
    const result = await switchEmbeddingModel("bgem3");
    expect(result).toMatchObject({ ok: true, clearedEntries: 0 });
    expect(getRAGStats().total).toBe(2);
  });
});

describe("switchEmbeddingModel: action=clear", () => {
  it("显式清空并写入新模型 meta", async () => {
    const result = await switchEmbeddingModel("e5-small", "clear");

    expect(result).toMatchObject({ ok: true, modelKey: "e5-small", clearedEntries: 2 });
    expect(getRAGStats().total).toBe(0);
    expect(getIndexMetadata()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 384,
    });

    // 切换后的写入必须用新 provider（384 维），而不是默认 bgem3
    await addMemory("gamma memory", "user_memory");
    expect(getEntriesBySource("user_memory")[0].embedding.length).toBe(384);
  });
});

describe("switchEmbeddingModel: action=rebuild", () => {
  it("备份 → 全量重嵌入（384 维）→ 更新 meta/IVF", async () => {
    const progress: Array<[number, number]> = [];
    const result = await switchEmbeddingModel("e5-small", "rebuild", {
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(result).toMatchObject({ ok: true, rebuiltEntries: 2, clearedEntries: 0 });
    const entries = getEntriesBySource("user_memory");
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.embedding.length === 384)).toBe(true);
    expect(getIndexMetadata()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 384,
    });
    // 进度语义：completed 单调递增，total = 条目总数
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(([, total]) => total === 2)).toBe(true);
    expect(progress[progress.length - 1][0]).toBe(2);

    // 备份落盘（JSON 回退路径为文件拷贝）
    const backupDir = path.join(tmpDir, "rag-data", "index-rebuild-backups");
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readdirSync(backupDir).some((name) => name.startsWith("memory-store."))).toBe(true);
  });

  it("取消时中途不落盘：条目与 meta 保持旧模型", async () => {
    const result = await switchEmbeddingModel("e5-small", "rebuild", { isCancelled: () => true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/);
    expect(getEntriesBySource("user_memory").every((entry) => entry.embedding.length === 1024)).toBe(true);
    expect(getIndexMetadata()?.model).toBe("Xenova/bge-m3");
  });
});

describe("switchEmbeddingModel: 旧数据兼容推断", () => {
  it("无 meta + 1024 维条目 → 推断为 bgem3，切 bgem3 不触发迁移", async () => {
    fs.unlinkSync(path.join(tmpDir, "rag-data", "memory-store-meta.json"));
    resetRAG();
    await initVectorMemory();

    expect(getIndexMetadata()).toBeNull();
    const result = await switchEmbeddingModel("bgem3");
    expect(result).toMatchObject({ ok: true, clearedEntries: 0 });
    expect(getRAGStats().total).toBe(2);

    // 无 meta 的旧数据切 e5-small 仍默认拒绝（requires=rebuild）
    const reject = await switchEmbeddingModel("e5-small");
    expect(reject).toMatchObject({ ok: false, reason: "rebuild-required", requires: "rebuild" });
  });
});
