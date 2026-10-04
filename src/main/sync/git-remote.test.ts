import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepoRemote, mergeSyncEvents } from "./git-remote";
import type { SyncEventV0 } from "./sync-protocol";

const TIMEOUT = 30_000;
const IDENTITY = ["-c", "user.name=tester", "-c", "user.email=tester@example.com"];

function ev(
  eventId: string,
  device: string,
  lamport: number,
  seq: number,
  text = "msg",
): SyncEventV0 {
  return {
    eventId,
    sessionId: "s1",
    type: "message.append",
    lamport,
    deviceId: device,
    seq,
    ts: "2026-10-04T03:00:00.000Z",
    payload: { role: "user", text, turnId: `turn-${eventId}` },
  };
}

describe("GitRepoRemote（IKJN7B）", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "cyrene-git-remote-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** 每用例独立 bare 远端（避免分片互相污染）。 */
  async function newRemote(label: string): Promise<string> {
    const bare = path.join(root, `remote-${label}.git`);
    await simpleGit().raw(["init", "--bare", "-b", "main", bare]);
    return bare.replace(/\\/g, "/");
  }

  function adapter(name: string, deviceId: string, remoteUrl: string): GitRepoRemote {
    return new GitRepoRemote({
      dir: path.join(root, name),
      deviceId,
      remoteUrl,
      author: { name: "tester", email: "tester@example.com" },
    });
  }

  it("初始化写入分片行尾规则（*.jsonl -text，git 视作不做行尾转换）", async () => {
    const remote = await newRemote("attr");
    const a = adapter("attr", "attr-a", remote);
    await a.init();
    const content = readFileSync(path.join(root, "attr", ".gitattributes"), "utf8");
    expect(content).toContain("*.jsonl -text");
    const attr = await simpleGit({ baseDir: path.join(root, "attr") }).raw([
      "check-attr", "text", "--", "events-attr-a.jsonl",
    ]);
    expect(attr).toContain("unset");
  }, TIMEOUT);

  it("双工作副本收敛：增量 fetch 只回新行，并集规范序一致", async () => {
    const remote = await newRemote("conv");
    const a = adapter("conv-a", "conv-a", remote);
    const b = adapter("conv-b", "conv-b", remote);
    await a.init();
    await b.init();

    await a.push([ev("a1", "conv-a", 1, 1), ev("a2", "conv-a", 2, 2)]);
    const bFirst = await b.fetch({});
    expect(bFirst.events.map((event) => event.eventId)).toEqual(["a1", "a2"]);

    const aAfterPush = await a.fetch({});
    expect(aAfterPush.events.map((event) => event.eventId)).toEqual(["a1", "a2"]);

    await b.push([ev("b1", "conv-b", 1, 1)]);
    const aSecond = await a.fetch(aAfterPush.state);
    expect(aSecond.events.map((event) => event.eventId)).toEqual(["b1"]);
    const bSecond = await b.fetch(bFirst.state);
    expect(bSecond.events.map((event) => event.eventId)).toEqual(["b1"]);

    const unionA = mergeSyncEvents(aAfterPush.events, aSecond.events);
    const unionB = mergeSyncEvents(bFirst.events, bSecond.events);
    expect(unionA.map((event) => event.eventId)).toEqual(["a1", "b1", "a2"]);
    expect(unionA.map((event) => event.eventId)).toEqual(unionB.map((event) => event.eventId));
  }, TIMEOUT);

  it("离线分叉保守合并：双方各自提交后 push 不冲突，并集无重", async () => {
    const remote = await newRemote("fork");
    const a = adapter("fork-a", "fork-a", remote);
    const b = adapter("fork-b", "fork-b", remote);
    await a.init();
    await b.init();
    const aBase = await a.fetch({});
    const bBase = await b.fetch({});

    await a.push([ev("fa1", "fork-a", 1, 1), ev("fa2", "fork-a", 2, 2)]);
    await b.push([ev("fb1", "fork-b", 1, 1)]); // b 未先 fetch a 的提交（离线分叉）

    const aAfter = await a.fetch(aBase.state);
    const bAfter = await b.fetch(bBase.state);
    const unionA = mergeSyncEvents(aBase.events, aAfter.events);
    const unionB = mergeSyncEvents(bBase.events, bAfter.events);
    expect(unionA.map((event) => event.eventId)).toEqual(["fa1", "fb1", "fa2"]);
    expect(unionA.map((event) => event.eventId)).toEqual(unionB.map((event) => event.eventId));
    expect(new Set(unionA.map((event) => event.eventId)).size).toBe(3);
  }, TIMEOUT);

  it("push 幂等：重复 eventId 不重复追加、不产生空提交", async () => {
    const remote = await newRemote("idem");
    const a = adapter("idem", "idem-a", remote);
    await a.init();
    const first = await a.push([ev("x1", "idem-a", 1, 1)]);
    expect(first.appended).toBe(1);
    expect(first.pushed).toBe(true);
    const second = await a.push([ev("x1", "idem-a", 1, 1), ev("x2", "idem-a", 2, 2)]);
    expect(second.appended).toBe(1);
    expect(second.skipped).toBe(1);
    const third = await a.push([ev("x1", "idem-a", 1, 1)]);
    expect(third.appended).toBe(0);
    expect(third.pushed).toBe(false);
    expect(third.commit).toBeNull();
    const shard = readFileSync(path.join(root, "idem", "events-idem-a.jsonl"), "utf8");
    expect(shard.split("\n").filter(Boolean)).toHaveLength(2);
  }, TIMEOUT);

  it("强制推送（历史重写）→ 前缀哈希失配 → 全量重读", async () => {
    const remote = await newRemote("force");
    const a = adapter("force-a", "force-a", remote);
    const b = adapter("force-b", "force-b", remote);
    await a.init();
    await b.init();
    await a.push([ev("r1", "force-a", 1, 1, "old")]);
    await a.push([ev("r2", "force-a", 2, 2, "two")]);
    const bState = await b.fetch({});
    expect(bState.events.map((event) => event.eventId)).toEqual(["r1", "r2"]);

    // A 重写历史：改 r1 文本 → amend 最近提交 → 强推（远端历史重写）
    const shardPath = path.join(root, "force-a", "events-force-a.jsonl");
    const lines = readFileSync(shardPath, "utf8").split("\n").filter(Boolean);
    lines[0] = JSON.stringify(ev("r1", "force-a", 1, 1, "rewritten"));
    writeFileSync(shardPath, lines.join("\n") + "\n");
    const aGit = simpleGit({ baseDir: path.join(root, "force-a") });
    await aGit.raw([...IDENTITY, "commit", "-a", "--amend", "--no-edit"]);
    await aGit.raw(["push", "--force", "origin", "main"]);

    const bAfter = await b.fetch(bState.state);
    expect(bAfter.reread).toContain("force-a");
    expect(bAfter.events.find((event) => event.eventId === "r1")?.payload.text).toBe("rewritten");
    expect(bAfter.events.find((event) => event.eventId === "r2")).toBeTruthy();
  }, TIMEOUT);

  it("半截尾行：读取只到最后一个换行；补全后增量读到", async () => {
    const remote = await newRemote("part");
    const a = adapter("part-a", "part-a", remote);
    const b = adapter("part-b", "part-b", remote);
    await a.init();
    await b.init();
    const shardPath = path.join(root, "part-a", "events-part-a.jsonl");
    const line1 = JSON.stringify(ev("p1", "part-a", 1, 1)) + "\n";
    const partial =
      '{"eventId":"p2","sessionId":"s1","type":"message.append","lamport":2,"deviceId":"part-a",' +
      '"seq":2,"ts":"2026-10-04T03:00:00.000Z","payl';
    writeFileSync(shardPath, line1 + partial);
    const aGit = simpleGit({ baseDir: path.join(root, "part-a") });
    await aGit.raw([...IDENTITY, "add", "--", "events-part-a.jsonl"]);
    await aGit.raw([...IDENTITY, "commit", "-m", "partial"]);
    await aGit.raw(["push", "origin", "main"]);

    const first = await b.fetch({});
    expect(first.events.map((event) => event.eventId)).toEqual(["p1"]);

    appendFileSync(shardPath, 'oad":{"role":"user","text":"msg","turnId":"turn-p2"}}\n');
    await aGit.raw([...IDENTITY, "commit", "-a", "-m", "complete"]);
    await aGit.raw(["push", "origin", "main"]);
    const second = await b.fetch(first.state);
    expect(second.events.map((event) => event.eventId)).toEqual(["p2"]);
  }, TIMEOUT);

  it("纯本地模式（无 remoteUrl）：push 仅提交，fetch/clone 读本地分片", async () => {
    const local = new GitRepoRemote({
      dir: path.join(root, "local"),
      deviceId: "local-a",
      author: { name: "tester", email: "tester@example.com" },
    });
    const pushed = await local.push([ev("l1", "local-a", 1, 1)]);
    expect(pushed.pushed).toBe(false);
    expect(pushed.commit).toBeTruthy();
    const fetched = await local.fetch({});
    expect(fetched.events.map((event) => event.eventId)).toEqual(["l1"]);
    const cloned = await local.clone();
    expect(cloned.events.map((event) => event.eventId)).toEqual(["l1"]);
  }, TIMEOUT);

  it("mergeSyncEvents：eventId 幂等（首见胜出）+ 规范序", () => {
    const list1 = [ev("m1", "dev-a", 2, 2), ev("m2", "dev-a", 1, 1)];
    const list2 = [ev("m1", "dev-b", 9, 9, "dup"), ev("m3", "dev-c", 3, 3)];
    const merged = mergeSyncEvents(list1, list2);
    expect(merged.map((event) => event.eventId)).toEqual(["m2", "m1", "m3"]);
    expect(merged.find((event) => event.eventId === "m1")?.deviceId).toBe("dev-a");
  });
});
