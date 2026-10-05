import { describe, expect, it, vi } from "vitest";
import { createHostModeAdapter, type SchedulerStoreSurface } from "./host-mode";
import { computeExecutionSpecFingerprint, taskExecutionSpec } from "./execution-spec";
import type { SchedulerHostClient, SchedulerHostFireEvent } from "./host-client";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "T",
    prompt: "p",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: "2026-10-06T00:00:00.000Z",
    runCount: 0,
    toolMode: "all-enabled",
    allowedToolIds: [],
    mode: "work",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as ScheduledTask;
}

function runOk(): ScheduledRunResult {
  return { ok: true, historyId: "h", effectiveToolIds: [] };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeClient(initial: ScheduledTask[] = []) {
  let tasks = initial;
  let connected = true;
  const sent: Array<{ op: string; payload?: Record<string, unknown> }> = [];
  const requests: Array<{ op: string; payload?: Record<string, unknown> }> = [];
  const sets = {
    changed: new Set<(tasks: ScheduledTask[]) => void>(),
    fire: new Set<(ev: SchedulerHostFireEvent) => void>(),
    conn: new Set<(connected: boolean) => void>(),
    lost: new Set<() => void>(),
  };
  const client: SchedulerHostClient = {
    isConnected: () => connected,
    ensureConnected: async () => connected,
    request: async (op, payload) => {
      requests.push({ op, payload });
      switch (op) {
        case "sched.add": return task({ id: "new" });
        case "sched.update": return task();
        case "sched.delete": return true;
        case "sched.delete-owner": return 2;
        case "sched.history": return [{ id: "h1" } as ScheduledTaskHistoryEntry];
        default: return task();
      }
    },
    send: (op, payload) => { sent.push({ op, payload }); },
    sendReport: (entry) => { sent.push({ op: "sched.report", payload: { entry } }); },
    flushReports: async () => { /* noop */ },
    getTasks: () => tasks.map((t) => ({ ...t, allowedToolIds: [...t.allowedToolIds] })),
    refreshTasks: async () => { /* noop */ },
    onChanged: (cb) => { sets.changed.add(cb); return () => sets.changed.delete(cb); },
    onFire: (cb) => { sets.fire.add(cb); return () => sets.fire.delete(cb); },
    onConnectionChange: (cb) => { sets.conn.add(cb); return () => sets.conn.delete(cb); },
    onHostLost: (cb) => { sets.lost.add(cb); return () => sets.lost.delete(cb); },
    dispose: () => { /* noop */ },
  };
  return {
    client,
    sent,
    requests,
    sets,
    setTasks: (next: ScheduledTask[]) => { tasks = next; },
    setConnected: (value: boolean) => {
      connected = value;
      for (const cb of [...sets.conn]) cb(value);
    },
  };
}

function fakeLocalStore(tasks: ScheduledTask[] = []) {
  const calls: string[] = [];
  const store: SchedulerStoreSurface = {
    load: () => { calls.push("load"); },
    getTasks: () => tasks,
    addTask: () => { calls.push("add"); return task(); },
    updateTask: () => { calls.push("update"); return task(); },
    deleteTask: () => { calls.push("delete"); return true; },
    toggleTask: () => task(),
    deleteTasksByOwner: () => 0,
    recordHistory: () => { calls.push("record"); },
    getHistory: () => [],
    onChange: () => () => { /* noop */ },
  };
  return { store, calls };
}

describe("createHostModeAdapter（IKJK51 host 模式适配）", () => {
  it("host 模式写操作经 sched.* 管道；历史经 sched.report", async () => {
    const { client, requests, sent } = fakeClient();
    const adapter = createHostModeAdapter({ client, runTask: vi.fn(async () => runOk()) });

    await adapter.store.addTask({} as never);
    await adapter.store.updateTask("task-1", { enabled: false });
    await adapter.store.deleteTask("task-1");
    await adapter.store.deleteTasksByOwner("plugin-a");
    await adapter.store.getHistory("task-1", 10);
    adapter.store.recordHistory({ id: "h1" } as ScheduledTaskHistoryEntry);

    expect(requests.map((r) => r.op)).toEqual([
      "sched.add",
      "sched.update",
      "sched.delete",
      "sched.delete-owner",
      "sched.history",
    ]);
    expect(sent).toContainEqual({ op: "sched.report", payload: { entry: { id: "h1" } } });
  });

  it("fireNow：镜像校验 + 本地 runner 执行（manual=true）", async () => {
    const runTask = vi.fn(async () => runOk());
    const { client } = fakeClient([task()]);
    const adapter = createHostModeAdapter({ client, runTask });

    await expect(adapter.engine.fireNow("task-1")).resolves.toEqual({ ok: true });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][2]).toBe(true);

    await expect(adapter.engine.fireNow("missing")).resolves.toEqual({ ok: false, reason: "task not found" });
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("fireNow：停用任务 / 插件未运行分别拒绝", async () => {
    const runTask = vi.fn(async () => runOk());
    const disabled = fakeClient([task({ enabled: false })]);
    const adapterA = createHostModeAdapter({ client: disabled.client, runTask });
    await expect(adapterA.engine.fireNow("task-1")).resolves.toEqual({ ok: false, reason: "task is disabled" });

    // 插件任务须带「与执行规格一致」的指纹，才进入 canRun 判定
    const pluginTaskObj = task({ ownerPluginId: "plugin-a", pluginUserEnabled: true, enabled: false });
    pluginTaskObj.approvalFingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTaskObj));
    const pluginTask = fakeClient([pluginTaskObj]);
    const adapterB = createHostModeAdapter({ client: pluginTask.client, runTask, canRunTask: () => false });
    await expect(adapterB.engine.fireNow("task-1")).resolves.toEqual({ ok: false, reason: "plugin not running" });
  });

  it("sched.fire 事件 → 本地 runner 执行（manual=false）", async () => {
    const runTask = vi.fn(async () => runOk());
    const { client, sets } = fakeClient([task()]);
    createHostModeAdapter({ client, runTask });

    for (const cb of sets.fire) cb({ taskId: "task-1", scheduledFireAt: "2026-10-06T00:00:00.000Z" });
    await tick();
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][2]).toBe(false);
  });

  it("宿主丢失 → 本地接管（重读文件 + 启本地引擎）；恢复 → 切回宿主", () => {
    const runTask = vi.fn(async () => runOk());
    const local = fakeLocalStore([task({ id: "local-1" })]);
    const modes: string[] = [];
    const { client, sets } = fakeClient([task({ id: "host-1" })]);
    const adapter = createHostModeAdapter({
      client,
      runTask,
      localStore: local.store,
      onModeChange: (mode) => modes.push(mode),
    });
    try {
      expect(adapter.store.getTasks()[0].id).toBe("host-1");

      for (const cb of sets.lost) cb();
      expect(local.calls).toContain("load");
      expect(adapter.store.getTasks()[0].id).toBe("local-1");

      for (const cb of sets.conn) cb(true);
      expect(modes).toEqual(["local", "host"]);
      expect(adapter.store.getTasks()[0].id).toBe("host-1");
    } finally {
      adapter.dispose();
    }
  });

  it("插件运行状态同步经 sched.plugin-state", () => {
    const { client, sent } = fakeClient();
    const adapter = createHostModeAdapter({ client, runTask: vi.fn(async () => runOk()) });
    adapter.syncPluginRunningState({ "plugin-a": true });
    expect(sent).toContainEqual({ op: "sched.plugin-state", payload: { running: { "plugin-a": true } } });
  });

  it("历史回写：在线经 sched.report；断线落本地回退（复审 P1-1）", () => {
    const { client, sent, setConnected } = fakeClient();
    const local = fakeLocalStore();
    const adapter = createHostModeAdapter({ client, runTask: vi.fn(async () => runOk()), localStore: local.store });
    try {
      adapter.store.recordHistory({ id: "h1" } as ScheduledTaskHistoryEntry);
      expect(sent).toContainEqual({ op: "sched.report", payload: { entry: { id: "h1" } } });

      setConnected(false);
      adapter.store.recordHistory({ id: "h2" } as ScheduledTaskHistoryEntry);
      expect(sent).not.toContainEqual({ op: "sched.report", payload: { entry: { id: "h2" } } });
      expect(local.calls).toContain("record");
    } finally {
      adapter.dispose();
    }
  });

  it("sched.fire：停用任务写 skipped 不执行（复审 P2-7）", async () => {
    const runTask = vi.fn(async () => runOk());
    const { client, sent, sets } = fakeClient([task({ enabled: false })]);
    createHostModeAdapter({ client, runTask });
    for (const cb of sets.fire) cb({ taskId: "task-1", scheduledFireAt: "2026-10-06T00:00:00.000Z" });
    await tick();
    expect(runTask).not.toHaveBeenCalled();
    const entry = sent
      .map((f) => f.payload?.entry as ScheduledTaskHistoryEntry | undefined)
      .find((e) => e?.reason === "task is disabled");
    expect(entry).toMatchObject({ status: "skipped", taskId: "task-1" });
  });

  it("sched.fire：插件未运行写 skipped 不执行（复审 P2-7）", async () => {
    const runTask = vi.fn(async () => runOk());
    const pluginTaskObj = task({ ownerPluginId: "plugin-a", pluginUserEnabled: true, enabled: false });
    pluginTaskObj.approvalFingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(pluginTaskObj));
    const { client, sent, sets } = fakeClient([pluginTaskObj]);
    createHostModeAdapter({ client, runTask, canRunTask: () => false });
    for (const cb of sets.fire) cb({ taskId: "task-1", scheduledFireAt: "2026-10-06T00:00:00.000Z" });
    await tick();
    expect(runTask).not.toHaveBeenCalled();
    const entry = sent
      .map((f) => f.payload?.entry as ScheduledTaskHistoryEntry | undefined)
      .find((e) => e?.reason === "plugin not running");
    expect(entry).toMatchObject({ status: "skipped", taskId: "task-1" });
  });

  it("watchdog：本地模式周期重连成功后切回 host（复审 P1-2）", async () => {
    const local = fakeLocalStore([task({ id: "local-1" })]);
    const { client, sets } = fakeClient([task({ id: "host-1" })]);
    const modes: string[] = [];
    const adapter = createHostModeAdapter({
      client,
      runTask: vi.fn(async () => runOk()),
      localStore: local.store,
      watchdogIntervalMs: 5,
      onModeChange: (mode) => modes.push(mode),
    });
    try {
      for (const cb of sets.lost) cb();
      expect(modes).toEqual(["local"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(modes).toContain("host");
      expect(adapter.store.getTasks()[0].id).toBe("host-1");
    } finally {
      adapter.dispose();
    }
  });

  it("watchdog：ensureConnected 先败后成 → 切回 host（复审 P2-6）", async () => {
    const local = fakeLocalStore([task({ id: "local-1" })]);
    const { client, sets } = fakeClient([task({ id: "host-1" })]);
    let attempts = 0;
    client.ensureConnected = async () => {
      attempts += 1;
      return attempts >= 3;
    };
    const modes: string[] = [];
    const adapter = createHostModeAdapter({
      client,
      runTask: vi.fn(async () => runOk()),
      localStore: local.store,
      watchdogIntervalMs: 5,
      onModeChange: (mode) => modes.push(mode),
    });
    try {
      for (const cb of sets.lost) cb();
      expect(modes).toEqual(["local"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(modes).toEqual(["local", "host"]);
      expect(adapter.store.getTasks()[0].id).toBe("host-1");
    } finally {
      adapter.dispose();
    }
  });
});
