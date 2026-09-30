import { randomUUID } from "node:crypto";
import { Menu, session, WebContentsView, type BrowserWindow, type Session } from "electron";
import {
  type BrowserPanelBounds,
  type BrowserPanelResult,
  type BrowserPanelState,
  type BrowserPanelTabState,
} from "../../shared/browser-panel-types";
import { getLocaleContext } from "../locale-context";
import { allowInternalNavigation } from "../windows/external-link";

const BROWSER_PARTITION = "persist:cyrene-right-browser";
const EMPTY_TAB_STATE = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
} as const;

interface BrowserTab {
  id: string;
  view: WebContentsView | null;
  state: BrowserPanelTabState;
}

function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export class BrowserPanelController {
  private tabs: BrowserTab[] = [];
  private activeTabId = "";
  private browserSession: Session | null = null;
  private parentWindow: BrowserWindow | null = null;
  private bounds: BrowserPanelBounds | null = null;
  private disposed = false;
  private readonly observedWindows = new WeakSet<BrowserWindow>();
  private readonly onStateChanged: (state: BrowserPanelState) => void;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null, onStateChanged: (state: BrowserPanelState) => void) {
    this.getWindow = getWindow;
    this.onStateChanged = onStateChanged;
    this.createTab(true);
  }

  getState(): BrowserPanelState {
    return {
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => ({ ...tab.state })),
    };
  }

  setBounds(bounds: BrowserPanelBounds | null): void {
    this.bounds = bounds;
    const win = this.getWindow();
    if (this.parentWindow && this.parentWindow !== win) {
      this.destroyViews();
      this.parentWindow = null;
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.applyBounds();
      return;
    }
    const activeTab = this.getActiveTab();
    if (activeTab?.state.url && !activeTab.view) {
      try {
        this.ensureView(activeTab);
      } catch {
        activeTab.state = { ...activeTab.state, loading: false, error: "unavailable" };
        this.publish();
      }
    }
    this.applyBounds();
  }

  async navigate(input: string): Promise<BrowserPanelResult> {
    const activeTab = this.getActiveTab();
    if (!activeTab) return { ok: false, error: "unavailable" };
    return this.navigateTab(activeTab, input);
  }

  newTab(): boolean {
    if (this.disposed) return false;
    this.createTab(true);
    this.applyBounds();
    this.publish();
    return true;
  }

  activateTab(tabId: string): boolean {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    this.activeTabId = tab.id;
    if (this.bounds && tab.state.url && !tab.view) {
      try {
        this.ensureView(tab);
      } catch {
        tab.state = { ...tab.state, loading: false, error: "unavailable" };
      }
    }
    this.applyBounds();
    this.publish();
    return true;
  }

  closeTab(tabId: string): boolean {
    const index = this.tabs.findIndex((candidate) => candidate.id === tabId);
    if (index < 0) return false;
    const tab = this.tabs[index];
    if (this.tabs.length === 1) {
      this.destroyTabView(tab);
      tab.state = { id: tab.id, ...EMPTY_TAB_STATE };
      this.activeTabId = tab.id;
    } else {
      this.destroyTabView(tab);
      this.tabs.splice(index, 1);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      }
    }
    this.applyBounds();
    this.publish();
    return true;
  }

  goBack(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoBack()) contents.goBack();
  }

  goForward(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.canGoForward()) contents.goForward();
  }

  reload(): void {
    const tab = this.getActiveTab();
    const contents = tab?.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      if (tab.state.crashed) {
        tab.state = { ...tab.state, crashed: false, error: undefined };
        this.publish();
      }
      contents.reload();
    }
  }

  stop(): void {
    const contents = this.getActiveTab()?.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
  }

  async clearCookies(): Promise<void> {
    const browserSession = this.getSession();
    await browserSession.clearStorageData({ storages: ["cookies"] });
    await browserSession.cookies.flushStore();
    for (const tab of this.tabs) {
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed() && tab.state.url) contents.reload();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyViews();
    this.tabs = [];
    this.browserSession = null;
    this.parentWindow = null;
  }

  private getActiveTab(): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  private createTab(activate: boolean): BrowserTab {
    const id = randomUUID();
    const tab: BrowserTab = { id, view: null, state: { id, ...EMPTY_TAB_STATE } };
    this.tabs.push(tab);
    if (activate || !this.activeTabId) this.activeTabId = id;
    return tab;
  }

  private async navigateTab(tab: BrowserTab, input: string): Promise<BrowserPanelResult> {
    if (this.disposed || !this.tabs.includes(tab)) return { ok: false, error: "unavailable" };
    const url = parseHttpUrl(input);
    if (!url) {
      const unsupported = /^[a-z][a-z\d+.-]*:/i.test(input.trim());
      return { ok: false, error: unsupported ? "unsupported_protocol" : "invalid_url" };
    }
    let view: WebContentsView | null;
    try {
      view = this.ensureView(tab, false);
    } catch {
      tab.state = { ...tab.state, loading: false, error: "unavailable" };
      this.publish();
      return { ok: false, error: "unavailable" };
    }
    if (!view) return { ok: false, error: "unavailable" };
    this.applyBounds();
    tab.state = { ...tab.state, url: url.href, error: undefined, crashed: false };
    this.publish();
    try {
      await view.webContents.loadURL(url.href);
      return { ok: true };
    } catch {
      if (!view.webContents.isDestroyed() && this.tabs.includes(tab)) {
        tab.state = { ...tab.state, loading: false, error: "load_failed" };
        this.publish();
      }
      return { ok: false, error: "unavailable" };
    }
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

  private ensureView(tab: BrowserTab, restore = true): WebContentsView | null {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    if (tab.view && !tab.view.webContents.isDestroyed() && this.parentWindow === win) return tab.view;
    if (tab.view) this.destroyTabView(tab);
    if (this.parentWindow && this.parentWindow !== win) this.destroyViews();
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
    tab.view = view;
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.attachEvents(tab, view);
    if (!this.observedWindows.has(win)) {
      this.observedWindows.add(win);
      win.once("closed", () => {
        if (this.parentWindow === win) {
          this.destroyViews();
          this.parentWindow = null;
        }
      });
    }
    if (restore && tab.state.url) {
      void view.webContents.loadURL(tab.state.url).catch(() => {
        if (!view.webContents.isDestroyed() && this.tabs.includes(tab)) {
          tab.state = { ...tab.state, loading: false, error: "load_failed" };
          this.publish();
        }
      });
    }
    return view;
  }

  private attachEvents(tab: BrowserTab, view: WebContentsView): void {
    const contents = view.webContents;
    allowInternalNavigation(contents);
    const isLive = () => this.tabs.includes(tab) && tab.view === view && !contents.isDestroyed();
    const update = () => {
      if (!isLive()) return;
      tab.state = {
        ...tab.state,
        url: contents.getURL(),
        title: contents.getTitle(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      };
      this.publish();
    };
    contents.on("did-start-loading", () => {
      if (!isLive()) return;
      tab.state = { ...tab.state, loading: true, error: undefined, crashed: false };
      this.publish();
    });
    contents.on("did-stop-loading", () => {
      if (!isLive()) return;
      tab.state = { ...tab.state, loading: false };
      update();
    });
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", (_event, title) => {
      if (!isLive()) return;
      tab.state = { ...tab.state, title };
      this.publish();
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (!isLive() || errorCode === -3 || !isMainFrame) return;
      tab.state = { ...tab.state, loading: false, error: "load_failed" };
      this.publish();
    });
    contents.on("render-process-gone", () => {
      if (!this.tabs.includes(tab)) return;
      tab.state = { ...tab.state, loading: false, crashed: true, error: "renderer_crashed" };
      this.publish();
    });
    contents.on("will-navigate", (event, targetUrl) => {
      if (!parseHttpUrl(targetUrl)) event.preventDefault();
    });
    contents.on("will-redirect", (event, targetUrl) => {
      if (!parseHttpUrl(targetUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (parseHttpUrl(url)) this.openNewTab(url, disposition !== "background-tab");
      return { action: "deny" };
    });
    contents.on("context-menu", (_event, params) => {
      if (!params.linkURL || !parseHttpUrl(params.linkURL) || !this.parentWindow || this.parentWindow.isDestroyed()) return;
      const locale = getLocaleContext().uiLocale.toLowerCase();
      const label = locale.startsWith("zh") ? "在新标签页打开" : locale.startsWith("ja") ? "新しいタブで開く" : "Open link in new tab";
      Menu.buildFromTemplate([{
        label,
        click: () => this.openNewTab(params.linkURL, true),
      }]).popup({ window: this.parentWindow });
    });
    contents.on("destroyed", () => {
      if (tab.view === view) tab.view = null;
    });
  }

  private openNewTab(url: string, activate: boolean): void {
    const parsed = parseHttpUrl(url);
    if (!parsed || this.disposed) return;
    const tab = this.createTab(activate);
    if (activate) this.applyBounds();
    this.publish();
    void this.navigateTab(tab, parsed.href);
  }

  private applyBounds(): void {
    const win = this.parentWindow;
    const bounds = this.bounds;
    if (!win || win.isDestroyed()) return;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      for (const tab of this.tabs) tab.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const [windowWidth, windowHeight] = win.getContentSize();
    const x = Math.max(0, Math.min(windowWidth, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(windowHeight, Math.round(bounds.y)));
    const width = Math.max(0, Math.min(windowWidth - x, Math.round(bounds.width)));
    const height = Math.max(0, Math.min(windowHeight - y, Math.round(bounds.height)));
    for (const tab of this.tabs) {
      const viewBounds = tab.id === this.activeTabId ? { x, y, width, height } : { x: 0, y: 0, width: 0, height: 0 };
      tab.view?.setBounds(viewBounds);
    }
  }

  private destroyTabView(tab: BrowserTab): void {
    const view = tab.view;
    const win = this.parentWindow;
    tab.view = null;
    if (!view) return;
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    } catch { /* 主窗口关闭时原生视图可能已被 Electron 移除 */ }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* 忽略退出阶段的重复销毁 */ }
  }

  private destroyViews(): void {
    for (const tab of this.tabs) this.destroyTabView(tab);
  }

  private publish(): void {
    this.onStateChanged(this.getState());
  }
}
