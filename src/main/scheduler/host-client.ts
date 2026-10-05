/**
 * 调度宿主客户端（IKJK51）：Electron ↔ `cyrene-native --tray` 的 sched.* 协议。
 *
 * 复用 tray-pipe 共享链路（与托盘 UI 客户端同一 socket——TrayHost 单连接语义）：
 *   - request/reply：帧带 id，回复 {op:"reply", id, ok, error?, data?}
 *   - 事件：{op:"event", name:"sched.fire"|"sched.changed", data}
 *   - 连接建立后自动 sched.snapshot 建立任务镜像；断线自动重连（链路层），
 *     重连成功后重新握手
 *   - onHostLost：断连且管道确认缺失持续 30s（宿主进程不在）→ 触发运行期回退
 *
 * 协议口径见 docs/design/2026-10-05-scheduler-to-dotnet.md §4。
 */

import { acquireTrayPipeLink, isTrayPipeAvailable, type TrayPipeLink } from "../tray-pipe";
import type { ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

export interface SchedulerHostFireEvent {
  taskId: string;
  scheduledFireAt: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SchedulerHostClient {
  isConnected(): boolean;
  /** 连接（首次不等待管道出现——宿主不在则快速返回 false）。 */
  ensureConnected(timeoutMs?: number): Promise<boolean>;
  request<T = unknown>(op: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  send(op: string, payload?: Record<string, unknown>): void;
  /** 历史回写（sched.report）：断线时入队缓冲，重连后补发（IKJK51 复审 P1-1）。 */
  sendReport(entry: ScheduledTaskHistoryEntry): void;
  /** 等待缓冲的历史补发完成（headless 退出前调用；超时返回，不抛）。 */
  flushReports(timeoutMs?: number): Promise<void>;
  /** 任务镜像（含宿主内部字段；投影归调用方）。 */
  getTasks(): ScheduledTask[];
  /** 补拉快照（fire 事件与快照握手的竞态兜底）。 */
  refreshTasks(): Promise<void>;
  onChanged(cb: (tasks: ScheduledTask[]) => void): () => void;
  onFire(cb: (ev: SchedulerHostFireEvent) => void): () => void;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  /** 宿主确认丢失（管道缺失持续宽限）——运行期回退信号，一次性。 */
  onHostLost(cb: () => void): () => void;
  dispose(): void;
}

const REQUEST_TIMEOUT_MS = 8_000;
const HOST_LOST_GRACE_MS = 30_000;
const HOST_LOST_POLL_MS = 10_000;
const CONNECT_RETRY_MS = 250;

interface ReplyFrame {
  op?: string;
  id?: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  name?: string;
}

export function createSchedulerHostClient(): SchedulerHostClient {
  const link: TrayPipeLink = acquireTrayPipeLink();
  let tasks: ScheduledTask[] = [];
  let snapshotLoaded = false;
  let disposed = false;
  let seq = 0;
  const pending = new Map<string, PendingRequest>();
  const changedListeners = new Set<(tasks: ScheduledTask[]) => void>();
  const fireListeners = new Set<(ev: SchedulerHostFireEvent) => void>();
  const connListeners = new Set<(connected: boolean) => void>();
  const hostLostListeners = new Set<() => void>();
  let hostLostTimer: NodeJS.Timeout | null = null;
  let hostLostEmitted = false;
  let refreshInFlight: Promise<void> | null = null;
  /** 断线期间的历史回写缓冲（sched.report；重连后补发）。 */
  const reportOutbox: ScheduledTaskHistoryEntry[] = [];

  const offLine = link.onLine(handleLine);
  const offConn = link.onConnectionChange((connected) => {
    if (disposed) return;
    if (connected) {
      clearHostLostTimer();
      hostLostEmitted = false;
      void refreshSnapshot();
      flushOutbox();
    } else {
      snapshotLoaded = false;
      rejectPending(new Error("scheduler host disconnected"));
      scheduleHostLostWatch();
    }
    for (const cb of [...connListeners]) {
      try { cb(connected); } catch { /* ignore */ }
    }
  });

  function handleLine(line: string): void {
    let msg: ReplyFrame;
    try {
      msg = JSON.parse(line) as ReplyFrame;
    } catch {
      return;
    }
    if (msg.op === "reply" && typeof msg.id === "string") {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok === false) entry.reject(new Error(msg.error || "scheduler host request failed"));
      else entry.resolve(msg.data);
      return;
    }
    if (msg.op !== "event") return;
    if (msg.name === "sched.changed") {
      const data = msg.data as { tasks?: ScheduledTask[] } | undefined;
      if (Array.isArray(data?.tasks)) {
        tasks = data.tasks;
        snapshotLoaded = true;
        emitChanged();
      }
      return;
    }
    if (msg.name === "sched.fire") {
      const data = msg.data as SchedulerHostFireEvent | undefined;
      if (data?.taskId) {
        for (const cb of [...fireListeners]) {
          try { cb(data); } catch { /* ignore */ }
        }
      }
    }
  }

  async function refreshSnapshot(): Promise<void> {
    if (disposed || !link.isConnected()) return;
    if (refreshInFlight) return refreshInFlight;
    const attempt = (async () => {
      try {
        const data = await request<{ tasks?: ScheduledTask[] }>("sched.snapshot");
        if (Array.isArray(data?.tasks)) {
          tasks = data.tasks;
          snapshotLoaded = true;
          emitChanged();
        }
      } catch {
        /* 重连竞态：忽略，下一次连接/事件再对齐 */
      }
    })();
    refreshInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (refreshInFlight === attempt) refreshInFlight = null;
    }
  }

  async function ensureConnected(timeoutMs = 5_000): Promise<boolean> {
    if (disposed) return false;
    if (link.isConnected()) {
      if (!snapshotLoaded) await refreshSnapshot();
      return true;
    }
    if (await link.connect()) {
      if (!snapshotLoaded) await refreshSnapshot();
      return true;
    }
    if (!isTrayPipeAvailable()) return false; // 宿主不在：调用方快速回退
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !disposed) {
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
      if (link.isConnected()) {
        if (!snapshotLoaded) await refreshSnapshot();
        return true;
      }
      if (await link.connect()) {
        if (!snapshotLoaded) await refreshSnapshot();
        return true;
      }
      if (!isTrayPipeAvailable()) return false;
    }
    return link.isConnected();
  }

  function request<T = unknown>(op: string, payload?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (disposed) return Promise.reject(new Error("scheduler host client disposed"));
    if (!link.isConnected()) return Promise.reject(new Error("scheduler host not connected"));
    const id = `sreq-${++seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`scheduler host request timeout: ${op}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      link.send({ id, op, ...(payload ?? {}) });
    });
  }

  function send(op: string, payload?: Record<string, unknown>): void {
    if (disposed || !link.isConnected()) return;
    link.send({ op, ...(payload ?? {}) });
  }

  /**
   * 历史回写（sched.report）：连接可写即发；断线入缓冲，重连后补发。
   * 与 host-mode 的本地落盘回退互补——保证终态不静默丢失（IKJK51 复审 P1-1）。
   *
   * 已知边界（复审 P2-6，取舍声明，不实现）：outbox 无上限、report 无 ack——
   * 进程存活期的断线条数受「任务数 × 重试轮次」约束，极端断线长跑才会膨胀；
   * 补发只保证写入管道，宿主是否落盘无回执。同 id 覆盖语义在宿主侧（后到者
   * 赢）——超时 failed 条目可被同 id 的真实终态覆写，见 bootstrap.ts 超时分支。
   */
  function sendReport(entry: ScheduledTaskHistoryEntry): void {
    if (disposed) return;
    if (!link.isConnected()) {
      reportOutbox.push(entry);
      return;
    }
    link.send({ op: "sched.report", entry });
  }

  function flushOutbox(): void {
    if (disposed || reportOutbox.length === 0 || !link.isConnected()) return;
    const pending = reportOutbox.splice(0, reportOutbox.length);
    for (const entry of pending) link.send({ op: "sched.report", entry });
  }

  /**
   * 等待缓冲补发完成（headless 退出前调用）。
   * 已知边界（复审 P2-6）：无 ack，超时即返回——只保证「已尽量写管道」；
   * 仍未发完的条目留待重连补发，进程退出即丢失，由托盘宽限兜底终态。
   */
  async function flushReports(timeoutMs = 5_000): Promise<void> {
    if (disposed || reportOutbox.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (reportOutbox.length > 0 && Date.now() < deadline && !disposed) {
      if (link.isConnected()) flushOutbox();
      else await new Promise((r) => setTimeout(r, 200));
    }
  }

  function getTasks(): ScheduledTask[] {
    return tasks.map((task) => ({ ...task, allowedToolIds: [...(task.allowedToolIds ?? [])] }));
  }

  function emitChanged(): void {
    for (const cb of [...changedListeners]) {
      try { cb(getTasks()); } catch { /* ignore */ }
    }
  }

  function rejectPending(err: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function clearHostLostTimer(): void {
    if (hostLostTimer) {
      clearTimeout(hostLostTimer);
      hostLostTimer = null;
    }
  }

  /** 断连后周期探测：管道缺失（宿主进程不在）持续到宽限才发 hostLost。 */
  function scheduleHostLostWatch(): void {
    if (disposed || hostLostEmitted || hostLostTimer) return;
    const startedAt = Date.now();
    const tick = (): void => {
      hostLostTimer = null;
      if (disposed || hostLostEmitted) return;
      if (link.isConnected()) return; // 已重连
      const gone = !isTrayPipeAvailable();
      if (gone && Date.now() - startedAt >= HOST_LOST_GRACE_MS) {
        hostLostEmitted = true;
        for (const cb of [...hostLostListeners]) {
          try { cb(); } catch { /* ignore */ }
        }
        return;
      }
      hostLostTimer = setTimeout(tick, HOST_LOST_POLL_MS);
    };
    hostLostTimer = setTimeout(tick, HOST_LOST_POLL_MS);
  }

  return {
    isConnected: () => link.isConnected(),
    ensureConnected,
    request,
    send,
    sendReport,
    flushReports,
    getTasks,
    refreshTasks: refreshSnapshot,
    onChanged: (cb) => {
      changedListeners.add(cb);
      return () => changedListeners.delete(cb);
    },
    onFire: (cb) => {
      fireListeners.add(cb);
      return () => fireListeners.delete(cb);
    },
    onConnectionChange: (cb) => {
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    onHostLost: (cb) => {
      hostLostListeners.add(cb);
      return () => hostLostListeners.delete(cb);
    },
    dispose: () => {
      disposed = true;
      offLine();
      offConn();
      clearHostLostTimer();
      rejectPending(new Error("scheduler host client disposed"));
    },
  };
}

/**
 * TS 模式（开关关闭）下的保险（IKJK51）：通知托盘停用其调度，
 * 防止「登录项残留 + CYRENE_SCHEDULER_HOST 关闭」造成双调度。
 *
 * 复审 P1-2：原实现一次性 fire-and-forget（connect 失败即放弃）。现在带
 * 退避重试 + reply 回执；返回是否确认停用（调用方决定告警，失败不再静默）。
 */
export async function disarmSchedulerHost(options: {
  attempts?: number;
  replyTimeoutMs?: number;
} = {}): Promise<boolean> {
  const attempts = options.attempts ?? 5;
  const replyTimeoutMs = options.replyTimeoutMs ?? 3_000;
  const link = acquireTrayPipeLink();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 4_000)));
    }
    const connected = await link.connect();
    if (!connected) continue;
    const id = `sched-disarm-${Date.now()}-${attempt}`;
    const acked = await new Promise<boolean>((resolve) => {
      let settled = false;
      let off: () => void = () => { /* 占位：注册前同步回执时安全 */ };
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
        resolve(value);
      };
      timer = setTimeout(() => finish(false), replyTimeoutMs);
      off = link.onLine((line) => {
        try {
          const msg = JSON.parse(line) as { op?: string; id?: string; ok?: boolean };
          if (msg.op === "reply" && msg.id === id) finish(msg.ok !== false);
        } catch { /* 非 JSON 行忽略 */ }
      });
      link.send({ id, op: "sched.mode", enabled: false });
    });
    if (acked) return true;
  }
  return false;
}
