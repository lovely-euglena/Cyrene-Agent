/**
 * 子进程登记与退出兜底回收。
 *
 * 背景：主进程会 spawn 多个长驻子进程（cyrene-native 各模式、embed sidecar、
 * 截图 helper、LSP server、.NET 插件进程等）。正常退出路径各自 dispose，
 * 但崩溃 / 强杀 / 清理超时路径可能留下孤儿进程（用户报「退出后有进程残留」）。
 *
 * 这里做统一登记 + 「退出前杀干净」兜底：
 *   - app.on("will-quit")：受控清理之后的最后一道闸（tree-kill 全部登记 PID）
 *   - process.on("exit")：同步兜底（强杀 / 提前退出路径）
 * Windows 用 `taskkill /F /T`（整棵进程树，含孙进程）；其它平台 SIGKILL。
 *
 * 与既有清理的关系：各模块的 dispose 仍是首选（优雅收敛），本模块是兜底，
 * 重复 kill 同一 PID 无害（失败静默）。
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { debugLog } from "./agent-log";

export interface TrackedProcess {
  pid: number;
  label: string;
}

const tracked = new Map<number, TrackedProcess>();
let installed = false;

/** 登记一个长驻子进程（exit 时自动移除）。 */
export function trackChildProcess(child: ChildProcess | null | undefined, label: string): void {
  const pid = child?.pid;
  if (!pid) return;
  tracked.set(pid, { pid, label });
  child.once("exit", () => {
    tracked.delete(pid);
  });
}

/** 登记已知 PID（如 win32 下由库返回的子进程）。 */
export function trackPid(pid: number, label: string): void {
  if (!pid) return;
  tracked.set(pid, { pid, label });
}

/** 主动移除登记（进程已被某模块回收）。 */
export function untrackChildProcess(pid?: number): void {
  if (pid) tracked.delete(pid);
}

export function listTrackedProcesses(): TrackedProcess[] {
  return [...tracked.values()];
}

/**
 * 同步整树杀掉所有登记子进程（退出路径专用：不能用异步 API）。
 * 返回实际尝试的条目数，便于日志/测试断言。
 */
export function killTrackedChildrenSync(reason = "exit"): number {
  const entries = [...tracked.values()];
  if (entries.length === 0) return 0;
  debugLog(`[ChildProcesses] killing ${entries.length} tracked children (${reason}): ${entries.map((e) => `${e.label}#${e.pid}`).join(", ")}`);
  for (const entry of entries) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(entry.pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    } catch {
      /* 尽力而为：单个失败不影响其余 */
    }
    tracked.delete(entry.pid);
  }
  return entries.length;
}

/**
 * 安装退出兜底（幂等）。`onWillQuit` 由调用方注入（组合根持有 app），
 * 避免本模块直接依赖 electron。
 */
export function installChildProcessReaper(onWillQuit: (listener: () => void) => void): void {
  if (installed) return;
  installed = true;
  onWillQuit(() => {
    killTrackedChildrenSync("will-quit");
  });
  process.on("exit", () => {
    killTrackedChildrenSync("process-exit");
  });
}

/** 仅供测试：重置登记表与安装标志。 */
export function resetChildProcessReaperForTest(): void {
  tracked.clear();
  installed = false;
}
