import { session, WebContentsView, type BrowserWindow, type Session } from "electron";
import {
  EMPTY_BROWSER_PANEL_STATE,
  type BrowserPanelBounds,
  type BrowserPanelResult,
  type BrowserPanelState,
} from "../../shared/browser-panel-types";
import { allowInternalNavigation } from "../windows/external-link";

const BROWSER_PARTITION = "persist:cyrene-right-browser";

function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export class BrowserPanelController {
  private view: WebContentsView | null = null;
  private browserSession: Session | null = null;
  private parentWindow: BrowserWindow | null = null;
  private state: BrowserPanelState = { ...EMPTY_BROWSER_PANEL_STATE };
  private bounds: BrowserPanelBounds | null = null;
  private disposed = false;
  private readonly onStateChanged: (state: BrowserPanelState) => void;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null, onStateChanged: (state: BrowserPanelState) => void) {
    this.getWindow = getWindow;
    this.onStateChanged = onStateChanged;
  }

  getState(): BrowserPanelState {
    return { ...this.state };
  }

  setBounds(bounds: BrowserPanelBounds | null): void {
    this.bounds = bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      if (this.view && this.parentWindow && !this.parentWindow.isDestroyed()) {
        this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
      return;
    }
    if (this.view && this.parentWindow !== this.getWindow()) this.destroyView();
    if (!this.view && this.state.url) {
      try {
        const view = this.ensureView();
        if (view) {
          const restoreUrl = this.state.url;
          void view.webContents.loadURL(restoreUrl).catch(() => {
            this.state = { ...this.state, loading: false, error: "load_failed" };
            this.publish();
          });
        }
      } catch {
        this.state = { ...this.state, loading: false, error: "unavailable" };
        this.publish();
      }
    }
    if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed()) return;
    const [windowWidth, windowHeight] = this.parentWindow.getContentSize();
    const x = Math.max(0, Math.min(windowWidth, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(windowHeight, Math.round(bounds.y)));
    const width = Math.max(0, Math.min(windowWidth - x, Math.round(bounds.width)));
    const height = Math.max(0, Math.min(windowHeight - y, Math.round(bounds.height)));
    this.view.setBounds({ x, y, width, height });
  }

  async navigate(input: string): Promise<BrowserPanelResult> {
    if (this.disposed) return { ok: false, error: "unavailable" };
    const url = parseHttpUrl(input);
    if (!url) {
      const unsupported = /^[a-z][a-z\d+.-]*:/i.test(input.trim());
      return { ok: false, error: unsupported ? "unsupported_protocol" : "invalid_url" };
    }
    let view: WebContentsView | null;
    try {
      view = this.ensureView();
    } catch {
      this.state = { ...this.state, loading: false, error: "unavailable" };
      this.publish();
      return { ok: false, error: "unavailable" };
    }
    if (!view) return { ok: false, error: "unavailable" };
    this.state = { ...this.state, url: url.href, error: undefined, crashed: false };
    this.publish();
    try {
      await view.webContents.loadURL(url.href);
      return { ok: true };
    } catch {
      if (!view.webContents.isDestroyed()) {
        this.state = { ...this.state, loading: false, error: "load_failed" };
        this.publish();
      }
      return { ok: false, error: "unavailable" };
    }
  }

  goBack(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoBack()) contents.goBack();
  }

  goForward(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoForward()) contents.goForward();
  }

  reload(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      if (this.state.crashed) {
        this.state = { ...this.state, crashed: false, error: undefined };
        this.publish();
      }
      contents.reload();
    }
  }

  stop(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
  }

  async clearCookies(): Promise<void> {
    const browserSession = this.getSession();
    await browserSession.clearStorageData({ storages: ["cookies"] });
    await browserSession.cookies.flushStore();
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed() && this.state.url) contents.reload();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyView();
    this.browserSession = null;
    this.parentWindow = null;
  }

  private getSession(): Session {
    if (!this.browserSession) {
      const browserSession = session.fromPartition(BROWSER_PARTITION);
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on("will-download", (_event, item) => item.cancel());
      this.browserSession = browserSession;
    }
    return this.browserSession;
  }

  private ensureView(): WebContentsView | null {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    if (this.view && !this.view.webContents.isDestroyed() && this.parentWindow === win) return this.view;
    if (this.view) this.destroyView();
    this.parentWindow = win;
    const view = new WebContentsView({
      webPreferences: {
        session: this.getSession(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.view = view;
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.attachEvents(view);
    win.once("closed", () => {
      if (this.parentWindow === win) {
        this.destroyView();
        this.parentWindow = null;
      }
    });
    if (this.bounds) this.setBounds(this.bounds);
    return view;
  }

  private attachEvents(view: WebContentsView): void {
    const contents = view.webContents;
    allowInternalNavigation(contents);
    const update = () => {
      if (contents.isDestroyed()) return;
      this.state = {
        ...this.state,
        url: contents.getURL(),
        title: contents.getTitle(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      };
      this.publish();
    };
    contents.on("did-start-loading", () => {
      this.state = { ...this.state, loading: true, error: undefined, crashed: false };
      this.publish();
    });
    contents.on("did-stop-loading", () => {
      this.state = { ...this.state, loading: false };
      update();
    });
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", (_event, title) => {
      this.state = { ...this.state, title };
      this.publish();
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (errorCode === -3 || !isMainFrame) return;
      this.state = { ...this.state, loading: false, error: "load_failed" };
      this.publish();
    });
    contents.on("render-process-gone", () => {
      this.state = { ...this.state, loading: false, crashed: true, error: "renderer_crashed" };
      this.publish();
    });
    contents.on("will-navigate", (event, targetUrl) => {
      if (!parseHttpUrl(targetUrl)) event.preventDefault();
    });
    contents.on("will-redirect", (event, targetUrl) => {
      if (!parseHttpUrl(targetUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (parseHttpUrl(url)) void this.navigate(url);
      return { action: "deny" };
    });
    contents.on("destroyed", () => {
      if (this.view === view) this.view = null;
    });
  }

  private destroyView(): void {
    const view = this.view;
    const win = this.parentWindow;
    this.view = null;
    if (!view) return;
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    } catch { /* 主窗口关闭时原生视图可能已被 Electron 移除 */ }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* 忽略退出阶段的重复销毁 */ }
  }

  private publish(): void {
    this.onStateChanged(this.getState());
  }
}
