import { beforeEach, describe, expect, it, vi } from "vitest";

// 替身链路经 tray-pipe 注入口注入（host-client 通过 acquireTrayPipeLink 取用）
const hoisted = vi.hoisted(() => ({ link: null as unknown }));

vi.mock("../tray-pipe", () => ({
  acquireTrayPipeLink: () => hoisted.link,
  isTrayPipeAvailable: () => false,
}));

import { createSchedulerHostClient } from "./host-client";
import type { TrayPipeLink } from "../tray-pipe";
import type { ScheduledTask } from "./types";

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
});
