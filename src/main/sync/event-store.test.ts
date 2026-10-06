/**
 * 旁路事件库测试（IKJK2I A 簇）：open 规范序 / append 去重 / fsync 持久化 / 末行容错。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncEventStore } from "./event-store";
import type { SyncEventV0 } from "./sync-protocol";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function event(
  overrides: Partial<SyncEventV0> & Pick<SyncEventV0, "eventId" | "lamport" | "seq">,
): SyncEventV0 {
  return {
    sessionId: "s1",
    type: "message.append",
    deviceId: "desk-000000000001",
    ts: "2026-10-06T00:00:00.000Z",
    payload: { role: "user", text: "t", turnId: "u1" },
    ...overrides,
  };
}

function readLines(file: string): SyncEventV0[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SyncEventV0);
}

describe("SyncEventStore", () => {
  it("空目录 open：计数为零并创建同步目录", async () => {
    const dir = path.join(makeDir("cyrene-sync-store-"), "sync");
    const store = await SyncEventStore.open({ syncDir: dir });
    expect(fs.existsSync(dir)).toBe(true);
    expect(store.getLocalCount()).toBe(0);
    expect(store.getRemoteCount()).toBe(0);
    expect(store.getLocalEvents()).toEqual([]);
    expect(store.getRemoteEvents()).toEqual([]);
    expect(store.getAllEvents()).toEqual([]);
  });

  it("appendLocal 持久化：乱序输入按规范序读回，重开后保持", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const store = await SyncEventStore.open({ syncDir: dir });
    const late = event({ eventId: "late", lamport: 5, seq: 2 });
    const early = event({ eventId: "early", lamport: 1, seq: 1 });
    await store.appendLocal([late, early]);
    expect(store.getLocalEvents().map((item) => item.eventId)).toEqual(["early", "late"]);
    expect(store.getLocalCount()).toBe(2);

    // 文件按 append 顺序逐行落盘，每行完整可解析。
    const file = path.join(dir, "events-local.jsonl");
    expect(readLines(file).map((item) => item.eventId)).toEqual(["late", "early"]);

    const reopened = await SyncEventStore.open({ syncDir: dir });
    expect(reopened.getLocalEvents().map((item) => item.eventId)).toEqual(["early", "late"]);
  });

  it("按 eventId 去重：跨两库与批内重复均跳过", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const store = await SyncEventStore.open({ syncDir: dir });
    const first = event({ eventId: "e1", lamport: 1, seq: 1 });
    const second = event({ eventId: "e2", lamport: 2, seq: 2 });

    await store.appendLocal([first, first]);
    await store.appendLocal([first]);
    expect(store.getLocalCount()).toBe(1);

    // 跨库：e1 已在 local → remote 拒绝；e2 入 remote 后 local 再追加也拒绝。
    await store.appendRemote([first, second]);
    expect(store.getRemoteCount()).toBe(1);
    expect(store.getRemoteEvents().map((item) => item.eventId)).toEqual(["e2"]);
    await store.appendLocal([second]);
    expect(store.getLocalCount()).toBe(1);

    const reopened = await SyncEventStore.open({ syncDir: dir });
    expect(reopened.getLocalCount()).toBe(1);
    expect(reopened.getRemoteCount()).toBe(1);
  });

  it("getRemoteEventsForSession 过滤本会话远端事件（规范序）", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const store = await SyncEventStore.open({ syncDir: dir });
    await store.appendRemote([
      event({ eventId: "s2-late", sessionId: "s2", lamport: 9, seq: 2 }),
      event({ eventId: "s1", sessionId: "s1", lamport: 2, seq: 1 }),
      event({ eventId: "s2-early", sessionId: "s2", lamport: 1, seq: 1 }),
    ]);
    expect(store.getRemoteEventsForSession("s2").map((item) => item.eventId))
      .toEqual(["s2-early", "s2-late"]);
    expect(store.getRemoteEventsForSession("missing")).toEqual([]);
  });

  it("getAllEvents 返回两库并集（规范序）；getLocalEventIds 返回副本", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const store = await SyncEventStore.open({ syncDir: dir });
    await store.appendLocal([event({ eventId: "l1", lamport: 1, seq: 1 })]);
    await store.appendRemote([event({ eventId: "r1", sessionId: "s2", lamport: 3, seq: 1 })]);
    expect(store.getAllEvents().map((item) => item.eventId)).toEqual(["l1", "r1"]);

    const ids = store.getLocalEventIds();
    ids.add("fake");
    expect(store.getLocalEventIds().has("fake")).toBe(false);
    await store.appendLocal([event({ eventId: "fake", lamport: 4, seq: 2 })]);
    expect(store.getLocalCount()).toBe(2);
  });

  it("末行截断容错：open 修剪半截尾行，append 后文件保持逐行完整", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const file = path.join(dir, "events-local.jsonl");
    const valid = event({ eventId: "e1", lamport: 1, seq: 1 });
    fs.writeFileSync(file, `${JSON.stringify(valid)}\n{"eventId":"half`, "utf8");

    const store = await SyncEventStore.open({ syncDir: dir });
    expect(store.getLocalEvents().map((item) => item.eventId)).toEqual(["e1"]);
    // 半截尾行已被物理修剪，后续 append 不与残行粘连。
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);

    await store.appendLocal([event({ eventId: "e2", lamport: 2, seq: 2 })]);
    const reopened = await SyncEventStore.open({ syncDir: dir });
    expect(reopened.getLocalEvents().map((item) => item.eventId)).toEqual(["e1", "e2"]);
    expect(readLines(file).map((item) => item.eventId)).toEqual(["e1", "e2"]);
  });

  it("中间坏行被读取器跳过，不影响其余事件", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const file = path.join(dir, "events-remote.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify(event({ eventId: "r1", lamport: 1, seq: 1 })),
      "not-json",
      JSON.stringify(event({ eventId: "r2", sessionId: "s2", lamport: 2, seq: 2 })),
      "",
    ].join("\n"), "utf8");
    const store = await SyncEventStore.open({ syncDir: dir });
    expect(store.getRemoteEvents().map((item) => item.eventId)).toEqual(["r1", "r2"]);
  });

  it("append 串行队列：并发追加不丢事件、文件无交错", async () => {
    const dir = makeDir("cyrene-sync-store-");
    const store = await SyncEventStore.open({ syncDir: dir });
    await Promise.all([
      store.appendLocal([event({ eventId: "a", lamport: 2, seq: 2 })]),
      store.appendLocal([event({ eventId: "b", lamport: 1, seq: 1 })]),
      store.appendRemote([event({ eventId: "r", sessionId: "s2", lamport: 3, seq: 1 })]),
    ]);
    expect(store.getLocalCount()).toBe(2);
    expect(store.getRemoteCount()).toBe(1);
    expect(readLines(path.join(dir, "events-local.jsonl"))).toHaveLength(2);
    const reopened = await SyncEventStore.open({ syncDir: dir });
    expect(reopened.getAllEvents().map((item) => item.eventId)).toEqual(["b", "a", "r"]);
  });
});
