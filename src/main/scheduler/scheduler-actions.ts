// 定时任务动作层：scheduler IPC（渲染页）与 native 设置窗（WPF「定时任务」
// section）共用同一实现，保证两侧行为一致：
//   - 插件任务的启停/编辑走授权转换（pluginTaskTogglePatch / authorizePluginTaskUpdatePatch）
//   - 渲染投影剔除宿主内部字段（approvalFingerprint / pluginUserEnabled）
//   - 每次写操作后统一广播（Electron 窗口 SCHEDULER_CHANGED + native tasks 窗
//     快照 + native 设置窗设置快照）

import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { pushSchedulerSnapshotToNative, pushSettingsSnapshotToNative } from "../windows/native-windows-bridge";
import {
  authorizePluginTaskUpdatePatch,
  isPluginTaskEffectivelyEnabled,
  pluginTaskTogglePatch,
} from "./execution-spec";
import type { SchedulerEngine } from "./scheduler-engine";
import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskPatch, SchedulerIpcResult } from "./types";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

export interface SchedulerStoreLike {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): unknown;
  updateTask(id: string, patch: ScheduledTaskPatch): unknown;
  deleteTask(id: string): boolean;
  toggleTask(id: string, enabled: boolean): unknown;
  getHistory(taskId: string, limit?: number): unknown[];
}

export interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

/** 渲染层任务视图：不含授权指纹、用户授权位等宿主内部字段。 */
export type RendererScheduledTask = Omit<ScheduledTask, "approvalFingerprint" | "pluginUserEnabled">;

/**
 * 渲染层投影：插件任务的界面启停状态映射为有效授权状态
 * （用户已确认且执行规格指纹一致），与引擎实际运行判断保持同一口径。
 */
export function projectTaskForRenderer(task: ScheduledTask): RendererScheduledTask {
  const { approvalFingerprint: _fingerprint, pluginUserEnabled: _userEnabled, ...rest } = task;
  if (!task.ownerPluginId) return rest;
  return { ...rest, enabled: isPluginTaskEffectivelyEnabled(task) };
}

/** 变更广播：Electron 窗口 + native 任务窗快照 + native 设置窗设置快照。 */
export function broadcastSchedulerChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC.SCHEDULER_CHANGED); } catch { /* ignore */ }
    }
  }
  // native 三件套旁路（CYRENE_NATIVE_WINDOWS）：拉快照直接推
  // state.tasks 帧（native 窗无 IPC 通道，不能只发"变更了"信号——
  // 空帧会被 C# ApplyState 当成清空任务列表）
  pushSchedulerSnapshotToNative();
  // WPF 设置窗「定时任务」section 的列表随设置快照刷新（窗未开时 no-op）
  pushSettingsSnapshotToNative();
}

export interface SchedulerActionsDeps {
  store: SchedulerStoreLike;
  engine: SchedulerEngine;
  getTools(): ToolDefinition[];
  /** 覆盖变更通知（测试注入）；缺省 = broadcastSchedulerChanged。 */
  notifyChanged?: () => void;
}

export interface SchedulerActions {
  list(): SchedulerIpcResult<RendererScheduledTask[]>;
  getTools(): SchedulerIpcResult<SchedulerToolInfo[]>;
  add(input: NewScheduledTaskInput): SchedulerIpcResult<unknown>;
  update(id: string, patch: ScheduledTaskPatch): SchedulerIpcResult<unknown>;
  remove(id: string): SchedulerIpcResult<boolean>;
  toggle(id: string, enabled: boolean): SchedulerIpcResult<unknown>;
  history(taskId: string, limit?: number): SchedulerIpcResult<unknown[]>;
  fireNow(id: string): Promise<SchedulerIpcResult<true> | { ok: false; reason?: string }>;
}

export function createSchedulerActions(deps: SchedulerActionsDeps): SchedulerActions {
  const notify = deps.notifyChanged ?? broadcastSchedulerChanged;
  const ok = <T,>(value: T): SchedulerIpcResult<T> => ({ ok: true, value });
  const fail = <T,>(err: unknown): SchedulerIpcResult<T> => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });

  const actions: SchedulerActions = {
    list: () => ok(deps.store.getTasks().map(projectTaskForRenderer)),

    getTools: () => ok(deps.getTools().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      enabled: tool.enabled,
      risk: tool.risk ?? "safe",
    }))),

    add(input) {
      try {
        const result = ok(deps.store.addTask(input));
        notify();
        return result;
      } catch (err) {
        return fail(err);
      }
    },

    update(id, patch) {
      try {
        const current = deps.store.getTasks().find((task) => task.id === id);
        // 插件任务的保存编辑走授权转换：按保存后的规格重算指纹，剔除宿主不变量字段。
        const effective = current?.ownerPluginId
          ? authorizePluginTaskUpdatePatch(current, patch)
          : patch;
        const result = ok(deps.store.updateTask(id, effective));
        notify();
        return result;
      } catch (err) {
        return fail(err);
      }
    },

    remove(id) {
      try {
        const result = ok(deps.store.deleteTask(id));
        notify();
        return result;
      } catch (err) {
        return fail(err);
      }
    },

    toggle(id, enabled) {
      try {
        const task = deps.store.getTasks().find((item) => item.id === id);
        // 用户任务直接写 enabled；插件任务的启停写授权位，启用时按当前规格写入指纹。
        const patch = task?.ownerPluginId
          ? pluginTaskTogglePatch(task, enabled)
          : { enabled };
        const result = ok(deps.store.updateTask(id, patch));
        notify();
        return result;
      } catch (err) {
        return fail(err);
      }
    },

    history(taskId, limit) {
      try {
        return ok(deps.store.getHistory(taskId, limit));
      } catch (err) {
        return fail(err);
      }
    },

    async fireNow(id) {
      try {
        const result = await deps.engine.fireNow(id);
        return result.ok ? ok(true) : { ok: false, reason: result.reason };
      } catch (err) {
        return fail(err);
      }
    },
  };
  return actions;
}