// 设置窗打开路由（组合根与窗口 IPC 共享）：
//   入口默认走 WPF（.NET）设置窗；channels / TTS / ASR 以及 WPF 不认识的
//   section（Electron 专属）保持弹 Electron 设置页。
//   native 进程不可用 / spawn 失败自动回退 Electron，保证入口永不失效。
//
// 调用点：
//   - 托盘激活（shell-bootstrap 的 activate.settings）
//   - 渲染进程设置入口（SIDEBAR_OPEN_SETTINGS：聊天窗/状态栏/任务窗）
//   - native sidebar「设置」按钮（native-windows-bridge 的 openSettings 动作）
// 裁决规则见 native-settings-protocol.shouldOpenSettingsInElectron。

import { createSettingsWindow } from "./create-aux-windows";
import { spawnNativeWindow } from "./native-windows-bridge";
import { shouldOpenSettingsInElectron } from "./native-settings-protocol";

/**
 * 打开设置窗：默认 WPF（带 section 定位）；Electron 专属 section 或
 * native 不可用（spawn 返回 false）时回退 Electron 设置页。
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