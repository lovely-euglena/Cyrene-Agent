import { app } from "electron";

/** Snipaste 命令行截图支持度。
 * `snip --block -o clipboard` 是 Snipaste Beta 版提供的 CLI；稳定版不识别
 * 这组参数，启动时本体直接弹"命令行参数错误"（用户视角：功能坏了）。
 * 预检读 exe 版本信息里的 Beta 标记，稳定版直接给可读错误，不再触发弹窗。 */
export type SnipasteCliSupport = "beta" | "stable" | "unknown";

const QUICK_EXIT_MS = 1500;

/** 读取可执行文件版本字符串；读不到返回 null（判 unknown，走行为探测兜底）。 */
export function defaultReadVersion(executable: string): string | null {
  try {
    return app.getFileVersion(executable) || null;
  } catch {
    return null;
  }
}

/** 版本字符串 → CLI 支持度。版本信息缺失/读取失败/注入实现抛错 = unknown。 */
export function detectSnipasteCliSupport(
  executable: string,
  readVersion: (path: string) => string | null = defaultReadVersion,
): SnipasteCliSupport {
  let version: string | null;
  try {
    version = readVersion(executable);
  } catch {
    return "unknown";
  }
  if (!version || !version.trim()) return "unknown";
  return /beta/i.test(version) ? "beta" : "stable";
}

/** 秒退阈值：正常截图选区交互远超该时长；CLI 参数被拒时 Snipaste 弹窗后
 * 1.5s 内退出。unknown 版本 + 秒退 + 剪贴板无变化 → 判定 CLI 不支持。 */
export function isQuickExit(elapsedMs: number): boolean {
  return elapsedMs < QUICK_EXIT_MS;
}
