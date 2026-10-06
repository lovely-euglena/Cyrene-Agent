/**
 * 记忆/心情物化契约测试：TS 物化器跑共享 fixtures。
 *
 * fixtures 与 C# 侧（dotnet/smoke-host --selftest sync-materialize）共用同一套文件，
 * 物化结果必须逐字段一致（见 fixtures/sync-protocol/README.md）。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeMemoryMood } from "./memory-mood-materializer";
import { readSyncBatch, type SyncEventV0 } from "./sync-protocol";

const casesDir = path.join(process.cwd(), "fixtures", "sync-protocol", "materialize-cases");
const caseFiles = fs.readdirSync(casesDir).filter((file) => file.endsWith(".json")).sort();

interface FixtureExpectation {
  memories: Record<string, { content: string; weight: number; pinned: boolean }>;
  mood: { feeling: string } | null;
  errors?: { index: number; code: string }[];
  droppedDuplicates?: string[];
}

interface FixtureCase {
  name?: string;
  description?: string;
  input: string;
  expect: FixtureExpectation;
}

describe("记忆/心情物化 fixtures（TS 物化器）", () => {
  it("materialize-cases 目录非空", () => {
    expect(caseFiles.length).toBeGreaterThan(0);
  });

  for (const file of caseFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf8")) as FixtureCase;
    it(`${file}｜${fixture.name ?? ""}`, () => {
      const result = readSyncBatch(fixture.input);
      // errors / droppedDuplicates 为可选断言（fixtures 给出时逐字段比较）
      if (fixture.expect.errors !== undefined) {
        expect(result.errors).toEqual(fixture.expect.errors);
      }
      if (fixture.expect.droppedDuplicates !== undefined) {
        expect(result.droppedDuplicates).toEqual(fixture.expect.droppedDuplicates);
      }
      const materialized = materializeMemoryMood(result.events);
      expect(materialized.memories).toEqual(fixture.expect.memories);
      expect(materialized.mood).toEqual(fixture.expect.mood);
    });
  }
});

/** 构造 JSONL 行（dev-a 单设备；seq 与 lamport 同步递增保证规范序 = 输入序）。 */
function eventLine(
  eventId: string,
  lamport: number,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    eventId,
    sessionId,
    type,
    lamport,
    deviceId: "dev-a",
    seq: lamport,
    ts: "2026-10-06T04:00:00.000Z",
    payload,
  });
}

function readEvents(lines: string[]): SyncEventV0[] {
  const result = readSyncBatch(lines.join("\n"));
  expect(result.errors).toEqual([]);
  expect(result.truncatedTail).toBe(false);
  return result.events;
}

describe("物化器单元用例", () => {
  it("空事件 → { memories: {}, mood: null }", () => {
    expect(materializeMemoryMood([])).toEqual({ memories: {}, mood: null });
  });

  it("sticky 墓碑：删除后同 id 后续 upsert 不复活，其它记录不受影响", () => {
    const events = readEvents([
      eventLine("e1", 1, "__memory__", "memory.write", { memoryId: "m1", op: "upsert", content: "A", weight: 50 }),
      eventLine("e2", 2, "__memory__", "memory.write", { memoryId: "m1", op: "delete" }),
      eventLine("e3", 3, "__memory__", "memory.write", { memoryId: "m1", op: "upsert", content: "A2", weight: 55 }),
      eventLine("e4", 4, "__memory__", "memory.write", { memoryId: "m2", op: "upsert", content: "B", weight: 10 }),
    ]);
    const materialized = materializeMemoryMood(events);
    expect(materialized.memories.m1).toBeUndefined();
    expect(materialized.memories).toEqual({
      m2: { content: "B", weight: 10, pinned: false },
    });
    expect(materialized.mood).toBeNull();
  });

  it("幂等重放：同一批事件重复物化结果一致", () => {
    const lines = [
      eventLine("e1", 1, "__memory__", "memory.write", { memoryId: "m1", op: "upsert", content: "A", weight: 50, pinned: true }),
      eventLine("e2", 2, "__mood__", "mood.shift", { feeling: "开心" }),
      eventLine("e3", 3, "__mood__", "mood.shift", { feeling: "温柔" }),
    ];
    const first = materializeMemoryMood(readEvents(lines));
    const second = materializeMemoryMood(readEvents(lines));
    expect(first).toEqual(second);
    expect(first).toEqual({
      memories: { m1: { content: "A", weight: 50, pinned: true } },
      mood: { feeling: "温柔" },
    });
    // 同一份事件数组重复物化亦幂等
    const events = readEvents(lines);
    expect(materializeMemoryMood(events)).toEqual(materializeMemoryMood(events));
  });
});
