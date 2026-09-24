// 定时任务动作层测试：写操作走 store + 变更通知；插件任务启停走授权位；
// 渲染投影剔除宿主内部字段。

import { describe, expect, it, vi } from "vitest";
import { createSchedulerActions, projectTaskForRenderer } from "./scheduler-actions";
import type { ScheduledTask } from "./types";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "测试任务",
    prompt: "hello",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    toolMode: "all-enabled",
    allowedToolIds: [],
    mode: "work",
    createdAt: 0,
    nextFireAt: null,
    ownerPluginId: undefined,
    approvalFingerprint: "fp",
    pluginUserEnabled: true,
    ...overrides,
  } as ScheduledTask;
}

function harness(tasks: ScheduledTask[] = [task()]) {
  const store = {
    getTasks: vi.fn(() => tasks),
    addTask: vi.fn((input: unknown) => ({ id: "new", input })),
    updateTask: vi.fn((id: string, patch: unknown) => ({ id, patch })),
    deleteTask: vi.fn(() => true),
    toggleTask: vi.fn(() => true),
    getHistory: vi.fn(() => [{ firedAt: 1, status: "success" }]),
  };
  const engine = { fireNow: vi.fn(async () => ({ ok: true })) };
  const notify = vi.fn();
  const actions = createSchedulerActions({
    store,
    engine: engine as never,
    getTools: () => [{
      id: "read_file",
      name: "读文件",
      description: "",
      enabled: true,
      risk: "safe",
    } as never],
    notifyChanged: notify,
  });
  return { actions, store, engine, notify };
}

describe("createSchedulerActions", () => {
  it("list 投影剔除 approvalFingerprint/pluginUserEnabled", () => {
    const { actions } = harness();
    const result = actions.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).not.toHaveProperty("approvalFingerprint");
    expect(result.value[0]).not.toHaveProperty("pluginUserEnabled");
  });

  it("用户任务 toggle 直接写 enabled + 通知", () => {
    const { actions, store, notify } = harness();
    const result = actions.toggle("task-1", false);
    expect(result.ok).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("task-1", { enabled: false });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("插件任务 toggle 走授权位（pluginTaskTogglePatch）+ 通知", () => {
    const { actions, store, notify } = harness([task({ ownerPluginId: "plugin-a", enabled: false })]);
    actions.toggle("task-1", true);
    const patch = store.updateTask.mock.calls[0][1] as Record<string, unknown>;
    // 授权 patch 改写 pluginUserEnabled/approvalFingerprint，而不是裸 enabled
    expect(patch).toHaveProperty("pluginUserEnabled");
    expect(patch).not.toHaveProperty("enabled");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("add/remove/history 转发 store 并通知（history 不通知）", () => {
    const { actions, store, notify } = harness();
    actions.add({ title: "t", prompt: "p" } as never);
    actions.remove("task-1");
    actions.history("task-1", 10);
    expect(store.addTask).toHaveBeenCalledTimes(1);
    expect(store.deleteTask).toHaveBeenCalledWith("task-1");
    expect(store.getHistory).toHaveBeenCalledWith("task-1", 10);
    // add + remove 各通知一次，history 是只读
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("getTools 输出渲染层字段（risk 兜底 safe）", () => {
    const { actions } = harness();
    const result = actions.getTools();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ id: "read_file", enabled: true, risk: "safe" });
  });

  it("fireNow 透传引擎失败原因", async () => {
    const { actions, engine } = harness();
    engine.fireNow.mockResolvedValueOnce({ ok: false, reason: "task already running" } as never);
    const result = await actions.fireNow("task-1");
    expect(result).toEqual({ ok: false, reason: "task already running" });
  });

  it("projectTaskForRenderer：插件任务 enabled 映射为有效授权状态（非裸 enabled）", () => {
    // pluginUserEnabled=false + 指纹不匹配 → 有效状态 false，即便裸 enabled=true
    const projected = projectTaskForRenderer(task({
      ownerPluginId: "p",
      enabled: true,
      pluginUserEnabled: false,
      approvalFingerprint: "stale",
    }));
    expect(projected.enabled).toBe(false);
  });
});