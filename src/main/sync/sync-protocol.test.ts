/**
 * 同步协议 v0 契约测试：TS 读取器/校验器跑共享 fixtures。
 *
 * fixtures 与 C# 侧（dotnet/smoke-host --selftest sync-protocol）共用同一套文件，
 * 两侧结果必须逐字段一致（见 docs/specs/2026-10-04-sync-protocol-v0.md）。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSyncBatch } from "./sync-protocol";

const casesDir = path.join(process.cwd(), "fixtures", "sync-protocol", "cases");
const caseFiles = fs.readdirSync(casesDir).filter((file) => file.endsWith(".json")).sort();

interface FixtureExpectation {
  events: string[];
  errors?: { index: number; code: string }[];
  droppedDuplicates?: string[];
  truncatedTail?: boolean;
}

interface FixtureCase {
  name?: string;
  input: string;
  expect: FixtureExpectation;
}

describe("同步协议 v0 fixtures（TS 读取器/校验器）", () => {
  it("cases 目录非空", () => {
    expect(caseFiles.length).toBeGreaterThan(0);
  });

  for (const file of caseFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf8")) as FixtureCase;
    it(`${file}｜${fixture.name ?? ""}`, () => {
      const result = readSyncBatch(fixture.input);
      expect(result.events.map((event) => event.eventId)).toEqual(fixture.expect.events);
      expect(result.errors).toEqual(fixture.expect.errors ?? []);
      expect(result.droppedDuplicates).toEqual(fixture.expect.droppedDuplicates ?? []);
      expect(result.truncatedTail).toBe(fixture.expect.truncatedTail ?? false);
    });
  }
});
