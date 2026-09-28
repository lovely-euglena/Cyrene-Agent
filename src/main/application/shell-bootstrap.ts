/**
 * Shell 启动阶段（shellReady）：建立最小可见外壳。
 * 顺序：启动日志 → Loading（记录实际显示时刻）→ IPC Scope → WindowManager
 * → 未加载页面的聊天窗口壳 → 绑定激活代理（不 markReady）→ 协议 + 基础 IPC
 * → 托盘 → 注册退出清理 → 推进 shell-ready。
 * 不加载聊天/桌宠/设置等功能页面，不启动重型后台能力。
 */

import type { BrowserWindow, Tray } from "electron";
import { createWindowLifecycleTracker, type TrackedBrowserWindowLike } from "../electron-window-lifecycle";
import { attachWindowsSessionEndHandlers } from "./electron-lifecycle";
import type { IpcScope } from "./ipc-scope";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker, WindowActivationRequest } from "./window-activation";
import type { ReactChatWindowHandle } from "../windows/create-aux-windows";
import type { TrayLike } from "../tray-detached";
import type { WindowManager } from "../windows/window-manager";

export type Live2dWindowLifecycle = ReturnType<typeof createWindowLifecycleTracker<TrackedBrowserWindowLike>>;

export interface ShellIpcRegistrationInput {
  ipc: IpcScope;
  windowManager: WindowManager;
  live2dWindowLifecycle: Live2dWindowLifecycle;
}

export interface ShellDependencies {
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  createIpcScope(): IpcScope;
  /** 创建 Loading 窗口；失败返回 null，跳过最短展示等待。 */
  createSplashWindow(options: { onShown(at: number): void }): BrowserWindow | null;
  createWindowManager(): WindowManager;
  /** 创建未加载页面的聊天窗口壳；load() 留给 core 阶段。 */
  createChatShell(windowManager: WindowManager): ReactChatWindowHandle;
  /** 初始化 native 三件套窗口桥接（未启用/无 exe 时 no-op）。 */
  initializeNativeWindows(windowManager: WindowManager): void;
  /**
   * 打开设置窗（默认 WPF；channels/TTS/ASR 及 Electron 专属 section 弹 Electron）。
   * 缺省回退：直接创建 Electron 设置窗（测试桩兼容）。
   */
  openSettings?(section?: string): void;
  registerProtocolHandlers(): void;
  /** 壳安全 IPC：仅注册依赖在壳阶段已就绪的处理器。 */
  registerShellIpc(input: ShellIpcRegistrationInput): void;
  /** 托盘：窗口类入口走激活请求；桌宠开关立即执行。
   *  返回类型含分离托盘的 duck-type（托盘进程存在时默认优先），
   *  消费点只依赖 isDestroyed/destroy/setImage/setToolTip。 */
  createTray(input: {
    requestActivation(request: WindowActivationRequest): void;
    togglePetWindow(): void;
    /** 桌宠拖动模式兜底（Windows 透明窗 forward 竞态保险）。 */
    setPetDragMode?(enabled: boolean): boolean;
  }): Tray | import("../tray-detached").TrayLike;
  flushTokenUsage(): void;
  /** banner + 启动日志；测试可覆盖避免控制台噪声。 */
  writeStartupLog(): void;
}

export interface ShellResult {
  ipc: IpcScope;
  splashWindow: BrowserWindow | null;
  /** Loading 实际 show() 的单调时刻；未记录则 undefined。 */
  loadingShownAt: number | undefined;
  windowManager: WindowManager;
  chat: ReactChatWindowHandle;
  tray: Tray | TrayLike;
  live2dWindowLifecycle: Live2dWindowLifecycle;
}

const lazySessionEndListeners: Array<{ event: string; listener: () => void }> = [];

export async function startShell(deps: ShellDependencies): Promise<ShellResult> {
  const { readiness, activation, shutdown } = deps;

  // 1. banner + 启动日志
  deps.writeStartupLog();

  // 3-5. IPC Scope / WindowManager / native 桥接 / 未加载页面的聊天窗口壳
  const ipc = deps.createIpcScope();
  const windowManager = deps.createWindowManager();
  // native 三件套桥接必须在 createSplashWindow 之前初始化：splash 的
  // native 分支在 createSplashWindow 内查询 isNativeWindowActive——
  // 初始化晚于 splash 创建会导致 native 分支永远不生效（splash 仍走
  // BrowserWindow 路径）。native spawn 本身是惰性异步（win.spawn 帧），
  // 此处只完成 actions 绑定，不阻塞启动。
  deps.initializeNativeWindows?.(windowManager);

  // 2. 尽快创建并显示 Loading；最短展示时长从实际 show() 时刻起算
  let loadingShownAt: number | undefined;
  const splashWindow = deps.createSplashWindow({
    onShown: (at) => { loadingShownAt = at; },
  });

  const chat = deps.createChatShell(windowManager);

  const live2dWindowLifecycle = createWindowLifecycleTracker<TrackedBrowserWindowLike>("live2d-main", {
    onClosed: () => { /* 桌宠关闭即清理，不影响聊天窗口生命周期 */ },
  });

  // 6. 绑定激活代理动作；bind 不代表就绪 —— markReady 由 core 阶段在 reveal 后调用
  activation.bind({
    focusLoading: () => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
        splashWindow.focus();
      }
    },
    activate: async (request) => {
      switch (request.kind) {
        case "chat":
          await windowManager.openReactChatWindow(request.sessionId);
          break;
        case "sidebar":
          windowManager.createSidebarWindow();
          break;
        case "settings":
          // 默认 WPF 设置窗（channels/TTS/ASR 例外弹 Electron，见 settings-router）
          if (deps.openSettings) deps.openSettings(request.section);
          else windowManager.createSettingsWindow(request.section);
          break;
      }
    },
  });

  // 7. 协议处理器 + 壳安全 IPC
  deps.registerProtocolHandlers();
  deps.registerShellIpc({ ipc, windowManager, live2dWindowLifecycle });

  // 8. 托盘：所有功能窗口入口经过激活代理，退出菜单在应用层处理
  const tray: Tray | TrayLike = deps.createTray({
    requestActivation: (request) => activation.request(request),
    togglePetWindow: () => windowManager.togglePetWindow(),
    setPetDragMode: (enabled) => windowManager.setPetDragMode(enabled),
  });

  // 9. 注册已创建资源的退出清理（固定阶段）
  shutdown.register({
    id: "window-activation",
    phase: "quiesce",
    dispose: async () => { activation.stop(); },
  });
  shutdown.register({
    id: "window-manager",
    phase: "stopLocalResources",
    dispose: async () => { windowManager.dispose(); },
  });
  shutdown.register({
    id: "tray",
    phase: "stopLocalResources",
    dispose: async () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  });
  shutdown.register({
    id: "shell-ipc",
    phase: "stopLocalResources",
    dispose: async () => { ipc.dispose(); },
  });
  shutdown.register({
    id: "token-usage",
    phase: "flushPersistence",
    dispose: async () => { deps.flushTokenUsage(); },
  });
  shutdown.registerEmergencyFlush("token-usage", () => deps.flushTokenUsage());

  // Windows 会话结束（关机/重启/注销）：聊天主窗口上绑定同步紧急落盘。
  // 惰性聊天窗（按需启动）：窗口尚未物化时，绑定延迟到首次物化——
  // 经由 window getter 访问即触发创建，故挂载点包在轻量代理里。
  attachWindowsSessionEndHandlers({
    window: (chat.isLazy
      ? {
          // 惰性代理：session-end 事件只可能来自已物化的窗口；未物化时
          // （窗口不存在）无事件可收，listener 挂在 no-op 对象上安全。
          on: (event: string, listener: () => void) => {
            lazySessionEndListeners.push({ event, listener });
          },
          removeListener: () => undefined,
        }
      : chat.window) as unknown as Parameters<typeof attachWindowsSessionEndHandlers>[0]["window"],
    coordinator: shutdown,
  });
  // 物化钩子：窗口每次物化（首次创建 + 关闭后重建）都重新挂载——
  // 旧窗口销毁时其 listeners 一并消亡，数组保留供重建窗口复绑
  if (chat.isLazy) {
    chat.onMaterialized?.((window) => {
      for (const { event, listener } of lazySessionEndListeners) {
        window.on(event as never, listener as never);
      }
    });
  }

  // 10. 推进 shell-ready
  readiness.transition("shell-ready");

  return {
    ipc,
    splashWindow,
    // Loading 的 ready-to-show 是异步事件，可能晚于本函数返回；必须用 getter 实时读取，
    // 否则 core 阶段拿到的是 undefined 快照，最短展示时长会被跳过。
    get loadingShownAt() {
      return loadingShownAt;
    },
    windowManager,
    chat,
    tray,
    live2dWindowLifecycle,
  };
}
