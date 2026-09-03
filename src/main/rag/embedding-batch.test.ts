import { describe, expect, it } from "vitest";
import { MAX_INFERENCE_BATCH_TEXTS, runBatchedInference } from "./embedding-pipeline";

/** 模拟 transformers.js feature-extraction pipeline（batch 输入 → [n, dim] Tensor） */
function makeFakePipeline(dim = 4, calls: string[][] = []) {
  return async (texts: string[], _options?: unknown) => {
    calls.push(texts);
    const data = new Float32Array(texts.length * dim);
    for (let i = 0; i < texts.length; i++) {
      // 用文本长度做可区分的向量内容，便于断言分片顺序
      for (let j = 0; j < dim; j++) {
        data[i * dim + j] = i * 100 + j;
      }
    }
    return { data, dims: [texts.length, dim] };
  };
}

describe("runBatchedInference", () => {
  it("returns one vector per text, sliced in order", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(4, calls);
    const vectors = await runBatchedInference(pipe, ["a", "b", "c"]);

    expect(vectors).toHaveLength(3);
    expect(calls).toEqual([["a", "b", "c"]]);
    expect(Array.from(vectors[0])).toEqual([0, 1, 2, 3]);
    expect(Array.from(vectors[1])).toEqual([100, 101, 102, 103]);
    expect(Array.from(vectors[2])).toEqual([200, 201, 202, 203]);
  });

  it("returns empty array for empty input without touching the pipeline", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(4, calls);
    expect(await runBatchedInference(pipe, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("splits large batches into sub-batches bounded by MAX_INFERENCE_BATCH_TEXTS", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(2, calls);
    const texts = Array.from({ length: MAX_INFERENCE_BATCH_TEXTS + 3 }, (_, i) => `t${i}`);
    const vectors = await runBatchedInference(pipe, texts);

    expect(vectors).toHaveLength(texts.length);
    expect(calls.map((batch) => batch.length)).toEqual([MAX_INFERENCE_BATCH_TEXTS, 3]);
    // 向量顺序与输入顺序一致
    expect(vectors[MAX_INFERENCE_BATCH_TEXTS].length).toBe(2);
  });

  it("splits long texts by character budget to bound WASM memory", async () => {
    const calls: string[][] = [];
    const pipe = makeFakePipeline(2, calls);
    const long = "x".repeat(6000);
    await runBatchedInference(pipe, [long, long]);

    expect(calls).toEqual([[long], [long]]);
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
