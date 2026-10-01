import { app, BrowserWindow, screen, type NativeImage } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createPetWindow, PET_WINDOW_BASE_HEIGHT, PET_WINDOW_BASE_WIDTH, type PetWindowSettingsSlice } from "../startup/create-pet-window";
import {
  createCallWindow,
  createReactChatWindowShell,
  createLazyReactChatWindowHandle,
  createSettingsWindow,
  createSidebarWindow,
  createStickerManagerWindow,
  createTasksWindow,
  loadReactChatWindowPage,
  loadOnboardingWindowPage,
  createOnboardingBrowserWindow,
  type ReactChatWindowHandle,
  showReactChatWindow,
} from "./create-aux-windows";
import { CHAT_READY_TIMEOUT_MS, loadWindowForStartup } from "./startup-window-load";
import { broadcastToAllWindows } from "./broadcast";
import { reactChatSettingsSection } from "./window-state";
import { PetWindowMoveController } from "../pet-window-movement";
import { CURRENT_DISCLAIMER_VERSION } from "../../shared/disclaimer";

export interface WindowManagerOptions {
  getCurrentAppIconPath: () => string;
  isDev: boolean;
  loadPetWindowSettingsSlice: () => PetWindowSettingsSlice;
  persistPetWindowPosition: (position: { x: number; y: number }) => void;
}

export interface WindowManager {
  hasCurrentDisclaimerConsent?(): boolean;
  createOnboardingWindow?(): Promise<BrowserWindow>;
  showOnboardingWindow?(): void;
  closeOnboardingWindow?(): void;
  createPetWindow(showOnReady?: boolean): BrowserWindow;
  /** 创建（或复用）未加载页面的聊天窗口壳；页面加载由显式 load() 驱动。 */
  createReactChatWindowShell(): ReactChatWindowHandle;
  /** 打开聊天窗口：必要时创建壳并加载页面，然后显示并分发会话。 */
  openReactChatWindow(sessionId?: string): Promise<BrowserWindow>;
  openSettings(section?: string): Promise<void>;
  openScheduledTasks(): Promise<void>;
  createStickerManagerWindow(): void;
  createSidebarWindow(): void;
  createSettingsWindow(section?: string): void;
  createTasksWindow(): void;
  createCallWindow(): void;

  showPetWindow(): void;
  hidePetWindow(): void;
  togglePetWindow(): void;
  minimizePetWindow(): void;
  setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void;
  setPetWindowInteractive(interactive: boolean): void;
  setPetWindowDragging(isDragging: boolean): void;
  /** 桌宠拖动模式（托盘兜底）：整窗交互态，穿透关闭；返回切换结果。 */
  setPetDragMode(enabled: boolean): boolean;
  movePetWindowRelative(dx: number, dy: number): void;
  movePetWindowTo(x: number, y: number): void;
  applyPetWindowZoom(zoom: number): void;
  capturePetWindowFrame(): Promise<string | null>;
  capturePetWindow(): Promise<Electron.NativeImage | null>;
  getCursorScreenPosition(): { x: number; y: number };
  setIconForAllWindows(icon: NativeImage): void;
  sendToPetWindow(channel: string, payload?: unknown): void;
  broadcast(channel: string, payload: unknown): void;

  onPetWindowReady(handler: (win: BrowserWindow) => void): void;
  onPetWindowClosed(handler: () => void): void;
  onPetWindowMoved(handler: (position: { x: number; y: number }) => void): void;

  dispose(): void;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  let petWindow: BrowserWindow | null = null;
  let onboardingWindow: BrowserWindow | null = null;
  let chatShell: ReactChatWindowHandle | null = null;
  let chatLoadPromise: Promise<void> | null = null;
  // chatLoadPromise 归属的窗口实例：重建窗口后旧 Promise 不可复用（P0 白屏修复）
  let chatLoadedWindow: BrowserWindow | null = null;
  const readyHandlers: Array<(win: BrowserWindow) => void> = [];
  const closedHandlers: Array<() => void> = [];
  const movedHandlers: Array<(position: { x: number; y: number }) => void> = [];

  const petWindowMoveController = new PetWindowMoveController(
    () => petWindow,
    (position) => {
      options.persistPetWindowPosition(position);
    },
  );

  function getUsablePetWindow(): BrowserWindow | null {
    if (!petWindow || petWindow.isDestroyed()) return null;
    return petWindow;
  }

  function hasCurrentDisclaimerConsent(): boolean {
    const version = options.loadPetWindowSettingsSlice().disclaimerAcceptedVersion;
    return version === undefined || version === CURRENT_DISCLAIMER_VERSION;
  }

  async function createOnboardingWindow(): Promise<BrowserWindow> {
    if (onboardingWindow && !onboardingWindow.isDestroyed()) return onboardingWindow;
    const window = createOnboardingBrowserWindow();
    onboardingWindow = window;
    let appIsQuitting = false;
    app.once("before-quit", () => { appIsQuitting = true; });
    window.on("close", (event) => {
      if (!hasCurrentDisclaimerConsent() && !appIsQuitting) {
        event.preventDefault();
        app.quit();
      }
    });
    window.on("closed", () => {
      if (onboardingWindow === window) onboardingWindow = null;
    });
    try {
      await loadOnboardingWindowPage(window);
      return window;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  function showOnboardingWindow(): void {
    const existing = onboardingWindow;
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    void createOnboardingWindow()
      .then((window) => { window.show(); window.focus(); })
      .catch((error) => {
        console.error("[WindowManager] onboarding window failed to load:", error);
        app.quit();
      });
  }

  function setPetWindow(window: BrowserWindow, showOnReady = true): void {
    petWindow = window;
    window.once("ready-to-show", () => {
      if (!petWindow || petWindow.isDestroyed()) return;
      if (showOnReady) {
        petWindow.show();
      }
      for (const handler of readyHandlers) {
        try { handler(petWindow); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    });
    window.on("closed", () => {
      petWindowMoveController.dispose();
      petWindow = null;
      for (const handler of closedHandlers) {
        try { handler(); } catch (err) { console.error("[WindowManager] closed handler failed:", err); }
      }
    });
    window.on("moved", () => {
      const win = petWindow;
      if (!win || win.isDestroyed()) return;
      try {
        const [x, y] = win.getPosition();
        for (const handler of movedHandlers) {
          try { handler({ x, y }); } catch (err) { console.error("[WindowManager] moved handler failed:", err); }
        }
      } catch {
        // ignore
      }
    });
  }

  function ensurePetWindow(showOnReady: boolean): BrowserWindow {
    if (petWindow && !petWindow.isDestroyed()) return petWindow;
    const settings = options.loadPetWindowSettingsSlice();
    const win = createPetWindow(
      {
        getCurrentAppIconPath: options.getCurrentAppIconPath,
        isDev: options.isDev,
        loadGeneralSettings: options.loadPetWindowSettingsSlice,
      },
      { showOnReady },
    );
    setPetWindow(win, showOnReady);
    // 重建后恢复运行期属性：窗口隐藏时被销毁，期间置顶/缩放可能已变更
    const alwaysOnTop = settings.petAlwaysOnTop !== false;
    win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    const zoom = typeof settings.petZoom === "number" && settings.petZoom > 0 ? settings.petZoom : 1;
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.PET_ZOOM, zoom);
    });
    return win;
  }

  return {
    hasCurrentDisclaimerConsent,
    createOnboardingWindow,
    showOnboardingWindow,
    closeOnboardingWindow(): void {
      onboardingWindow?.close();
    },
    createPetWindow(showOnReady = true): BrowserWindow {
      return ensurePetWindow(showOnReady && hasCurrentDisclaimerConsent());
    },

    createReactChatWindowShell(): ReactChatWindowHandle {
      // 懒 handle 永远复用：窗口销毁→重建由 handle 的 ensureCreated 内部
      // 处理（重挂 materialized 回调、重置 load 缓存）。若每次新建 handle，
      // shell 阶段注册在首个 handle 上的物化回调（session-end 紧急落盘）
      // 会永久失联——这是引入懒窗时的高危点。
      if (chatShell) {
        if (chatShell.isLazy) return chatShell;
        if (!chatShell.window.isDestroyed()) return chatShell;
      }
      // 惰性 handle：BrowserWindow 在首次 load/show/window 访问时才创建
      // （load Promise 缓存语义与急切版一致：同一窗口只加载一次）
      const handle = createLazyReactChatWindowHandle((win) => {
        // 窗口身份比对：旧窗口销毁后 handle 会物化新窗口，此时旧
        // chatLoadPromise（resolved）不能复用——否则新窗口永远不加载
        // 页面（白屏）。以 chatLoadedWindow === win 判定缓存归属。
        if (chatLoadedWindow !== win || !chatLoadPromise) {
          chatLoadedWindow = win;
          chatLoadPromise = loadWindowForStartup({
            window: win,
            load: () => loadReactChatWindowPage(win),
            timeoutMs: CHAT_READY_TIMEOUT_MS,
          }).catch((error) => {
            console.error("[WindowManager] chat page load failed:", error);
            throw error;
          });
        }
        return chatLoadPromise;
      });
      chatShell = handle;
      chatLoadPromise = null;
      chatLoadedWindow = null;
      return handle;
    },

    async openReactChatWindow(sessionId?: string): Promise<BrowserWindow> {
      const handle = this.createReactChatWindowShell();
      if (!hasCurrentDisclaimerConsent()) {
        showOnboardingWindow();
        return handle.window;
      }
      await handle.load(sessionId);
      handle.show(sessionId);
      return handle.window;
    },

    async openSettings(section = "appearance"): Promise<void> {
      const window = await this.openReactChatWindow();
      // 冷启动竞态：ready-to-show 会早于 React 挂载 onSwitchSection 监听，直接 send
      // 可能丢帧（现象=「点设置没反应」）。未 ready 时入队，由 CHATS_REACT_READY
      // 冲发（与 sessionId 分发同一状态机）。
      const immediate = reactChatSettingsSection.queueOrTake(section);
      if (immediate) {
        window.webContents.send(IPC.SETTINGS_SWITCH_SECTION, immediate);
      }
    },
    async openScheduledTasks(): Promise<void> {
      const window = await this.openReactChatWindow();
      const immediate = reactChatSettingsSection.queueOrTake("tasks");
      if (immediate) {
        window.webContents.send(IPC.SETTINGS_SWITCH_SECTION, immediate);
      }
    },
    createStickerManagerWindow,
    createSidebarWindow,
    createSettingsWindow,
    createTasksWindow,
    createCallWindow,

    showPetWindow(): void {
      if (!hasCurrentDisclaimerConsent()) {
        this.hidePetWindow();
        return;
      }
      const win = getUsablePetWindow();
      if (win) {
        win.show();
        return;
      }
      // 隐藏时窗口（含渲染进程）已被销毁：再次显示按需重建，不闪空窗
      ensurePetWindow(true);
    },
    hidePetWindow(): void {
      const win = getUsablePetWindow();
      if (!win) return;
      // 销毁而非 hide：把桌宠渲染进程一起结束（Live2D 常驻内存大头）；
      // closed 回调清 petWindow + live2d 生命周期，显示时重建
      win.destroy();
    },
    togglePetWindow(): void {
      if (!hasCurrentDisclaimerConsent()) {
        this.hidePetWindow();
        return;
      }
      const win = getUsablePetWindow();
      if (!win) {
        ensurePetWindow(true);
        return;
      }
      if (win.isVisible()) win.destroy();
      else win.show();
    },
    minimizePetWindow(): void {
      getUsablePetWindow()?.minimize();
    },
    setPetWindowAlwaysOnTop(alwaysOnTop: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    },
    setPetWindowInteractive(interactive: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      win.setIgnoreMouseEvents(!interactive, { forward: true });
    },
    setPetWindowDragging(isDragging: boolean): void {
      const win = getUsablePetWindow();
      if (!win) return;
      if (!isDragging) petWindowMoveController.finishDragging();
      try {
        win.setOpacity(isDragging ? 0.99 : 1.0);
      } catch (error) {
        console.warn("[WindowManager] Failed to update pet window dragging opacity:", error);
      }
    },
    setPetDragMode(enabled: boolean): boolean {
      const win = getUsablePetWindow();
      if (!win) return false;
      try {
        // 拖动模式 = 整窗吃鼠标（关穿透）。渲染侧 hit-test 自动恢复时
        // 会再次 setInteractive(true)——与本模式兼容（都是关穿透）；
        // 退出拖动模式时交还渲染侧 hit-test 控制（设回穿透，等下一
        // 次 mousemove 命中再切换）。
        win.setIgnoreMouseEvents(!enabled, { forward: true });
        return enabled;
      } catch (error) {
        console.warn("[WindowManager] setPetDragMode failed:", error);
        return false;
      }
    },
    movePetWindowRelative(dx: number, dy: number): void {
      petWindowMoveController.moveRelative(dx, dy);
    },
    movePetWindowTo(x: number, y: number): void {
      petWindowMoveController.queueAbsolute(x, y);
    },
    applyPetWindowZoom(zoom: number): void {
      const win = getUsablePetWindow();
      if (!win) return;
      const width = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
      const height = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
      win.setSize(width, height);
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PET_ZOOM, zoom);
      }
    },
    async capturePetWindowFrame(): Promise<string | null> {
      const image = await this.capturePetWindow();
      return image ? image.toDataURL() : null;
    },
    async capturePetWindow(): Promise<Electron.NativeImage | null> {
      const win = getUsablePetWindow();
      if (!win) return null;
      try {
        return await win.webContents.capturePage();
      } catch (err) {
        console.error("[WindowManager] capturePetWindow failed:", err);
        return null;
      }
    },
    getCursorScreenPosition(): { x: number; y: number } {
      return screen.getCursorScreenPoint();
    },
    setIconForAllWindows(icon: NativeImage): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(icon);
      }
    },
    sendToPetWindow(channel: string, payload?: unknown): void {
      const win = getUsablePetWindow();
      if (!win) return;
      if (payload === undefined) win.webContents.send(channel);
      else win.webContents.send(channel, payload);
    },
    broadcast(channel: string, payload: unknown): void {
      broadcastToAllWindows(channel, payload);
    },

    onPetWindowReady(handler: (win: BrowserWindow) => void): void {
      readyHandlers.push(handler);
      if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
        try { handler(petWindow); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    },
    onPetWindowClosed(handler: () => void): void {
      closedHandlers.push(handler);
    },
    onPetWindowMoved(handler: (position: { x: number; y: number }) => void): void {
      movedHandlers.push(handler);
    },

    dispose(): void {
      petWindowMoveController.dispose();
    },
  };
}
