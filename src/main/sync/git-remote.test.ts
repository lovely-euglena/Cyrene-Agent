import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRemoteError, GitRepoRemote, mergeSyncEvents } from "./git-remote";
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

  it("参数校验：非法 deviceId / remoteUrl / branch 直接拒绝", () => {
    const base = { dir: path.join(root, "validate"), author: { name: "tester", email: "tester@example.com" } };
    expect(() => new GitRepoRemote({ ...base, deviceId: "bad id" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", remoteUrl: "-u./evil" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", remoteUrl: "ftp://host/repo.git" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", branch: "-x" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", branch: "feat..x" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", branch: "x.lock" })).toThrow(GitRemoteError);
    expect(() => new GitRepoRemote({ ...base, deviceId: "ok", timeoutMs: 0 })).toThrow(GitRemoteError);
  });

  it(".gitattributes 已有但缺规则：自动追加（git 视作不做行尾转换）", async () => {
    const dir = path.join(root, "attr2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".gitattributes"), "*.md text\n", "utf8");
    const local = new GitRepoRemote({
      dir,
      deviceId: "attr2-a",
      author: { name: "tester", email: "tester@example.com" },
    });
    await local.init();
    const content = readFileSync(path.join(dir, ".gitattributes"), "utf8");
    expect(content).toContain("*.md text");
    expect(content).toContain("*.jsonl -text");
    const attr = await simpleGit({ baseDir: dir }).raw(["check-attr", "text", "--", "events-attr2-a.jsonl"]);
    expect(attr).toContain("unset");
  }, TIMEOUT);

  it("init 失败：错误消息脱敏（不含 remoteUrl 及其变形）", async () => {
    const missing = path.join(root, "missing", "repo.git").replace(/\\/g, "/");
    const adapter = new GitRepoRemote({
      dir: path.join(root, "sanitize"),
      deviceId: "sanitize-a",
      remoteUrl: missing,
      author: { name: "tester", email: "tester@example.com" },
    });
    let error: unknown = null;
    try {
      await adapter.init();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitRemoteError);
    const message = (error as Error).message;
    expect(message).not.toContain(missing);
    expect(message).not.toContain("missing");
    expect(message).toContain("<remote>");
  }, TIMEOUT);

  it("commit 失败：回滚本次追加（文件 + 暂存区），解除故障后重试成功", async () => {
    const remote = await newRemote("rollback");
    const a = adapter("rollback", "rollback-a", remote);
    await a.init();
    const aGit = simpleGit({ baseDir: path.join(root, "rollback") });
    await aGit.raw(["config", "commit.gpgsign", "true"]); // 注入提交失败（无签名密钥/程序）
    let code = "";
    try {
      await a.push([ev("rb1", "rollback-a", 1, 1)]);
    } catch (error) {
      code = (error as GitRemoteError).code;
    }
    expect(code).toBe("git");
    const shardPath = path.join(root, "rollback", "events-rollback-a.jsonl");
    const content = existsSync(shardPath) ? readFileSync(shardPath, "utf8") : "";
    expect(content).not.toContain("rb1");
    expect((await aGit.raw(["status", "--porcelain"])).trim()).toBe("");
    await aGit.raw(["config", "commit.gpgsign", "false"]);
    const retry = await a.push([ev("rb1", "rollback-a", 1, 1)]);
    expect(retry.appended).toBe(1);
    expect(retry.pushed).toBe(true);
  }, TIMEOUT);

  it("push 失败后同批重试自愈：未推送提交补推（无新事件）", async () => {
    const remote = await newRemote("healpush");
    const a = adapter("healpush", "healpush-a", remote);
    await a.init();
    const aGit = simpleGit({ baseDir: path.join(root, "healpush") });
    await aGit.raw(["remote", "set-url", "origin", path.join(root, "bad", "missing.git").replace(/\\/g, "/")]);
    let failed = false;
    try {
      await a.push([ev("hp1", "healpush-a", 1, 1)]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(readFileSync(path.join(root, "healpush", "events-healpush-a.jsonl"), "utf8")).toContain("hp1");
    await aGit.raw(["remote", "set-url", "origin", remote]);
    const healed = await a.push([ev("hp1", "healpush-a", 1, 1)]); // 同批重试：无新事件 → 自愈补推
    expect(healed.appended).toBe(0);
    expect(healed.pushed).toBe(true);
    const b = adapter("healpush-b", "healpush-b", remote);
    await b.init();
    const fetched = await b.fetch({});
    expect(fetched.events.map((event) => event.eventId)).toContain("hp1");
  }, TIMEOUT);

  it("文件收缩：offset 越界 → 全量重读", async () => {
    const remote = await newRemote("shrink");
    const a = adapter("shrink-a", "shrink-a", remote);
    const b = adapter("shrink-b", "shrink-b", remote);
    await a.init();
    await b.init();
    await a.push([ev("sh1", "shrink-a", 1, 1), ev("sh2", "shrink-a", 2, 2), ev("sh3", "shrink-a", 3, 3)]);
    const bFirst = await b.fetch({});
    expect(bFirst.events.map((event) => event.eventId)).toEqual(["sh1", "sh2", "sh3"]);
    const shardPath = path.join(root, "shrink-a", "events-shrink-a.jsonl");
    writeFileSync(shardPath, JSON.stringify(ev("sh1", "shrink-a", 1, 1)) + "\n");
    const aGit = simpleGit({ baseDir: path.join(root, "shrink-a") });
    await aGit.raw([...IDENTITY, "commit", "-a", "-m", "shrink"]);
    await aGit.raw(["push", "origin", "main"]);
    const bAfter = await b.fetch(bFirst.state);
    expect(bAfter.reread).toContain("shrink-a");
    expect(bAfter.events.map((event) => event.eventId)).toEqual(["sh1"]);
  }, TIMEOUT);

  it("append 自愈：半截尾行被修剪后再追加", async () => {
    const remote = await newRemote("trim");
    const a = adapter("trim-a", "trim-a", remote);
    await a.init();
    await a.push([ev("t1", "trim-a", 1, 1)]);
    const shardPath = path.join(root, "trim-a", "events-trim-a.jsonl");
    appendFileSync(shardPath, '{"eventId":"t2","broken'); // 模拟写入中断
    const outcome = await a.push([ev("t3", "trim-a", 3, 3)]);
    expect(outcome.appended).toBe(1);
    const content = readFileSync(shardPath, "utf8");
    expect(content).not.toContain("broken");
    expect(content).toContain('"t1"');
    expect(content).toContain('"t3"');
    expect(content.endsWith("\n")).toBe(true);
  }, TIMEOUT);

  it("坏行上报：index 为分片物理行号（fetch 与 clone 同口径）", async () => {
    const remote = await newRemote("badline");
    const a = adapter("badline-a", "badline-a", remote);
    await a.init();
    const shardPath = path.join(root, "badline-a", "events-badline-a.jsonl");
    writeFileSync(
      shardPath,
      [JSON.stringify(ev("g1", "badline-a", 1, 1)), "{not-json", JSON.stringify(ev("g2", "badline-a", 2, 2))].join("\n") + "\n",
    );
    const aGit = simpleGit({ baseDir: path.join(root, "badline-a") });
    await aGit.raw([...IDENTITY, "add", "--", "events-badline-a.jsonl"]);
    await aGit.raw([...IDENTITY, "commit", "-m", "badline"]);
    await aGit.raw(["push", "origin", "main"]);
    const b = adapter("badline-b", "badline-b", remote);
    await b.init();
    const fetched = await b.fetch({});
    expect(fetched.events.map((event) => event.eventId)).toEqual(["g1", "g2"]);
    expect(fetched.errors).toEqual([{ deviceId: "badline-a", index: 1, code: "E_SYNC_BAD_JSON" }]);
    const cloned = await b.clone();
    expect(cloned.errors).toEqual([{ deviceId: "badline-a", index: 1, code: "E_SYNC_BAD_JSON" }]);
  }, TIMEOUT);

  it("同设备双副本：分片分叉 push 冲突 → 保守中止（rebase 已回滚，不 force）", async () => {
    const remote = await newRemote("conflict");
    const a1 = adapter("conflict-a1", "conflict-a", remote);
    const a2 = adapter("conflict-a2", "conflict-a", remote);
    await a1.init();
    await a2.init();
    await a1.push([ev("c1", "conflict-a", 1, 1)]);
    await a2.fetch({});
    await a1.push([ev("c2", "conflict-a", 2, 2)]);
    let code = "";
    try {
      await a2.push([ev("c2b", "conflict-a", 2, 2)]);
    } catch (error) {
      code = (error as GitRemoteError).code;
    }
    expect(code).toBe("conflict");
    const a2Git = simpleGit({ baseDir: path.join(root, "conflict-a2") });
    expect((await a2Git.raw(["status", "--porcelain"])).trim()).toBe("");
    expect(existsSync(path.join(root, "conflict-a2", ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(path.join(root, "conflict-a2", ".git", "rebase-apply"))).toBe(false);
  }, TIMEOUT);

  it("宿主 env 含受限键（PAGER / GIT_*）时仍可 init/push（unsafe 放行覆盖全集）", async () => {
    const remote = await newRemote("hostenv");
    const templateDir = path.join(root, "empty-templates");
    mkdirSync(templateDir, { recursive: true });
    const saved = {
      PAGER: process.env.PAGER,
      GIT_PAGER: process.env.GIT_PAGER,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_PROXY_COMMAND: process.env.GIT_PROXY_COMMAND,
      GIT_TEMPLATE_DIR: process.env.GIT_TEMPLATE_DIR,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    };
    process.env.PAGER = "cat";
    process.env.GIT_PAGER = "cat";
    process.env.GIT_EXTERNAL_DIFF = "";
    process.env.GIT_PROXY_COMMAND = "";
    process.env.GIT_TEMPLATE_DIR = templateDir;
    process.env.GIT_CONFIG_COUNT = "0";
    try {
      const a = adapter("hostenv", "hostenv-a", remote);
      await a.init();
      const outcome = await a.push([ev("he1", "hostenv-a", 1, 1)]);
      expect(outcome.appended).toBe(1);
      expect(outcome.pushed).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, TIMEOUT);

  it("取消：signal 已中止时 git 调用以 aborted 错误码失败", async () => {
    const remote = await newRemote("abort");
    const controller = new AbortController();
    const a = new GitRepoRemote({
      dir: path.join(root, "abort"),
      deviceId: "abort-a",
      remoteUrl: remote,
      author: { name: "tester", email: "tester@example.com" },
      signal: controller.signal,
    });
    controller.abort();
    let code = "";
    try {
      await a.push([ev("ab1", "abort-a", 1, 1)]);
    } catch (error) {
      code = (error as GitRemoteError).code;
    }
    expect(code).toBe("aborted");
  }, TIMEOUT);
});
