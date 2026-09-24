import type { IpcScope } from "../application/ipc-scope";
import { createIpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import {
  createSchedulerActions,
  projectTaskForRenderer,
  type RendererScheduledTask,
  type SchedulerStoreLike,
  type SchedulerToolInfo,
} from "./scheduler-actions";
import type { SchedulerEngine } from "./scheduler-engine";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

export type { RendererScheduledTask, SchedulerStoreLike, SchedulerToolInfo };
export { projectTaskForRenderer };

let schedulerIpcRegistered = false;

/** 注册 scheduler IPC。idempotent：同一 channel 重复注册会抛错。 */
export function registerSchedulerIpc(
  store: SchedulerStoreLike,
  engine: SchedulerEngine,
  getTools: () => ToolDefinition[],
  ipcOption?: IpcScope,
): void {
  if (schedulerIpcRegistered) return;
  schedulerIpcRegistered = true;
  const ipc = ipcOption ?? createIpcScope();

  // 动作层与 native 设置窗共用（授权转换/投影/变更广播行为一致）
  const actions = createSchedulerActions({ store, engine, getTools });

  ipc.handle(IPC.SCHEDULER_LIST, () => actions.list());
  ipc.handle(IPC.SCHEDULER_ADD, (_event, input) => actions.add(input));
  ipc.handle(IPC.SCHEDULER_UPDATE, (_event, id: string, patch) => actions.update(id, patch));
  ipc.handle(IPC.SCHEDULER_DELETE, (_event, id: string) => actions.remove(id));
  ipc.handle(IPC.SCHEDULER_TOGGLE, (_event, id: string, enabled: boolean) => actions.toggle(id, enabled));
  ipc.handle(IPC.SCHEDULER_GET_HISTORY, (_event, taskId: string, limit?: number) => actions.history(taskId, limit));
  ipc.handle(IPC.SCHEDULER_FIRE_NOW, (_event, id: string) => actions.fireNow(id));
  ipc.handle(IPC.SCHEDULER_GET_TOOLS, () => actions.getTools());
}