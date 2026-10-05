/**
 * 调度宿主模式适配（IKJK51）：host 模式 store/engine 代理 + 运行期回退/接管。
 *
 * - host 模式：store 读客户端镜像、写经 sched.* 管道；engine.fireNow 与
 *   sched.fire 事件都在本 Electron 内用现有 scheduler-runner 执行（历史经
 *   sched.report 回写宿主——单写者仍是托盘）。
 * - 运行期回退：宿主确认丢失（管道缺失持续宽限）→ 切本地 TS store+engine
 *   （同一份文件；宿主「先推进再派发」保证不重复触发）；宿主恢复 → 切回。
 * - store/engine 是动态代理：调用方（动作层 / 插件服务 / IPC）引用不变。
 *
 * 协议与边界见 docs/design/2026-10-05-scheduler-to-dotnet.md。
 */

import { isTaskEnabled } from "./execution-spec";
import { getSchedulerStore } from "./scheduler-store";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import type { SchedulerHostClient } from "./host-client";
import type {
  NewScheduledTaskInput,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPatch,
} from "./types";

/** host/local 双态 store 面（异步容忍：host 侧经管道；与 scheduler-store 同构）。 */
export interface SchedulerStoreSurface {
  load(): void;
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): ScheduledTask | Promise<ScheduledTask>;
  updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask | Promise<ScheduledTask>;
  deleteTask(id: string): boolean | Promise<boolean>;
  toggleTask(id: string, enabled: boolean): ScheduledTask | Promise<ScheduledTask>;
  deleteTasksByOwner(pluginId: string): number | Promise<number>;
  recordHistory(entry: ScheduledTaskHistoryEntry): void;
  getHistory(taskId: string, limit?: number): ScheduledTaskHistoryEntry[] | Promise<ScheduledTaskHistoryEntry[]>;
  onChange(cb: (tasks: ScheduledTask[]) => void): () => void;
}

/** host/local 双态 engine 面（动作层 fireNow + 子系统 start/stop）。 */
export interface SchedulerEngineSurface {
  start(): void;
  stop(): void;
  refreshPluginTasks(): void;
  fireNow(taskId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface HostModeAdapter {
  store: SchedulerStoreSurface;
  engine: SchedulerEngineSurface;
  /** 插件运行状态同步（宿主 CanRun 依据）；连接建立/恢复时自动重发。 */
  syncPluginRunningState(running: Record<string, boolean>): void;
  dispose(): void;
}

export interface HostModeDeps {
  client: SchedulerHostClient;
  runTask: (task: ScheduledTask, scheduledFireAt: Date, manual: boolean) => Promise<ScheduledRunResult>;
  canRunTask?: (task: ScheduledTask) => boolean;
  /** 本地回退 store（缺省 = 单例 scheduler-store；测试注入）。 */
  localStore?: SchedulerStoreSurface;
  /** 任何变更/模式切换后广播（Electron 窗口 + native 快照）。 */
  onChanged?: () => void;
  /** 运行期回退/接管日志（测试/排障）。 */
  onModeChange?: (mode: "host" | "local", reason: string) => void;
  /** 本地模式重连 watchdog 周期（缺省 15s；测试注入缩短）。 */
  watchdogIntervalMs?: number;
}

export function createHostModeAdapter(deps: HostModeDeps): HostModeAdapter {
  const { client } = deps;
  // 本地回退 store 惰性获取：host 模式正常路径不需要实例化（测试环境无 electron.app）
  let localStoreRef: SchedulerStoreSurface | null = deps.localStore ?? null;
  const local = (): SchedulerStoreSurface => {
    if (!localStoreRef) localStoreRef = getSchedulerStore();
    return localStoreRef;
  };
  let mode: "host" | "local" = "host";
  let localEngine: SchedulerEngine | null = null;
  let lastPluginState: Record<string, boolean> = {};
  let disposed = false;
  let watchdogTimer: NodeJS.Timeout | null = null;
  const running = new Set<string>();

  // ── host 侧实现 ──

  const hostStore: SchedulerStoreSurface = {
    load: () => { /* 宿主持有文件，不加载 */ },
    getTasks: () => client.getTasks(),
    addTask: (input) => client.request<ScheduledTask>("sched.add", { input }),
    updateTask: (id, patch) => client.request<ScheduledTask>("sched.update", { taskId: id, patch }),
    deleteTask: (id) => client.request<boolean>("sched.delete", { taskId: id }),
    toggleTask: (id, enabled) => client.request<ScheduledTask>("sched.update", { taskId: id, patch: { enabled } }),
    deleteTasksByOwner: (pluginId) => client.request<number>("sched.delete-owner", { pluginId }),
    recordHistory: (entry) => client.sendReport(entry),
    getHistory: (taskId, limit) => client.request<ScheduledTaskHistoryEntry[]>("sched.history", { taskId, limit }),
    onChange: (cb) => client.onChanged(cb),
  };

  // ── 动态代理（调用方引用稳定） ──

  const store: SchedulerStoreSurface = {
    load: () => { if (mode === "local") local().load(); },
    getTasks: () => (mode === "host" ? hostStore.getTasks() : local().getTasks()),
    addTask: (input) => (mode === "host" ? hostStore.addTask(input) : local().addTask(input)),
    updateTask: (id, patch) => (mode === "host" ? hostStore.updateTask(id, patch) : local().updateTask(id, patch)),
    deleteTask: (id) => (mode === "host" ? hostStore.deleteTask(id) : local().deleteTask(id)),
    toggleTask: (id, enabled) => (mode === "host" ? hostStore.toggleTask(id, enabled) : local().toggleTask(id, enabled)),
    deleteTasksByOwner: (pluginId) =>
      (mode === "host" ? hostStore.deleteTasksByOwner(pluginId) : local().deleteTasksByOwner(pluginId)),
    recordHistory: (entry) => {
      if (mode !== "host") {
        local().recordHistory(entry);
        return;
      }
      // 复审 P1-1：host 在线经 sched.report（客户端断线时缓冲补发）；
      // 断线/宿主不在时落本地文件（headless 离线主场景；托盘重启读同一文件对账）。
      if (client.isConnected()) client.sendReport(entry);
      else local().recordHistory(entry);
    },
    getHistory: (taskId, limit) =>
      (mode === "host" ? hostStore.getHistory(taskId, limit) : local().getHistory(taskId, limit)),
    onChange: (cb) => client.onChanged(cb),
  };

  const engine: SchedulerEngineSurface = {
    start: () => {
      if (mode === "host") {
        void client.ensureConnected().then((ok) => {
          if (ok) {
            // 协商：托盘调度启用（手动起的托盘可能未带 --scheduler）
            client.send("sched.mode", { enabled: true });
            syncPluginState();
          } else {
            promote("scheduler host unavailable at start");
          }
        });
      } else {
        localEngine?.start();
      }
    },
    stop: () => { if (mode === "local") localEngine?.stop(); },
    refreshPluginTasks: () => { if (mode === "local") localEngine?.refreshPluginTasks(); },
    fireNow: (taskId) => fireNow(taskId),
  };

  // ── 执行（本进程 runner；历史经 store.recordHistory → sched.report） ──

  function skippedEntry(task: ScheduledTask, at: Date, reason: string): ScheduledTaskHistoryEntry {
    return {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: task.id,
      taskTitle: task.title,
      firedAt: at.toISOString(),
      status: "skipped",
      reason,
      effectiveToolIds: [],
    };
  }

  async function runOne(task: ScheduledTask, scheduledFireAt: Date, manual: boolean): Promise<void> {
    if (running.has(task.id)) {
      if (!manual) store.recordHistory(skippedEntry(task, scheduledFireAt, "previous run still active"));
      return;
    }
    running.add(task.id);
    try {
      await deps.runTask(task, scheduledFireAt, manual);
    } finally {
      running.delete(task.id);
    }
  }

  async function fireNow(taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = store.getTasks().find((t) => t.id === taskId);
    if (!task) return { ok: false, reason: "task not found" };
    if (!isTaskEnabled(task)) return { ok: false, reason: "task is disabled" };
    if (deps.canRunTask && !deps.canRunTask(task)) return { ok: false, reason: "plugin not running" };
    if (running.has(task.id)) return { ok: false, reason: "task already running" };
    await runOne(task, new Date(), true);
    return { ok: true };
  }

  // ── 事件与模式切换 ──

  const offFire = client.onFire((ev) => {
    void (async () => {
      let task = store.getTasks().find((t) => t.id === ev.taskId);
      if (!task) {
        // 连接握手竞态：补拉一次镜像再试
        await client.refreshTasks();
        task = store.getTasks().find((t) => t.id === ev.taskId);
      }
      if (!task) return;
      const scheduledFireAt = new Date(ev.scheduledFireAt);
      // 复审 P2-7：执行路径复核启用/运行条件（与 fireNow 对齐，不信任管道写入者）。
      if (!isTaskEnabled(task)) {
        store.recordHistory(skippedEntry(task, scheduledFireAt, "task is disabled"));
        return;
      }
      if (deps.canRunTask && !deps.canRunTask(task)) {
        store.recordHistory(skippedEntry(task, scheduledFireAt, "plugin not running"));
        return;
      }
      await runOne(task, scheduledFireAt, false);
    })();
  });
  const offChanged = client.onChanged(() => deps.onChanged?.());
  const offHostLost = client.onHostLost(() => promote("scheduler host lost"));
  const offConn = client.onConnectionChange((connected) => {
    if (!connected) return;
    if (mode === "local") demote("scheduler host recovered");
    // 重连/接管后重申启用（托盘可能刚重启且未带 --scheduler）
    client.send("sched.mode", { enabled: true });
    syncPluginState();
  });

  function promote(reason: string): void {
    if (mode === "local") return;
    mode = "local";
    const store = local();
    store.load(); // 重读文件（宿主已把 nextFireAt 推进落盘）
    localEngine = new SchedulerEngine({
      // local 模式下即真实 scheduler-store（同步实现）；surface 为异步容忍类型
      store: store as SchedulerEngineDeps["store"],
      runTask: deps.runTask,
      ...(deps.canRunTask ? { canRunTask: deps.canRunTask } : {}),
    });
    localEngine.start();
    // 复审 P1-2：本地模式常驻 watchdog——周期尝试 connect，成功即切回 host
    // （托盘可能在 Electron 之后才启动/重启；首次 ensureConnected 失败后
    //  共享链路不会自动重连，必须由这里持续发起）。
    startWatchdog();
    deps.onModeChange?.("local", reason);
    deps.onChanged?.();
  }

  function demote(reason: string): void {
    if (mode !== "local") return;
    mode = "host";
    stopWatchdog();
    localEngine?.stop();
    localEngine = null;
    deps.onModeChange?.("host", reason);
    deps.onChanged?.();
  }

  function startWatchdog(): void {
    if (disposed || watchdogTimer) return;
    const timer = setInterval(() => {
      if (disposed || mode !== "local") {
        stopWatchdog();
        return;
      }
      void client.ensureConnected().then((ok) => {
        // 连接事件通常已触发 demote；这里兜底（监听器缺失/连接已建立但未广播）。
        if (ok && mode === "local") demote("scheduler host recovered (watchdog)");
      }).catch(() => undefined);
    }, deps.watchdogIntervalMs ?? 15_000);
    (timer as { unref?: () => void }).unref?.();
    watchdogTimer = timer;
  }

  function stopWatchdog(): void {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function syncPluginState(): void {
    if (mode !== "host" || !client.isConnected()) return;
    client.send("sched.plugin-state", { running: lastPluginState });
  }

  return {
    store,
    engine,
    syncPluginRunningState: (runningMap) => {
      lastPluginState = { ...runningMap };
      syncPluginState();
    },
    dispose: () => {
      disposed = true;
      stopWatchdog();
      offFire();
      offChanged();
      offHostLost();
      offConn();
      localEngine?.stop();
      localEngine = null;
    },
  };
}
