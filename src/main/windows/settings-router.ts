// 设置入口统一路由（组合根与窗口 IPC 共享）：
//   默认走聊天窗内设置页（2026-10 上游对齐：设置面板并入工作区 React 界面）；
//   聊天窗不可用 / 加载失败时回退原生设置窗（WPF，channels 等例外见下）。
//   回退路径：入口默认 WPF（.NET）设置窗；channels / TTS / ASR 以及 WPF
//   不认识的 section（Electron 专属）弹 Electron 设置页；native 进程不可用 /
//   spawn 失败自动回退 Electron，保证入口永不失效。
//
// 调用点：
//   - 托盘激活（shell-bootstrap 的 activate.settings）
//   - 渲染进程设置入口（SIDEBAR_OPEN_SETTINGS：聊天窗/状态栏/任务窗）
//   - renderer 请求定位（SETTINGS_REQUEST_SWITCH_SECTION：头像菜单等）
//   - native sidebar「设置」按钮（native-windows-bridge 的 openSettings 动作）
//   回退裁决规则见 native-settings-protocol.shouldOpenSettingsInElectron。

import { createSettingsWindow } from "./create-aux-windows";
import { spawnNativeWindow } from "./native-windows-bridge";
import { shouldOpenSettingsInElectron } from "./native-settings-protocol";

export interface SettingsEntryDeps {
  /** 打开聊天窗内设置页并定位 section（WindowManager.openSettings）。 */
  openInChat(section?: string): Promise<unknown>;
  /** 聊天窗不可用时的回退（原生 WPF / Electron 路由）。 */
  openFallback(section?: string): void;
}

/**
 * 设置入口统一路由：默认聊天窗内设置页；打开失败（窗口加载失败 / 主进程
 * 异常）回退原生设置窗，保证入口永不失效。fire-and-forget（入口均同步触发）。
 */
export function openSettingsEntry(section: string | undefined, deps: SettingsEntryDeps): void {
  let chat: Promise<unknown>;
  try {
    chat = deps.openInChat(section);
  } catch (error) {
    console.warn("[settings-router] 聊天窗设置页打开异常，回退原生设置窗：", error);
    deps.openFallback(section);
    return;
  }
  void chat.catch((error: unknown) => {
    console.warn("[settings-router] 聊天窗设置页打开失败，回退原生设置窗：", error);
    deps.openFallback(section);
  });
}

/**
 * 打开原生设置窗（回退路径）：默认 WPF（带 section 定位）；Electron 专属
 * section 或 native 不可用（spawn 返回 false）时回退 Electron 设置页。
 */
export function openSettingsWindow(section?: string): void {
  if (shouldOpenSettingsInElectron(section)) {
    createSettingsWindow(section);
    return;
  }
  void spawnNativeWindow("settings", section ? { section } : undefined).then((ok) => {
    // 回退 Electron：about 是 WPF 独有 section，Electron 页没有这个 hash
    //（旧代码会落到未知 section 的占位路径），回退时归一到 settings 默认页。
    if (!ok) createSettingsWindow(section === "about" ? undefined : section);
  });
}