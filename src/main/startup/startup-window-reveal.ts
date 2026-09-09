export interface StartupWindowLike {
  close(): void;
  isDestroyed(): boolean;
  show(): void;
}

export interface RevealStartupWindowsOptions {
  /** Loading 窗口；创建失败时为 null，跳过关闭与最短展示等待。 */
  splashWindow: StartupWindowLike | null;
  /**
   * native splash 关闭旁路（CYRENE_NATIVE_WINDOWS=1 时 splashWindow 为
   * null，reveal 必须走此回调关闭 native 进程里的 splash——否则启动屏
   * 永远挂着）。未启用 native 时 no-op。
   */
  closeSplashWindow?: () => void;
  /** 聊天窗口（主窗口）；reveal 只负责显示，不加载页面。
   * null = 按需启动模式且窗口未物化：reveal 跳过（桌面只留桌宠）。 */
  chatWindow: StartupWindowLike | null;
  /** Loading 实际 show() 的单调时钟时刻；undefined 表示未记录（跳过最短等待）。 */
  loadingShownAt?: number;
  minimumDurationMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * 关闭 Loading 并显示聊天窗口。
 * 最短展示时长按“实际显示时刻起的剩余时间”计算，核心就绪较晚时不重复整段等待。
 * 桌宠不属于通用 reveal：其创建与显示由启动编排器按 petVisible 单独处理。
 */
export async function revealStartupWindows(options: RevealStartupWindowsOptions): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const remaining = options.loadingShownAt === undefined
    ? 0
    : Math.max(0, options.minimumDurationMs - (now() - options.loadingShownAt));
  if (remaining > 0) {
    await sleep(remaining);
  }

  if (options.splashWindow && !options.splashWindow.isDestroyed()) {
    options.splashWindow.close();
  }
  // native splash（存在时）与 BrowserWindow splash 同点关闭
  options.closeSplashWindow?.();
  if (options.chatWindow && !options.chatWindow.isDestroyed()) {
    options.chatWindow.show();
  }
}
