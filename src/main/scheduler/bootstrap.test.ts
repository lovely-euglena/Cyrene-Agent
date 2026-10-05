// scheduler/bootstrap 生命周期测试。
// 核心回归点（Task 1）：createSchedulerSubsystem 在构造期不加载 store、不注册 IPC、
// 不启动 engine —— initialize / start / stop 必须显式调用。
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("./scheduler-store", () => ({
  getSchedulerStore: vi.fn(),
}));

vi.mock("./scheduler-ipc", () => ({
  registerSchedulerIpc: vi.fn(),
}));

// 避免拉起真实 tool registry / CyreneAgent（级联重依赖）
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] },
}));
vi.mock("../orchestrator/cyrene-agent", () => ({
  // 永不 complete 的 Observable：headless 超时看门狗用例需要运行悬挂。
  CyreneAgent: class {
    lastResult: unknown = undefined;
    runWithEvents(): { subscribe: () => { unsubscribe: () => void } } {
      return { subscribe: () => ({ unsubscribe: () => { /* noop */ } }) };
    }
  },
}));

// eslint-disable-next-line import/first
import {
  createSchedulerSubsystem,
  type SchedulerSubsystemDeps,
} from "./bootstrap";
// eslint-disable-next-line import/first
import type { SchedulerHostClient } from "./host-client";
// eslint-disable-next-line import/first
import type { ScheduledTask } from "./types";

function makeSchedulerDeps(
  overrides: Partial<SchedulerSubsystemDeps> = {},
): SchedulerSubsystemDeps {
  return {
    agentRuntime: {} as SchedulerSubsystemDeps["agentRuntime"],
    getReactChatWindow: () => null,
    ...overrides,
  };
}

function makeFakeStore() {
  return {
    load: vi.fn(),
    onChange: vi.fn(),
    getTasks: vi.fn(() => []),
    updateTask: vi.fn(),
    recordHistory: vi.fn(),
  };
}

function makeFakeEngine() {
  return { start: vi.fn(), stop: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSchedulerSubsystem lifecycle", () => {
  it("does not load the store, register IPC, or start the engine in createSchedulerSubsystem", () => {
    const store = makeFakeStore();
    const engine = makeFakeEngine();
    const createEngine = vi.fn(() => engine);
    const registerIpc = vi.fn();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        createEngine: createEngine as unknown as NonNullable<SchedulerSubsystemDeps["createEngine"]>,
        registerIpc: registerIpc as unknown as NonNullable<SchedulerSubsystemDeps["registerIpc"]>,
      }),
    );
    expect(store.load).not.toHaveBeenCalled();
    expect(registerIpc).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(store.load).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledOnce();
    expect(engine.start).not.toHaveBeenCalled();
  });

  it("start() and stop() only drive the engine", () => {
    const store = makeFakeStore();
    const engine = makeFakeEngine();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        createEngine: (() => engine) as unknown as NonNullable<SchedulerSubsystemDeps["createEngine"]>,
      }),
    );
    subsystem.initialize();
    subsystem.start();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.stop).not.toHaveBeenCalled();
    subsystem.stop();
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it("initialize() is idempotent", () => {
    const store = makeFakeStore();
    const registerIpc = vi.fn();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        registerIpc: registerIpc as unknown as NonNullable<SchedulerSubsystemDeps["registerIpc"]>,
      }),
    );
    subsystem.initialize();
    subsystem.initialize();
    expect(store.load).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledOnce();
  });
});

// ── headless（--scheduled-task）链路：复审 P1-1/P1-5 ──

function headlessTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "后台任务",
    prompt: "p",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "09:00" },
    nextFireAt: null,
    toolMode: "all-enabled",
    allowedToolIds: [],
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as ScheduledTask;
}

function fakeHostClient(overrides: Partial<SchedulerHostClient> = {}): SchedulerHostClient {
  return {
    isConnected: () => false,
    ensureConnected: async () => false,
    request: async () => { throw new Error("not connected"); },
    send: () => { /* noop */ },
    sendReport: () => { /* noop */ },
    flushReports: async () => { /* noop */ },
    getTasks: () => [],
    refreshTasks: async () => { /* noop */ },
    onChanged: () => () => { /* noop */ },
    onFire: () => () => { /* noop */ },
    onConnectionChange: () => () => { /* noop */ },
    onHostLost: () => () => { /* noop */ },
    dispose: () => { /* noop */ },
    ...overrides,
  };
}

describe("runScheduledTaskForHeadless（复审 P1-1/P1-5）", () => {
  const originalTimeout = process.env.CYRENE_SCHEDULED_TASK_TIMEOUT_MS;

  beforeEach(() => {
    process.env.CYRENE_SCHEDULED_TASK_TIMEOUT_MS = "30";
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.CYRENE_SCHEDULED_TASK_TIMEOUT_MS;
    else process.env.CYRENE_SCHEDULED_TASK_TIMEOUT_MS = originalTimeout;
  });

  it("连接失败 → 回退本地 scheduled-tasks.json 执行并透传超时 failed 历史", async () => {
    const store = makeFakeStore();
    store.getTasks.mockReturnValue([headlessTask()]);
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient({ ensureConnected: async () => false }),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));

    const result = await subsystem.runScheduledTaskForHeadless!("task-1", "hist-1", "2026-10-05T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
    expect(store.recordHistory).toHaveBeenCalledWith(expect.objectContaining({
      id: "hist-1",
      taskId: "task-1",
      status: "failed",
      reason: "timeout",
    }));
  });

  it("连接失败且本地也没有任务 → task not found（不再空转）", async () => {
    const store = makeFakeStore();
    store.getTasks.mockReturnValue([]);
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient(),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));
    await expect(subsystem.runScheduledTaskForHeadless!("missing")).resolves.toEqual({
      ok: false,
      error: "task not found",
    });
    expect(store.recordHistory).not.toHaveBeenCalled();
  });

  it("连接成功但镜像缺任务 → 补拉快照后仍缺 → 回退本地执行", async () => {
    const store = makeFakeStore();
    store.getTasks.mockReturnValue([headlessTask()]);
    const refreshTasks = vi.fn(async () => { /* noop */ });
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient({ ensureConnected: async () => true, refreshTasks }),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));
    const result = await subsystem.runScheduledTaskForHeadless!("task-1", "hist-1");
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(result.error).toContain("timeout");
  });
});
