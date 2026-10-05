import { beforeEach, describe, expect, it, vi } from "vitest";

// 替身链路经 tray-pipe 注入口注入（host-client 通过 acquireTrayPipeLink 取用）
const hoisted = vi.hoisted(() => ({ link: null as unknown }));

vi.mock("../tray-pipe", () => ({
  acquireTrayPipeLink: () => hoisted.link,
  isTrayPipeAvailable: () => false,
}));

import { createSchedulerHostClient, disarmSchedulerHost } from "./host-client";
import type { TrayPipeLink } from "../tray-pipe";
import type { ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

class FakeLink implements TrayPipeLink {
  connected = false;
  readonly sent: Record<string, unknown>[] = [];
  private readonly lineCbs = new Set<(line: string) => void>();
  private readonly connCbs = new Set<(connected: boolean) => void>();

  isConnected(): boolean { return this.connected; }
  async connect(): Promise<boolean> { this.setConnected(true); return true; }
  send(frame: Record<string, unknown>): void { this.sent.push(frame); }
  onLine(cb: (line: string) => void): () => void {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }
  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connCbs.add(cb);
    return () => this.connCbs.delete(cb);
  }
  dispose(): void { /* noop */ }

  setConnected(value: boolean): void {
    this.connected = value;
    for (const cb of [...this.connCbs]) cb(value);
  }
  emit(line: string): void {
    for (const cb of [...this.lineCbs]) cb(line);
  }
  lastFrame(op: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((frame) => frame.op === op);
  }
  replyFor(op: string, data: unknown): void {
    const frame = this.lastFrame(op);
    if (!frame) throw new Error(`no sent frame for op: ${op}`);
    this.emit(JSON.stringify({ op: "reply", id: frame.id, ok: true, data }));
  }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "T",
    prompt: "p",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: null,
    runCount: 0,
    toolMode: "all-enabled",
    allowedToolIds: [],
    mode: "work",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as ScheduledTask;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setupConnected(tasks: ScheduledTask[] = []): Promise<{ link: FakeLink; client: ReturnType<typeof createSchedulerHostClient> }> {
  const link = new FakeLink();
  hoisted.link = link;
  const client = createSchedulerHostClient();
  const pending = client.ensureConnected();
  await tick();
  link.replyFor("sched.snapshot", { tasks });
  await pending;
  return { link, client };
}

describe("createSchedulerHostClient（IKJK51 sched.* 协议）", () => {
  beforeEach(() => {
    hoisted.link = null;
  });

  it("连接后 sched.snapshot 建立镜像（getTasks 克隆隔离）", async () => {
    const { client } = await setupConnected([task()]);
    const tasks = client.getTasks();
    expect(tasks).toHaveLength(1);
    tasks[0].allowedToolIds.push("mutated");
    expect(client.getTasks()[0].allowedToolIds).toEqual([]);
  });

  it("request/reply 按 id 对账；错误回执 reject", async () => {
    const { link, client } = await setupConnected();
    const okPending = client.request("sched.add", { input: { title: "x" } });
    await tick();
    link.replyFor("sched.add", { id: "new" });
    await expect(okPending).resolves.toEqual({ id: "new" });

    const errPending = client.request("sched.update", { taskId: "t" });
    await tick();
    const frame = link.lastFrame("sched.update");
    expect(frame).toBeTruthy();
    link.emit(JSON.stringify({ op: "reply", id: frame?.id, ok: false, error: "boom" }));
    await expect(errPending).rejects.toThrow("boom");
  });

  it("未连接时 request 立即失败", async () => {
    hoisted.link = new FakeLink();
    const client = createSchedulerHostClient();
    await expect(client.request("sched.snapshot")).rejects.toThrow("not connected");
  });

  it("sched.changed 刷新镜像并通知；sched.fire 触发回调", async () => {
    const { link, client } = await setupConnected([]);
    const changed: ScheduledTask[][] = [];
    const fires: string[] = [];
    client.onChanged((tasks) => changed.push(tasks));
    client.onFire((ev) => fires.push(ev.taskId));

    link.emit(JSON.stringify({ op: "event", name: "sched.changed", data: { tasks: [task({ id: "t9" })] } }));
    expect(client.getTasks()[0].id).toBe("t9");
    expect(changed).toHaveLength(1);

    link.emit(JSON.stringify({
      op: "event",
      name: "sched.fire",
      data: { taskId: "t9", scheduledFireAt: "2026-10-05T00:00:00.000Z" },
    }));
    expect(fires).toEqual(["t9"]);
  });

  it("断连且管道缺失持续宽限 → onHostLost（一次性）", async () => {
    const { link, client } = await setupConnected([]);
    const lost: boolean[] = [];
    client.onHostLost(() => lost.push(true));
    vi.useFakeTimers();
    try {
      link.setConnected(false);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(lost).toEqual([true]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lost).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("请求超时：reject 并清理 pending（复审 P2-5）", async () => {
    const { client } = await setupConnected();
    vi.useFakeTimers();
    try {
      const pending = client.request("sched.add", {});
      const assertion = expect(pending).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(8_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("断线：pending 全部 reject；迟到回执静默忽略（复审 P2-5）", async () => {
    const { link, client } = await setupConnected();
    const pending = client.request("sched.add", {});
    const assertion = expect(pending).rejects.toThrow("disconnected");
    link.setConnected(false);
    await assertion;
    expect(() => link.emit(JSON.stringify({ op: "reply", id: "sreq-1", ok: true, data: {} }))).not.toThrow();
  });

  it("重连：重新拉取快照刷新镜像（复审 P2-5）", async () => {
    const { link, client } = await setupConnected([task({ id: "old" })]);
    link.setConnected(false);
    link.setConnected(true);
    await tick();
    link.replyFor("sched.snapshot", { tasks: [task({ id: "new" })] });
    await tick();
    expect(client.getTasks()[0].id).toBe("new");
  });

  it("sendReport：断线缓冲、重连补发；flushReports 等待补发（复审 P1-1）", async () => {
    const { link, client } = await setupConnected();
    link.setConnected(false);
    client.sendReport({ id: "h1" } as ScheduledTaskHistoryEntry);
    expect(link.sent.some((f) => f.op === "sched.report")).toBe(false);

    link.setConnected(true);
    expect(link.sent.filter((f) => f.op === "sched.report").length).toBe(1);

    // 缓冲 + flushReports：重连后补发完成
    link.setConnected(false);
    client.sendReport({ id: "h2" } as ScheduledTaskHistoryEntry);
    const flush = client.flushReports(1_000);
    await tick();
    link.setConnected(true);
    await flush;
    expect(link.sent.filter((f) => f.op === "sched.report").length).toBe(2);
  });

  it("disarm：带 id 回执确认成功（复审 P1-2）", async () => {
    const link = new FakeLink();
    hoisted.link = link;
    const pending = disarmSchedulerHost({ attempts: 2, replyTimeoutMs: 500 });
    await tick();
    const frame = link.lastFrame("sched.mode");
    expect(frame).toMatchObject({ op: "sched.mode", enabled: false });
    link.emit(JSON.stringify({ op: "reply", id: frame?.id, ok: true }));
    await expect(pending).resolves.toBe(true);
  });

  it("disarm：connect 失败重试耗尽返回 false（不静默成功）", async () => {
    const link = new FakeLink();
    link.connect = async () => false;
    hoisted.link = link;
    await expect(disarmSchedulerHost({ attempts: 1, replyTimeoutMs: 50 })).resolves.toBe(false);
  });
});
