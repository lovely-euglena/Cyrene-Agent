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
  /** 宿主通知（host 模式：tray.notify 气泡）。 */
  notifyHost?(title: string, content: string): void;
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

  let initialized = false;
  return {
    store,
    engine,
    ...(hostAdapter
      ? {
          syncPluginRunningState: hostAdapter.syncPluginRunningState,
          notifyHost: (title: string, content: string) => {
            deps.hostClient?.send("tray.notify", { title, content });
          },
        }
      : {}),
    /** IKJK51：headless 执行——host 模式先确保管道连接（历史经 sched.report 回写宿主）。 */
    async runScheduledTaskForHeadless(taskId: string, historyId?: string, fireAt?: string) {
      if (deps.hostClient) await deps.hostClient.ensureConnected();
      const task = store.getTasks().find((t) => t.id === taskId);
      if (!task) return { ok: false, error: "task not found" };
      try {
        await runner.runScheduledTask(task, fireAt ? new Date(fireAt) : new Date(), false, historyId);
        return { ok: true };
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
