export interface LoginItemSettingsApp {
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
}

export interface InstallerOptionsFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  unlinkSync(path: string): void;
}

/** IKJK51：托盘登录项参数（cyrene-native --tray + data-dir）。 */
export interface TrayLoginItemOptions {
  trayPath: string;
  trayArgs: string[];
}

/**
 * 托盘登录项参数构造（复审 P1-3）：Windows Run 命令行按空白拆分，Electron
 * 不对 args 代加引号——路径必须显式引号包裹（含空格/中文路径），否则
 * --data-dir 值被截断到错误目录。
 */
export function buildTrayLoginItemArgs(userDataPath: string): string[] {
  return ["--tray", "--scheduler", "--data-dir", `"${userDataPath}"`];
}

/**
 * IKJK51：调度常驻模式下登录项指向 `cyrene-native --tray`（托盘再按需拉起
 * Electron；调度在 Electron 全退后仍常驻）。开关关闭 / exe 缺失 → undefined
 * （维持 Electron 登录项现状）。懒 require 规避模块环。
 */
export function resolveTrayLoginItemOptions(userDataPath: string): TrayLoginItemOptions | undefined {
  try {
    const { resolveDotnetConfig } = require("../dotnet-backend/config") as
      typeof import("../dotnet-backend/config");
    if (!resolveDotnetConfig().schedulerHost) return undefined;
    const { resolveNativeWindowsExe } = require("../windows/native-windows-host") as
      typeof import("../windows/native-windows-host");
    const trayPath = resolveNativeWindowsExe();
    if (!trayPath) return undefined;
    // --scheduler：托盘启用常驻调度（无此标志仅托盘 UI；见 sched.mode 协商）。
    return { trayPath, trayArgs: buildTrayLoginItemArgs(userDataPath) };
  } catch {
    return undefined;
  }
}

export function syncLaunchAtLogin(
  enabled: boolean,
  app: LoginItemSettingsApp,
  trayOptions?: TrayLoginItemOptions,
): void {
  if (enabled) {
    if (trayOptions) {
      app.setLoginItemSettings({ openAtLogin: true, path: trayOptions.trayPath, args: trayOptions.trayArgs });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: true });
    return;
  }
  // 关闭：默认（Electron）与托盘登录项都清一遍，避免切换过指向后残留
  app.setLoginItemSettings({ openAtLogin: false });
  if (trayOptions) {
    app.setLoginItemSettings({ openAtLogin: false, path: trayOptions.trayPath });
  }
}

/**
 * Returns the one-shot preference selected in the installer, then removes it so
 * future starts continue to respect the user's in-app setting.
 */
export function consumeInstallerLaunchAtLoginSelection(
  path: string,
  fileSystem: InstallerOptionsFileSystem,
): boolean | null {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(path, "utf8")) as { launchAtLogin?: unknown };
    fileSystem.unlinkSync(path);
    return typeof parsed.launchAtLogin === "boolean" ? parsed.launchAtLogin : null;
  } catch {
    return null;
  }
}

export function applyInstallerLaunchAtLoginSelection<T extends object>(
  settings: T,
  selection: boolean | null,
): T {
  return selection === null ? settings : { ...settings, launchAtLogin: selection };
}
