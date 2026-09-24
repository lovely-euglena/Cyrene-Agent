import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import { loadGeneralSettings } from "../settings/settings-facade";
import { computeLayout } from "../window-layout";
import { stopCall, setCallWindow } from "../call/call-manager";
import { isNativeWindowActive, spawnNativeWindow } from "./native-windows-bridge";
import {
  callWindow,
  getCurrentAppIconPath,
  reactChatSession,
  reactChatWindow,
  setCallWindowLocal,
  setReactChatWindow,
  setSettingsWindow,
  setPluginManagerWindow,
  setSidebarWindow,
  setStickerManagerWindow,
  setTasksWindow,
  settingsWindow,
  pluginManagerWindow,
  showWindowWhenStartupReady,
  sidebarWindow,
  stickerManagerWindow,
  tasksWindow,
} from "./window-state";

/**
 * React 聊天窗口句柄：壳对象 + 显式页面加载 + 显示。
 * load() 只允许由启动编排器在全部 IPC 处理器注册后调用。
 */
export interface ReactChatWindowHandle {
  window: BrowserWindow;
  load(sessionId?: string): Promise<void>;
  show(sessionId?: string): void;
  /** 惰性 handle：true 表示窗口尚未物化、load/show 会触发创建。 */
  isLazy?: boolean;
  /** 惰性 handle 专属：窗口首次物化时回调（如 session-end 事件延迟绑定）。 */
  onMaterialized?(handler: (window: BrowserWindow) => void): void;
  /** 惰性 handle 专属：窗口是否已物化（未创建/已销毁 = false）。 */
  isMaterialized?(): boolean;
}

/**
 * 惰性聊天窗口 handle：首次真正需要窗口时才创建 BrowserWindow。
 *
 * 按需启动模式（CYRENE_LAZY_CHAT_WINDOW=1，默认开启）下，启动流程
 * 只拿到代理对象——shell 阶段的 attachWindowsSessionEndHandlers、
 * core 阶段的 chat.load()、reveal 阶段的 chatWindow.show() 全部经
 * ensureCreated() 物化。触发点：
 *   - 启动 reveal（默认行为不变：splash 结束即显示聊天）
 *   - 激活请求（tray「打开聊天窗口」/ 协议 / 会话分发）
 *   - chat-ui-ipc 的 openReactChatWindow
 * 窗口关闭后再次访问 → 重建（与 createReactChatWindowShell 语义一致）。
 *
 * ⚠️ window 是 getter：消费方持有的 handle.window 引用在窗口重建后
 * 失效，必须每次经由 handle.window 取当前实例（现有调用点均如此）。
 */
export function createLazyReactChatWindowHandle(
  ensureLoaded: (window: BrowserWindow) => Promise<void>,
): ReactChatWindowHandle & { isMaterialized(): boolean } {
  let current: BrowserWindow | null = null;
  let loadPromise: Promise<void> | null = null;
  const materializedHandlers: Array<(window: BrowserWindow) => void> = [];
  const ensureCreated = (): BrowserWindow => {
    if (!current || current.isDestroyed()) {
      current = createReactChatWindowShell();
      loadPromise = null; // 新窗口 → 重新加载
      for (const handler of materializedHandlers) {
        try { handler(current); } catch (err) { console.error("[ChatWindow] materialized handler failed:", err); }
      }
    }
    return current;
  };
  return {
    get window(): BrowserWindow {
      return ensureCreated();
    },
    load(sessionId?: string): Promise<void> {
      ensureCreated();
      // 缓存在 handle 侧：同一窗口的重复 load 复用同一 Promise
      if (!loadPromise) {
        loadPromise = ensureLoaded(current!).then(() => {
          if (sessionId) dispatchOrQueueReactSession(sessionId);
        });
      } else if (sessionId) {
        // 已加载：sessionId 不重载，仅在完成后分发
        loadPromise = loadPromise.then(() => {
          dispatchOrQueueReactSession(sessionId!);
        });
      }
      return loadPromise;
    },
    show(sessionId?: string): void {
      const window = ensureCreated();
      window.show();
      window.focus();
      if (sessionId) dispatchOrQueueReactSession(sessionId);
    },
    isMaterialized(): boolean {
      return current !== null && !current.isDestroyed();
    },
    isLazy: true,
    onMaterialized(handler: (window: BrowserWindow) => void): void {
      materializedHandlers.push(handler);
      if (current && !current.isDestroyed()) handler(current);
    },
  };
}

// Electron 44 新增 WindowStatePersistence；本地 43 垫片声明（升级 44 后冗余无害）
declare namespace Electron {
  interface WindowStatePersistence {
    bounds: boolean;
    displayMode: boolean;
  }
}

export function persistedWindowState(
  name: string,
  enabled: boolean,
): { name?: string; windowStatePersistence?: Electron.WindowStatePersistence } {
  return enabled
    ? { name, windowStatePersistence: { bounds: true, displayMode: false } }
    : {};
}

/**
 * 创建/复用 React 聊天窗口壳。
 * 只构造 BrowserWindow 对象并登记全局状态，禁止调用 loadURL/loadFile ——
 * 页面加载由 loadReactChatWindowPage 在核心 IPC 就绪后执行。
 */
export function createReactChatWindowShell(): BrowserWindow {
  // 已有窗口 → 复用（壳不重复创建）
  if (reactChatWindow && !reactChatWindow.isDestroyed()) {
    return reactChatWindow;
  }

  // 新建窗口：dispatcher 重置；pending 仅服务于"未 ready 期间又收到请求"
  reactChatSession.reset();

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.chat.x,
    y: layout.chat.y,
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 540,
    title: "Cyrene · 聊天",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setReactChatWindow(window);

  window.webContents.on("did-start-loading", () => {
    reactChatSession.markLoading();
  });

  window.on("closed", () => {
    // 闭包引用 + 仅当当前全局仍指向自己时才清理，避免旧窗口 closed 误清新窗口
    if (reactChatWindow === window) {
      setReactChatWindow(null);
      reactChatSession.reset();
    }
  });
  return window;
}

/**
 * 加载聊天渲染页面。search 字段必须含前导 "?"（Electron url.format() 要求）。
 * 失败原样向上抛（由 startup-window-load 统一判定致命性），不再吞掉。
 */
export function loadReactChatWindowPage(window: BrowserWindow, sessionId?: string): Promise<void> {
  const search = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : undefined;
  const indexPath = path.join(app.getAppPath(), "dist", "renderer", "react", "index.html");

  // [ChatPerf] 打开卡顿诊断链（用户报"打开就卡"）：
  //   t0 load 开始 → t1 dom-ready → t2 did-finish-load → t3 渲染层 CHATS_REACT_READY
  // 渲染层脚本初始化耗时（t2→t3）+ 加载耗时（t0→t2）分段定位卡在哪段。
  const t0 = Date.now();
  const once = (wc: import("electron").WebContents): void => {
    wc.once("dom-ready", () => {
      console.info(`[ChatPerf] dom-ready +${Date.now() - t0}ms`);
    });
    wc.once("did-finish-load", () => {
      console.info(`[ChatPerf] did-finish-load +${Date.now() - t0}ms`);
    });
  };
  once(window.webContents);

  if (isDev) {
    return window.loadURL(`http://localhost:5173/react/${search ?? ""}`);
  }
  return window.loadFile(indexPath, search ? { search } : undefined);
}

/**
 * 显示聊天窗口（不加载页面）；带 sessionId 时走会话分发。
 */
export function showReactChatWindow(sessionId?: string): void {
  const win = reactChatWindow;
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  if (sessionId) dispatchOrQueueReactSession(sessionId);
}

export function dispatchOrQueueReactSession(sessionId: string): void {
  const win = reactChatWindow;
  if (!win?.webContents) return;
  const immediate = reactChatSession.queueOrTake(sessionId);
  if (immediate) {
    win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, immediate);
  }
}

/**
 * 创建/复用侧边状态面板窗口。
 */
export function createSidebarWindow(): void {
  // 灰度开关：native 窗口进程路径（CYRENE_NATIVE_WINDOWS=1 且 exe 就位）
  if (isNativeWindowActive("sidebar")) {
    const layout = computeLayout();
    void spawnNativeWindow("sidebar", { sidebar: layout.sidebar }).then((ok) => {
      if (!ok) console.warn("[Sidebar] native spawn failed — fallback unavailable until next call");
    });
    return;
  }

  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.show();
    sidebarWindow.focus();
    return;
  }

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.sidebar.x,
    y: layout.sidebar.y,
    width: 320,
    height: 760,
    minWidth: 56,
    minHeight: 540,
    title: "昔涟 · 状态",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setSidebarWindow(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/sidebar/");
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "sidebar", "index.html")
    );
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
  });

  window.on("closed", () => {
    setSidebarWindow(null);
  });
}

/**
 * 创建/复用今日日程窗口。
 */
export function createTasksWindow(): void {
  // 灰度开关：native 窗口进程路径
  if (isNativeWindowActive("tasks")) {
    const layout = computeLayout();
    void spawnNativeWindow("tasks", { tasks: layout.tasks }).then((ok) => {
      if (!ok) console.warn("[Tasks] native spawn failed — fallback unavailable until next call");
    });
    return;
  }

  if (tasksWindow && !tasksWindow.isDestroyed()) {
    tasksWindow.show();
    tasksWindow.focus();
    return;
  }

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.tasks.x,
    y: layout.tasks.y,
    width: 320,
    height: 760,
    minHeight: 540,
    title: "昔涟 · 今日日程",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setTasksWindow(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/tasks/");
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "tasks", "index.html")
    );
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
  });

  window.on("closed", () => {
    setTasksWindow(null);
  });
}

/**
 * 创建/复用设置窗口。
 */
/**
 * 插件管理窗口（插件页重写——.NET 方案）。
 * WPF PluginManagerWindow 走 spawnNativeWindow("plugins")；插件运行时
 * 面板（Panel Bridge）仍归 Electron（生态适配层）。
 */
export function createPluginManagerWindow(): void {
  // native 路径优先；未启用/失败时由调用方回退 Electron 设置窗 plugins
  // section（hash 路由），避免用户失去插件管理入口
  void import("./native-windows-bridge").then(({ spawnNativeWindow }) =>
    spawnNativeWindow("plugins").then((ok) => {
      if (!ok) createSettingsWindow("plugins");
    }),
  );
}

export function createSettingsWindow(section?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    // 窗口已存在：发事件让 settings 页切标签（loadURL 不会重新触发）
    if (section) {
      settingsWindow.webContents.send(IPC.SETTINGS_SWITCH_SECTION, section);
    }
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 1060;
  const height = 920;
  const rememberWindowState = loadGeneralSettings().rememberWindowState;
  const window = new BrowserWindow({
    ...persistedWindowState("cyrene.settings", rememberWindowState),
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 920,
    minHeight: 580,
    title: "昔涟 · 设置",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#F2F2F7",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setSettingsWindow(window);


  const hash = section ? `#${section}` : "";
  if (isDev) {
    window.loadURL("http://localhost:5173/settings/" + hash);
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "settings", "index.html"),
      { hash: section || "" }
    );
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
  });

  window.on("closed", () => {
    setSettingsWindow(null);
  });
}

/**
 * 创建/复用表情包管理窗口。
 */
export async function createStickerManagerWindow(): Promise<{ ok: boolean; error?: string }> {
  if (stickerManagerWindow && !stickerManagerWindow.isDestroyed()) {
    stickerManagerWindow.show();
    stickerManagerWindow.focus();
    stickerManagerWindow.moveTop();
    return { ok: true };
  }

  const parentBounds = settingsWindow?.getBounds();
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 520;
  const height = 420;
  const window = new BrowserWindow({
    x: parentBounds ? parentBounds.x + Math.max(24, Math.floor((parentBounds.width - width) / 2)) : dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: parentBounds ? parentBounds.y + 64 : dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 460,
    minHeight: 360,
    title: "表情包管理",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    parent: settingsWindow ?? undefined,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setStickerManagerWindow(window);

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[stickers] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  try {
    if (isDev) {
      await window.loadURL("http://localhost:5173/sticker-manager/");
    } else {
      await window.loadFile(
        path.join(app.getAppPath(), "dist", "renderer", "sticker-manager", "index.html")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stickers] failed to load sticker manager window", error);
    window.close();
    return { ok: false, error: message };
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
    window.focus();
    window.moveTop();
  });

  window.on("closed", () => {
    setStickerManagerWindow(null);
  });

  return { ok: true };
}

/**
 * 创建/复用语音通话窗口（450×800 竖屏，语音通话）。
 */
export function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.show();
    callWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workArea;
  const CALL_W = 420;
  const CALL_H = 800;
  const cx = Math.max(0, Math.floor((dw - CALL_W) / 2));
  const cy = Math.max(0, Math.floor((dh - CALL_H) / 2));

  const window = new BrowserWindow({
    x: display.workArea.x + cx,
    y: display.workArea.y + cy,
    width: CALL_W,
    height: CALL_H,
    minWidth: 420,
    minHeight: 600,
    title: "Cyrene · 语音通话",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setCallWindowLocal(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/call/");
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "call", "index.html"));
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
  });

  window.on("closed", () => {
    setCallWindowLocal(null);
    stopCall();
    setCallWindow(null);
  });

  // 绑定给 call-manager
  setCallWindow(window);
}

