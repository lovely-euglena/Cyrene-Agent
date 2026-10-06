/**
 * 同步状态测试（IKJK2I A 簇）：身份生成 / 原子写 / 缺失新建 / 损坏隔离恢复。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncEventV0 } from "./sync-protocol";
import { createSyncState, loadSyncState, saveSyncState } from "./sync-state";

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

function writeJsonl(file: string, events: SyncEventV0[]): void {
  fs.writeFileSync(file, events.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("sync-state", () => {
  it("createSyncState 生成 desk-<12hex> 身份与初始水位", () => {
    const state = createSyncState();
    expect(state.deviceId).toMatch(/^desk-[0-9a-f]{12}$/);
    expect(state.schemaVersion).toBe(1);
    expect(state.lamport).toBe(0);
    expect(state.seq).toBe(0);
    expect(state.fetchCursor).toBeNull();
    expect(state.pushedCount).toBe(0);
    expect(state.serverDeviceId).toBeNull();
    expect(state.conversations).toEqual({});
    expect(state.updatedAt).toMatch(ISO_RE);
  });

  it("saveSyncState 原子写：load 往返一致且不残留临时文件", async () => {
    const dir = makeDir("cyrene-sync-state-");
    const state = createSyncState();
    state.lamport = 7;
    state.seq = 5;
    state.fetchCursor = "cur-1";
    state.pushedCount = 3;
    state.serverDeviceId = "dev_abc";
    state.conversations = { s1: { exportedThroughSeq: 12, titleRevision: 2, lastTitle: "标题" } };
    await saveSyncState(dir, state);
    expect(state.updatedAt).toMatch(ISO_RE);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);

    const loaded = await loadSyncState(dir);
    expect(loaded).toEqual(state);
  });

  it("缺失 → 新建并落盘，设备身份跨次加载稳定", async () => {
    const dir = makeDir("cyrene-sync-state-");
    const first = await loadSyncState(dir);
    expect(first.deviceId).toMatch(/^desk-[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);

    const second = await loadSyncState(dir);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.updatedAt).toMatch(ISO_RE);
  });

  it("损坏 → 隔离 .corrupt-<ts> 后按事件库恢复（deviceId / lamport / seq）", async () => {
    const dir = makeDir("cyrene-sync-state-");
    writeJsonl(path.join(dir, "events-local.jsonl"), [
      event({ eventId: "e1", lamport: 3, seq: 1, deviceId: "desk-aaaaaaaaaaaa" }),
      event({ eventId: "e2", lamport: 7, seq: 2, deviceId: "desk-aaaaaaaaaaaa" }),
    ]);
    writeJsonl(path.join(dir, "events-remote.jsonl"), [
      event({ eventId: "r1", lamport: 10, seq: 9, deviceId: "server" }),
    ]);
    fs.writeFileSync(path.join(dir, "state.json"), "{ 这不是 JSON", "utf8");

    const recovered = await loadSyncState(dir);
    expect(recovered.deviceId).toBe("desk-aaaaaaaaaaaa");
    expect(recovered.lamport).toBe(10);
    expect(recovered.seq).toBe(2);
    expect(recovered.conversations).toEqual({});
    expect(recovered.fetchCursor).toBeNull();
    expect(recovered.pushedCount).toBe(0);
    expect(recovered.serverDeviceId).toBeNull();
    expect(recovered.updatedAt).toMatch(ISO_RE);

    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]), "utf8")).toBe("{ 这不是 JSON");

    // 恢复结果已落盘：再次 load 不再隔离、身份保持。
    const again = await loadSyncState(dir);
    expect(again.deviceId).toBe("desk-aaaaaaaaaaaa");
    expect(again.lamport).toBe(10);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"))).toHaveLength(1);
  });

  it("损坏且无 outbox → 新生成身份，lamport 取 remote 最大值", async () => {
    const dir = makeDir("cyrene-sync-state-");
    writeJsonl(path.join(dir, "events-remote.jsonl"), [
      event({ eventId: "r1", lamport: 42, seq: 5, deviceId: "server" }),
    ]);
    fs.writeFileSync(path.join(dir, "state.json"), "null", "utf8");

    const recovered = await loadSyncState(dir);
    expect(recovered.deviceId).toMatch(/^desk-[0-9a-f]{12}$/);
    expect(recovered.lamport).toBe(42);
    expect(recovered.seq).toBe(0);
  });

  it("形状非法（schemaVersion / conversations 损坏）同样隔离恢复", async () => {
    const dir = makeDir("cyrene-sync-state-");
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schemaVersion: 2 }), "utf8");
    const recovered = await loadSyncState(dir);
    expect(recovered.schemaVersion).toBe(1);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"))).toHaveLength(1);

    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      deviceId: "desk-000000000001",
      lamport: 1,
      seq: 1,
      fetchCursor: null,
      pushedCount: 0,
      serverDeviceId: null,
      conversations: { s1: { exportedThroughSeq: "bad", titleRevision: 0, lastTitle: "" } },
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const second = await loadSyncState(dir);
    expect(second.conversations).toEqual({});
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"))).toHaveLength(2);
  });
});
