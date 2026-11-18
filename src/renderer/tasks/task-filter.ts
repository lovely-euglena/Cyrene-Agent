// 类型统一自 settings/scheduler（IPC 真实来源）；本文件只做展示过滤（不依赖 schedule.kind 分支）。
export type { ScheduledTask } from "../settings/scheduler/types";
import type { ScheduledTask } from "../settings/scheduler/types";

export interface SchedulePanelItems {
  mode: "today" | "upcoming" | "empty";
  totalCount: number;
  items: ScheduledTask[];
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseFutureFireAt(task: ScheduledTask, now: Date): Date | null {
  if (!task.enabled || !task.nextFireAt) return null;
  const fireAt = new Date(task.nextFireAt);
  if (Number.isNaN(fireAt.getTime())) return null;
  return fireAt.getTime() >= now.getTime() ? fireAt : null;
}

export function getSchedulePanelItems(
  tasks: ScheduledTask[],
  now = new Date(),
  limit = 3,
): SchedulePanelItems {
  const upcoming = tasks
    .map(task => ({ task, fireAt: parseFutureFireAt(task, now) }))
    .filter((entry): entry is { task: ScheduledTask; fireAt: Date } => entry.fireAt !== null)
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());

  const today = upcoming.filter(entry => isSameLocalDay(entry.fireAt, now));
  const source = today.length > 0 ? today : upcoming;

  return {
    mode: today.length > 0 ? "today" : (upcoming.length > 0 ? "upcoming" : "empty"),
    totalCount: source.length,
    items: source.slice(0, limit).map(entry => entry.task),
  };
}
