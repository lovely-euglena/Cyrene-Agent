import { BrowserWindow, screen, type NativeImage } from "electron";
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
  type ReactChatWindowHandle,
  showReactChatWindow,
} from "./create-aux-windows";
import { CHAT_READY_TIMEOUT_MS, loadWindowForStartup } from "./startup-window-load";
import { broadcastToAllWindows } from "./broadcast";
import { PetWindowMoveController } from "../pet-window-movement";

export interface WindowManagerOptions {
  getCurrentAppIconPath: () => string;
  isDev: boolean;
  loadPetWindowSettingsSlice: () => PetWindowSettingsSlice;
  persistPetWindowPosition: (position: { x: number; y: number }) => void;
}

export interface WindowManager {
  createPetWindow(showOnReady?: boolean): BrowserWindow;
  /** 创建（或复用）未加载页面的聊天窗口壳；页面加载由显式 load() 驱动。 */
  createReactChatWindowShell(): ReactChatWindowHandle;
  /** 打开聊天窗口：必要时创建壳并加载页面，然后显示并分发会话。 */
  openReactChatWindow(sessionId?: string): Promise<BrowserWindow>;
  createSidebarWindow(): void;
  createSettingsWindow(section?: string): void;
  createTasksWindow(): void;
  createStickerManagerWindow(): void;
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

  return {
    createPetWindow(showOnReady = true): BrowserWindow {
      if (petWindow && !petWindow.isDestroyed()) return petWindow;
      const win = createPetWindow(
        {
          getCurrentAppIconPath: options.getCurrentAppIconPath,
          isDev: options.isDev,
          loadGeneralSettings: options.loadPetWindowSettingsSlice,
        },
        { showOnReady },
      );
      setPetWindow(win, showOnReady);
      return win;
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
      await handle.load(sessionId);
      handle.show(sessionId);
      return handle.window;
    },

    createSidebarWindow,
    createSettingsWindow,
    createTasksWindow,
    createStickerManagerWindow,
    createCallWindow,

    showPetWindow(): void {
      getUsablePetWindow()?.show();
    },
    hidePetWindow(): void {
      getUsablePetWindow()?.hide();
    },
    togglePetWindow(): void {
      const win = getUsablePetWindow();
      if (!win) return;
      win.isVisible() ? win.hide() : win.show();
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
