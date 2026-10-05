import type { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ActiveConversationSelection } from "../chats/active-conversation-registry";
import * as chatsStore from "../chats/chats-store";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { ScheduledTask } from "./types";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { getSchedulerStore } from "./scheduler-store";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { createSchedulerRunner } from "./scheduler-runner";
import { filterToolsForTask } from "./tool-filter";
import { broadcastSchedulerChanged } from "./scheduler-actions";
import { createHostModeAdapter, type SchedulerEngineSurface, type SchedulerStoreSurface } from "./host-mode";
import type { SchedulerHostClient } from "./host-client";

export interface SchedulerSubsystemDeps {
  agentRuntime: AgentRuntime;
  getReactChatWindow(): BrowserWindow | null;
  store?: ReturnType<typeof getSchedulerStore>;
  createEngine?: (deps: SchedulerEngineDeps) => SchedulerEngine;
  registerIpc?: typeof registerSchedulerIpc;
  /** 共享 IPC scope；传入后 scheduler IPC 由组合根统一注销。 */
  ipc?: IpcScope;
  /**
   * 运行条件检查（在有效启用状态之上）：宿主注入"插件是否正在运行"，
   * 插件停用时定时触发和手动触发都被跳过。
   */
  canRunTask?: (task: ScheduledTask) => boolean;
  /** IKJK51：调度宿主客户端（host 模式）；缺省 = 纯 TS scheduler。 */
  hostClient?: SchedulerHostClient;
  /** 生命周期事件发布器：调度轮次事件与 scheduler:finished 由此发布。 */
  publishLifecycle?: LifecyclePublisher;
  conversationJournal?: ConversationJournalService;
  getActiveConversation?: () => ActiveConversationSelection | null;
}

export interface SchedulerSubsystem {
  store: SchedulerStoreSurface;
  engine: SchedulerEngineSurface;
  initialize(): void;
  start(): void;
  stop(): void;
  /** 插件运行状态同步（host 模式：下发宿主 CanRun 依据；TS 模式：undefined）。 */
  syncPluginRunningState?(running: Record<string, boolean>): void;
  /** headless 执行（IKJK51）：`--scheduled-task` 实例调用；host 模式下先确保连接。 */
  runScheduledTaskForHeadless?(taskId: string, historyId?: string, fireAt?: string): Promise<{ ok: boolean; error?: string }>;
}

/** headless 执行超时（默认 30 分钟；`CYRENE_SCHEDULED_TASK_TIMEOUT_MS` 覆盖，测试用）。 */
const DEFAULT_HEADLESS_TASK_TIMEOUT_MS = 30 * 60_000;

function resolveHeadlessTaskTimeoutMs(): number {
  const raw = Number(process.env.CYRENE_SCHEDULED_TASK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEADLESS_TASK_TIMEOUT_MS;
}

/** --scheduled-fire-at 合法性：非法/缺失一律按 now（调用方无需再判）。 */
function parseFireAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 组装 scheduler 子系统。构造期只创建 store 引用 / runner / engine，
 * 不加载 store、不注册 IPC、不启动定时器 —— initialize / start / stop 必须显式调用。
 */
export function createSchedulerSubsystem(deps: SchedulerSubsystemDeps): SchedulerSubsystem {
  const localStore = deps.store ?? getSchedulerStore();
  // host 模式（IKJK51）：store/engine 换宿主适配器；runner 经闭包读最终 store。
  let store: SchedulerStoreSurface = localStore;

  const runner = createSchedulerRunner({
    buildOptions: (task) => deps.agentRuntime.buildSchedulerOptions(task),
    createRunSession: (task) => {
      if (!task.workspaceBinding) throw new Error("定时任务缺少绑定工作区");
      const session = chatsStore.createSession({
        title: `定时任务：${task.title}`,
        mode: task.mode === "code" ? "code" : "work",
      });
      if (!chatsStore.setWorkspaceBinding(session.id, task.workspaceBinding)) {
        throw new Error("无法将会话绑定到定时任务工作区");
      }
      const win = deps.getReactChatWindow();
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(IPC.CHATS_CHANGED); } catch { /* 窗口关闭时不阻断任务运行 */ }
      }
      return session.id;
    },
    getChatWebContents: () => {
      const win = deps.getReactChatWindow();
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    recordHistory: (entry) => store.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
    ...(deps.publishLifecycle ? { publishLifecycle: deps.publishLifecycle } : {}),
    ...(deps.conversationJournal ? { conversationJournal: deps.conversationJournal } : {}),
    ...(deps.getActiveConversation ? { getActiveConversation: deps.getActiveConversation } : {}),
  });

  const engineDeps: SchedulerEngineDeps = {
    store: localStore,
    runTask: runner.runScheduledTask,
    ...(deps.canRunTask ? { canRunTask: deps.canRunTask } : {}),
  };
  const hostAdapter = deps.hostClient
    ? createHostModeAdapter({
        client: deps.hostClient,
        runTask: runner.runScheduledTask,
        localStore,
        ...(deps.canRunTask ? { canRunTask: deps.canRunTask } : {}),
        onChanged: broadcastSchedulerChanged,
      })
    : null;
  if (hostAdapter) store = hostAdapter.store;
  const engine: SchedulerEngineSurface = hostAdapter
    ? hostAdapter.engine
    : deps.createEngine
      ? deps.createEngine(engineDeps)
      : new SchedulerEngine(engineDeps);
  const registerIpc = deps.registerIpc ?? registerSchedulerIpc;

  /** 复审 P1-5：headless 超时终态——写 failed 历史（host 断线走本地落盘）后由调用方退出进程。 */
  function recordHeadlessTimeout(
    task: ScheduledTask,
    historyId: string,
    scheduledFireAt: Date,
    timeoutMs: number,
  ): void {
    try {
      store.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: scheduledFireAt.toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed",
        reason: "timeout",
        errorMessage: `执行超时（>${Math.round(timeoutMs / 60_000)} 分钟），已中止`,
        effectiveToolIds: filterToolsForTask(task, toolRegistry.getAllTools()).map((tool) => tool.id),
      });
    } catch {
      // 历史写入失败不阻塞退出；托盘进程退出兜底仍会把 running 标为中断。
    }
  }

  let initialized = false;
  return {
    store,
    engine,
    ...(hostAdapter
      ? { syncPluginRunningState: hostAdapter.syncPluginRunningState }
      : {}),
    /** IKJK51：headless 执行——host 模式先确保管道连接（历史经 sched.report 回写宿主）。 */
    async runScheduledTaskForHeadless(taskId: string, historyId?: string, fireAt?: string) {
      const scheduledFireAt = parseFireAt(fireAt) ?? new Date();
      const effectiveHistoryId = historyId ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let task: ScheduledTask | undefined;
      if (deps.hostClient) {
        // 复审 P1-1：连接结果必须用于分支——连接失败回退本地文件执行。
        const connected = await deps.hostClient.ensureConnected();
        if (connected) {
          task = store.getTasks().find((t) => t.id === taskId);
          if (!task) {
            // 连接成功但快照未到位（握手竞态）：补拉一次
            await deps.hostClient.refreshTasks();
            task = store.getTasks().find((t) => t.id === taskId);
          }
        }
      }
      if (!task) {
        // 连接失败 / 任务查不到：回退读本地 scheduled-tasks.json（离线主场景）。
        task = localStore.getTasks().find((t) => t.id === taskId);
      }
      if (!task) return { ok: false, error: "task not found" };

      const timeoutMs = resolveHeadlessTaskTimeoutMs();
      const validatedFireAt = parseFireAt(fireAt) ? fireAt : undefined;
      const runPromise = runner.runScheduledTask(task, scheduledFireAt, false, effectiveHistoryId, validatedFireAt);
      let timedOut = false;
      const timeout = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => { timedOut = true; resolve("timeout"); }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const outcome = await Promise.race([runPromise, timeout]);
        if (typeof outcome === "string" || timedOut) {
          // 复审 P1-5：执行超时看门狗——写 failed 历史后返回，进程退出即中止运行。
          recordHeadlessTimeout(task, effectiveHistoryId, scheduledFireAt, timeoutMs);
          return { ok: false, error: `timeout after ${Math.round(timeoutMs / 60_000)}min` };
        }
        // 复审 P1-1：终态报告可能因断线入缓冲——退出前给一次补发窗口。
        if (deps.hostClient) await deps.hostClient.flushReports(5_000);
        // runner 自报失败（如运行时错误）时透传，供托盘日志/退出码使用。
        return outcome.ok ? { ok: true } : { ok: false, error: outcome.error ?? "scheduled task failed" };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    /** 加载持久化 store + 注册 IPC。idempotent。 */
    initialize(): void {
      if (initialized) return;
      initialized = true;
      store.load();
      registerIpc(store, engine, () => toolRegistry.getAllTools(), deps.ipc);
    },
    /** 只启动 engine 定时器（必须在 MCP 恢复之后调用）。 */
    start(): void {
      engine.start();
    },
    /** 只停止 engine 定时器。 */
    stop(): void {
      engine.stop();
    },
  };
}
