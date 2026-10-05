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
const agentBehavior = vi.hoisted(() => ({ mode: "hang" as "hang" | "success" }));

vi.mock("../orchestrator/cyrene-agent", () => ({
  // 默认永不 complete 的 Observable：headless 超时看门狗用例需要运行悬挂。
  // "success" 模式同步 complete 并置成功终态，覆盖成功路径（flushReports 用例）。
  CyreneAgent: class {
    lastResult: unknown = undefined;
    runWithEvents(): {
      subscribe: (observer: {
        next: (event: unknown) => void;
        complete: () => void;
        error: (err: unknown) => void;
      }) => { unsubscribe: () => void };
    } {
      return {
        subscribe: (observer) => {
          if (agentBehavior.mode === "success") {
            this.lastResult = { reply: "done", terminal: { status: "success" } };
            // 异步 complete：runner 在 subscribe 返回前回调会引用未初始化的 sub（TDZ）
            queueMicrotask(() => {
              observer.next({ type: "RUN_FINISHED" });
              observer.complete();
            });
          }
          return { unsubscribe: () => { /* noop */ } };
        },
      };
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

/** 复审 P1（第二轮）：模拟真实 getSchedulerStore——load 前 getTasks 恒空，load 后命中；记录调用序。 */
function makeLazyStore(tasks: ScheduledTask[]) {
  const store = makeFakeStore();
  const order: string[] = [];
  let loaded = false;
  store.load.mockImplementation(() => { order.push("load"); loaded = true; });
  store.getTasks.mockImplementation(() => { order.push("getTasks"); return loaded ? tasks : []; });
  return { store, order };
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

  it("连接失败 → 回退前先 load（load 前空 / load 后命中），命中后透传超时 failed 历史", async () => {
    const { store, order } = makeLazyStore([headlessTask()]);
    const flushReports = vi.fn(async () => { /* noop */ });
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient({ ensureConnected: async () => false, flushReports }),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));

    const result = await subsystem.runScheduledTaskForHeadless!("task-1", "hist-1", "2026-10-05T00:00:00.000Z");

    // 命中任务本身即证明 load 生效（否则会在 load 前读空数组 → task not found）
    expect(order[0]).toBe("load");
    expect(store.load).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
    expect(store.recordHistory).toHaveBeenCalledWith(expect.objectContaining({
      id: "hist-1",
      taskId: "task-1",
      status: "failed",
      reason: "timeout",
    }));
    // 复审 P2-6：超时路径不 flush（report 滞留 outbox，由托盘宽限兜底）
    expect(flushReports).not.toHaveBeenCalled();
  });

  it("连接失败且本地也没有任务 → load 后仍空 → task not found（不再空转）", async () => {
    const { store, order } = makeLazyStore([]);
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient(),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));
    await expect(subsystem.runScheduledTaskForHeadless!("missing")).resolves.toEqual({
      ok: false,
      error: "task not found",
    });
    expect(order[0]).toBe("load");
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.recordHistory).not.toHaveBeenCalled();
  });

  it("连接成功但镜像缺任务 → 补拉快照后仍缺 → 回退本地（先 load）执行", async () => {
    const { store, order } = makeLazyStore([headlessTask()]);
    const refreshTasks = vi.fn(async () => { /* noop */ });
    const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
      store: store as unknown as SchedulerSubsystemDeps["store"],
      hostClient: fakeHostClient({ ensureConnected: async () => true, refreshTasks }),
      agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
    }));
    const result = await subsystem.runScheduledTaskForHeadless!("task-1", "hist-1");
    expect(refreshTasks).toHaveBeenCalledOnce();
    expect(order[0]).toBe("load");
    expect(result.error).toContain("timeout");
  });

  it("执行成功 → 退出前 flushReports 补发窗口，返回 ok（复审 P2-6）", async () => {
    agentBehavior.mode = "success";
    try {
      const { store, order } = makeLazyStore([headlessTask()]);
      const flushReports = vi.fn(async () => { /* noop */ });
      const subsystem = createSchedulerSubsystem(makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        hostClient: fakeHostClient({ ensureConnected: async () => false, flushReports }),
        agentRuntime: { buildSchedulerOptions: async () => ({ messages: [] }) } as never,
      }));

      const result = await subsystem.runScheduledTaskForHeadless!("task-1", "hist-1");

      expect(order[0]).toBe("load");
      expect(result).toEqual({ ok: true });
      expect(flushReports).toHaveBeenCalledOnce();
      expect(flushReports).toHaveBeenCalledWith(5_000);
    } finally {
      agentBehavior.mode = "hang";
    }
  });
});
