import { describe, expect, it } from "vitest";
import { MAX_INFERENCE_BATCH_TEXTS, runBatchedInference } from "./embedding-pipeline";

/**
 * 模拟 transformers.js feature-extraction pipeline（batch 输入 → [n, dim] Tensor）。
 * 向量内容由文本本身决定（首字符 charCode），与批内位置无关——
 * 这样才能验证排序组批后的结果会正确映射回原始输入顺序。
 */
function makeFakePipeline(dim = 4, calls: string[][] = []) {
  return async (texts: string[], _options?: unknown) => {
    calls.push(texts);
    const data = new Float32Array(texts.length * dim);
    for (let i = 0; i < texts.length; i++) {
      const seed = texts[i].charCodeAt(0);
      for (let j = 0; j < dim; j++) {
        data[i * dim + j] = seed * 10 + j;
      }
    }
    return { data, dims: [texts.length, dim] };
  };
}

/** 由 makeFakePipeline 的种子规则推出某文本应有的向量 */
function expectedVector(text: string, dim = 4): number[] {
  const seed = text.charCodeAt(0);
  return Array.from({ length: dim }, (_, j) => seed * 10 + j);
}

describe("runBatchedInference", () => {
  it("returns one vector per text, mapped back to original input order", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(4, calls);
    // 长度乱序 + 首字符各异：排序组批会重排批内顺序，结果必须还原
    const texts = ["dddd", "a", "ccc", "bb", "e"];
    const vectors = await runBatchedInference(pipe, texts);

    expect(vectors).toHaveLength(5);
    for (let i = 0; i < texts.length; i++) {
      expect(Array.from(vectors[i])).toEqual(expectedVector(texts[i], 4));
    }
    // 单批容纳全部（5 ≤ MAX_INFERENCE_BATCH_TEXTS），一次前向
    expect(calls).toHaveLength(1);
    // 批内已按长度升序排列
    expect(calls[0]).toEqual(["a", "bb", "ccc", "dddd", "e"].sort((a, b) => a.length - b.length));
  });

  it("returns empty array for empty input without touching the pipeline", async () => {
    const pipe = makeFakePipeline(4);
    expect(await runBatchedInference(pipe, [])).toEqual([]);
  });

  it("splits large batches into sub-batches bounded by MAX_INFERENCE_BATCH_TEXTS", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(2, calls);
    // 等长文本：排序不改变相对顺序（V8 sort 稳定）
    const texts = Array.from({ length: 20 }, (_, i) => `t${i.toString().padStart(2, "0")}`);
    const vectors = await runBatchedInference(pipe, texts);

    expect(calls.map((batch) => batch.length)).toEqual([
      MAX_INFERENCE_BATCH_TEXTS,
      MAX_INFERENCE_BATCH_TEXTS,
      20 - 2 * MAX_INFERENCE_BATCH_TEXTS,
    ]);
    for (let i = 0; i < texts.length; i++) {
      expect(Array.from(vectors[i])).toEqual(expectedVector(texts[i], 2));
    }
  });

  it("splits long texts by character budget to bound WASM memory", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(2, calls);
    const longA = "a".repeat(6000);
    const longB = "b".repeat(6000);
    await runBatchedInference(pipe, [longA, longB]);

    expect(calls).toEqual([[longA], [longB]]);
  });

  it("keeps result order stable across sub-batches of mixed lengths", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(4, calls);
    // 10 条混合长度，会切成多个子批；跨批顺序也必须还原
    const texts = [
      "a".repeat(500),
      "b",
      "c".repeat(200),
      "d".repeat(500),
      "e",
      "f".repeat(200),
      "g".repeat(500),
      "h",
      "i".repeat(200),
      "j".repeat(500),
    ];
    const vectors = await runBatchedInference(pipe, texts);

    expect(vectors).toHaveLength(10);
    for (let i = 0; i < texts.length; i++) {
      expect(Array.from(vectors[i])).toEqual(expectedVector(texts[i], 4));
    }
    // 多于一批
    expect(calls.length).toBeGreaterThan(1);
  });

  it("returns copied buffers that are safe to transfer (no view aliasing)", async () => {
    const pipe = makeFakePipeline(4);
    const [vector] = await runBatchedInference(pipe, ["hello"]);
    expect(vector).toBeInstanceOf(Float32Array);
    // new Float32Array(view) 拷贝：视图铺满自己的独立 buffer（subarray 视图
    // 则会有非零 byteOffset 或更大的 buffer），postMessage 传输才安全
    expect(vector.byteOffset).toBe(0);
    expect(vector.buffer.byteLength).toBe(vector.byteLength);
    expect(vector.byteLength).toBe(4 * 4);
    const copy = new Float32Array(vector);
    expect(Array.from(copy)).toEqual(Array.from(vector));
  });

  it("throws on inconsistent tensor shape", async () => {
    const pipe = async (texts: string[]) => ({
      data: new Float32Array(texts.length * 3), // 声称 dim=4 但实际 3
      dims: [texts.length, 4],
    });
    await expect(runBatchedInference(pipe, ["a", "b"])).rejects.toThrow(/shape mismatch/);
  });
});
