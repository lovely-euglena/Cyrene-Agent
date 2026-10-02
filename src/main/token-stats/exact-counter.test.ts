import { describe, expect, it } from "vitest";
import { buildContextUsageSnapshot } from "../orchestrator/context-usage";
import type { ContextUsageSnapshotInput } from "../orchestrator/context-usage";
import { buildContextUsageSnapshotWithCounter } from "./exact-counter";

const input: ContextUsageSnapshotInput = {
  phase: "preRequest",
  contextWindowTokens: 128_000,
  personaContent: "你是昔涟。",
  messages: [{ role: "user", content: "你好" }],
};

describe("buildContextUsageSnapshotWithCounter", () => {
  it("计数器失败时整体回退估算", async () => {
    const snapshot = await buildContextUsageSnapshotWithCounter(input, async () => null);
    const plain = buildContextUsageSnapshot(input);
    expect(snapshot.categories).toEqual(plain.categories);
    expect(snapshot.totalTokens).toBe(plain.totalTokens);
  });

  it("计数器成功时按返回值计量（去重后批量重填）", async () => {
    const calls: string[][] = [];
    const snapshot = await buildContextUsageSnapshotWithCounter(input, async (texts) => {
      calls.push(texts);
      return texts.map((text) => (text.length === 0 ? 0 : 100));
    });
    // persona 100 + user 内容 100 + 每条消息开销 4；空串文本按 0（与真实 tokenizer 一致）。
    expect(snapshot.totalTokens).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["你是昔涟。", "", "你好"]);
  });

  it("返回长度不匹配时整体回退估算", async () => {
    const snapshot = await buildContextUsageSnapshotWithCounter(input, async () => [1]);
    const plain = buildContextUsageSnapshot(input);
    expect(snapshot.categories).toEqual(plain.categories);
  });

  it("计数函数抛错时整体回退估算", async () => {
    const snapshot = await buildContextUsageSnapshotWithCounter(input, async () => {
      throw new Error("host down");
    });
    const plain = buildContextUsageSnapshot(input);
    expect(snapshot.totalTokens).toBe(plain.totalTokens);
  });
});
