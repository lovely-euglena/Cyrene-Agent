/**
 * headless 定时任务参数（IKJK51）：
 *   `Cyrene.exe --scheduled-task <id> [--scheduled-history <histId>] [--scheduled-fire-at <iso>]`
 *
 * 由常驻托盘在 Electron 缺席时按需拉起；本实例只做「取任务 → 跑 runner →
 * 回写历史 → 通知 → 退出」，不建窗口/托盘（见 application.start 的 headless 分支）。
 */

export interface HeadlessScheduledArgs {
  taskId: string;
  /** 托盘预建的历史 id（running 条目复用；缺省由 runner 自生成）。 */
  historyId?: string;
  /** 计划触发时刻（ISO，已校验；非法/缺省按 now，且作为历史 firedAt 写入）。 */
  fireAt?: string;
}

export function parseHeadlessScheduledArgs(argv: readonly string[]): HeadlessScheduledArgs | null {
  const idx = argv.indexOf("--scheduled-task");
  if (idx < 0 || idx + 1 >= argv.length) return null;
  const taskId = argv[idx + 1];
  if (!taskId || taskId.startsWith("--")) return null;
  const readArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  // fireAt 必须是可解析 ISO：非法值不传入（避免 Invalid Date 落历史）。
  const rawFireAt = readArg("--scheduled-fire-at");
  const fireAt = rawFireAt && !Number.isNaN(new Date(rawFireAt).getTime()) ? rawFireAt : undefined;
  return { taskId, historyId: readArg("--scheduled-history"), fireAt };
}

export function headlessScheduledArgs(): HeadlessScheduledArgs | null {
  return parseHeadlessScheduledArgs(process.argv);
}
