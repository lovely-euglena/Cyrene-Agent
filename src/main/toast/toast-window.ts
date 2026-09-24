import type { BrowserWindow } from "electron";
import {
  TOAST_IDLE_TEARDOWN_MS,
  TOAST_MAX_WORKAREA_RATIO,
  TOAST_PENDING_SENDS_MAX,
  TOAST_WINDOW_WIDTH,
} from "./types";

/** 显示器工作区：只取 toast 定位需要的字段，便于测试注入 */
export interface ToastDisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口区域（electron Rectangle 的注入形式） */
export interface ToastBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToastWindowDeps {
  /** 窗口工厂（由 windows/create-toast-window 提供，toast 模块不直接 new BrowserWindow） */
  createWindow(): BrowserWindow;
  /** 聊天窗口引用：存在时 toast 跟随其所在显示器 */
  getChatWindow(): BrowserWindow | null;
  /** 按窗口区域匹配显示器（electron screen.getDisplayMatching 的注入形式；无交集时内部回退主屏） */
  getDisplayMatching(bounds: ToastBounds): { workArea: ToastDisplayWorkArea };
  /** 鼠标所在位置（electron screen.getCursorScreenPoint 的注入形式） */
  getCursorScreenPoint(): { x: number; y: number };
  /**
   * 队列清空后的窗口销毁延迟（毫秒）。
   * - 缺省：TOAST_IDLE_TEARDOWN_MS（按需创建，空闲回收渲染进程）
   * - null：常驻不销毁（CYRENE_LAZY_TOAST_WINDOW=0 的急切模式/排障）
   */
  idleTeardownMs?: number | null;
}

/**
 * toast 窗口控制器：定位（四级回退链）、高度协议、显示/隐藏、按需创建/回收。
 *
 * 生命周期（默认按需）：
 *   - 首个 toast 到来时才创建 BrowserWindow 并加载渲染页（启动零常驻渲染进程）
 *   - 页面 did-finish-load 前的事件入队保序（首条 toast 的推送与音效不丢；
 *     页面就绪后渲染页还会经 TOAST_GET_ALL 拉权威状态兜底）
 *   - 队列空 → 整窗 hide；超过 idleTeardownMs 无新 toast → destroy 回收
 *   - 连续 toast 在存活期内复用同一窗口，不反复重建
 *
 * 急切模式（idleTeardownMs=null + preload()）：兼容旧行为——启动即建窗预热，
 * 首次弹出零延迟，窗口常驻不销毁。
 */
export function createToastWindowController(deps: ToastWindowDeps) {
  const idleTeardownMs = deps.idleTeardownMs === undefined ? TOAST_IDLE_TEARDOWN_MS : deps.idleTeardownMs;
  let window: BrowserWindow | null = null;
  /** 聊天窗口最近一次的区域：窗口销毁后仍用该区域匹配显示器（toast 继续在那块屏幕弹出） */
  let lastChatBounds: ToastBounds | null = null;
  /** 渲染页最近上报的内容高度（高度协议） */
  let contentHeight = 0;
  /** 渲染页是否已 did-finish-load（未就绪时 send 一律入队） */
  let pageReady = false;
  /** 页面就绪前的待投递事件（保序；上限 TOAST_PENDING_SENDS_MAX） */
  const pendingSends: Array<{ channel: string; payload: unknown }> = [];
  /** 队列清空后的销毁定时器 */
  let idleTeardownTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelIdleTeardown(): void {
    if (idleTeardownTimer !== null) {
      clearTimeout(idleTeardownTimer);
      idleTeardownTimer = null;
    }
  }

  function scheduleIdleTeardown(): void {
    if (idleTeardownMs === null || idleTeardownTimer !== null) return;
    idleTeardownTimer = setTimeout(() => {
      idleTeardownTimer = null;
      destroyWindow();
    }, idleTeardownMs);
    if (typeof idleTeardownTimer.unref === "function") idleTeardownTimer.unref();
  }

  /** 回收窗口与页面级状态（contentHeight 归零：下一个窗口等自己的渲染页上报） */
  function destroyWindow(): void {
    const win = window;
    window = null;
    pageReady = false;
    pendingSends.length = 0;
    contentHeight = 0;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  function sendNow(channel: string, payload: unknown): void {
    const win = window;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // 页面未就绪/正在销毁：忽略本次投递
    }
  }

  /** 页面就绪：按序补投队列（首个 toast 的 push/音效不丢） */
  function flushPendingSends(): void {
    pageReady = true;
    const queued = pendingSends.splice(0, pendingSends.length);
    for (const item of queued) sendNow(item.channel, item.payload);
  }

  function ensureWindow(): BrowserWindow {
    cancelIdleTeardown();
    if (!window || window.isDestroyed()) {
      window = deps.createWindow();
      pageReady = false;
      const webContents = window.webContents as unknown as {
        once?: (event: string, listener: () => void) => void;
      } | undefined;
      if (webContents && typeof webContents.once === "function") {
        webContents.once("did-finish-load", flushPendingSends);
      } else {
        // 无 webContents 事件（测试替身等）：按就绪处理，直接投递
        pageReady = true;
      }
    }
    return window;
  }

  /**
   * 四级回退链选显示器：
   * 聊天窗口 → 最近记录的聊天窗口区域 → 鼠标所在 → 主屏（getDisplayMatching 内部兜底）。
   * 用户最后一次把 Cyrene 放在哪块屏幕，toast 就应该在那里出来。
   */
  function resolveDisplay(): { workArea: ToastDisplayWorkArea } {
    const chat = deps.getChatWindow();
    if (chat && !chat.isDestroyed()) {
      try {
        const bounds = chat.getBounds();
        if (bounds.width > 0 && bounds.height > 0) {
          lastChatBounds = bounds;
          return deps.getDisplayMatching(bounds);
        }
      } catch {
        // 聊天窗口 bounds 读取失败（销毁竞态）：走下一级
      }
    }
    if (lastChatBounds) {
      return deps.getDisplayMatching(lastChatBounds);
    }
    const cursor = deps.getCursorScreenPoint();
    return deps.getDisplayMatching({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
  }

  /** 高度协议：内容高度 clamp 到工作区 60%，贴右下角向上排布 */
  function applyBounds(): void {
    const win = window;
    if (!win || win.isDestroyed()) return;
    const area = resolveDisplay().workArea;
    const maxHeight = Math.floor(area.height * TOAST_MAX_WORKAREA_RATIO);
    const height = Math.max(1, Math.min(contentHeight, maxHeight));
    const x = area.x + area.width - TOAST_WINDOW_WIDTH;
    const y = area.y + area.height - height;
    try {
      win.setBounds({ x, y, width: TOAST_WINDOW_WIDTH, height });
    } catch {
      // 窗口销毁竞态：忽略，下次显示前会重算
    }
  }

  return {
    /**
     * 渲染页上报内容高度（TOAST_RESIZE）。
     * 高度变化必须立即应用：渲染页首帧测量发生在窗口尚小时，若等下一次
     * syncVisibility 才应用，首条 toast 会以旧高度显示（甚至卡在 1px 死锁）。
     * 隐藏期间同样记账并更新 bounds，显示前无需再补算。
     */
    updateHeight(height: number): void {
      if (!Number.isFinite(height) || height <= 0) return;
      const rounded = Math.round(height);
      if (rounded === contentHeight) return;
      contentHeight = rounded;
      applyBounds();
    },

    /** 当前是否有 toast 决定整窗显隐；显示前重算位置（屏幕/高度可能已变化） */
    syncVisibility(hasToasts: boolean): void {
      if (hasToasts) {
        const win = ensureWindow();
        applyBounds();
        if (!win.isVisible()) {
          // showInactive：绝不抢焦点，避免打断用户正在输入
          win.showInactive();
        }
      } else {
        if (window && !window.isDestroyed() && window.isVisible()) {
          window.hide();
        }
        if (window && !window.isDestroyed()) {
          scheduleIdleTeardown();
        }
      }
    },

    /**
     * 向 toast 渲染页发送事件。页面未就绪（首次创建/重建加载中）时入队，
     * did-finish-load 后按序补投——首个 toast 的推送与音效不丢；
     * 页面未就绪期间被丢弃的极端情况由渲染页 TOAST_GET_ALL 兜底。
     */
    send(channel: string, payload: unknown): void {
      if (!window || window.isDestroyed() || !pageReady) {
        pendingSends.push({ channel, payload });
        if (pendingSends.length > TOAST_PENDING_SENDS_MAX) pendingSends.shift();
        return;
      }
      sendNow(channel, payload);
    },

    /** 预创建窗口并隐藏加载页面（急切模式调用，首次弹出零延迟） */
    preload(): void {
      ensureWindow();
    },

    /** 当前窗口是否可见（供测试与状态查询） */
    isVisible(): boolean {
      return !!window && !window.isDestroyed() && window.isVisible();
    },

    /** 窗口是否已物化（按需模式下启动后为 false，供测试与状态查询） */
    isMaterialized(): boolean {
      return !!window && !window.isDestroyed();
    },

    /** IPC sender 校验：只有 toast 窗口的 webContents 才被允许上报点击/关闭/高度 */
    owns(webContents: { id: number }): boolean {
      const win = window;
      return !!win && !win.isDestroyed() && win.webContents.id === webContents.id;
    },

    dispose(): void {
      cancelIdleTeardown();
      destroyWindow();
    },
  };
}

export type ToastWindowController = ReturnType<typeof createToastWindowController>;