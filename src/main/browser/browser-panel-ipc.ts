import type { BrowserWindow, WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { BrowserPanelBounds } from "../../shared/browser-panel-types";
import type { IpcScope } from "../application/ipc-scope";
import { BrowserPanelController } from "./browser-panel-controller";

function readBounds(input: unknown): BrowserPanelBounds | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<BrowserPanelBounds>;
  if (![value.x, value.y, value.width, value.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: Math.max(0, value.x!),
    y: Math.max(0, value.y!),
    width: Math.max(0, value.width!),
    height: Math.max(0, value.height!),
  };
}

export function registerBrowserPanelIpc(input: {
  ipc: IpcScope;
  getWindow: () => BrowserWindow | null;
}): BrowserPanelController {
  const controller = new BrowserPanelController(input.getWindow, (state) => {
    const win = input.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.BROWSER_PANEL_STATE_CHANGED, state);
  });
  const authorized = (event: { sender: WebContents }) => {
    const win = input.getWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  };

  input.ipc.handle(IPC.BROWSER_PANEL_GET_STATE, async (event) => {
    if (!authorized(event)) return null;
    await controller.ready();
    return controller.getState();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_SET_BOUNDS, (event, payload: unknown) => {
    if (!authorized(event)) return false;
    if (payload === null) {
      controller.setBounds(null);
      return true;
    }
    const bounds = readBounds(payload);
    if (!bounds) return false;
    controller.setBounds(bounds);
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_NAVIGATE, (event, inputUrl: unknown) => {
    if (!authorized(event) || typeof inputUrl !== "string") return { ok: false, error: "unavailable" };
    return controller.navigate(inputUrl);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_BACK, (event) => {
    if (!authorized(event)) return false;
    controller.goBack();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_FORWARD, (event) => {
    if (!authorized(event)) return false;
    controller.goForward();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_RELOAD, (event) => {
    if (!authorized(event)) return false;
    controller.reload();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_STOP, (event) => {
    if (!authorized(event)) return false;
    controller.stop();
    return true;
  });
  input.ipc.handle(IPC.BROWSER_PANEL_NEW_TAB, (event) => {
    if (!authorized(event)) return false;
    return controller.newTab();
  });
  input.ipc.handle(IPC.BROWSER_PANEL_OPEN_IN_NEW_TAB, (event, url: unknown) => {
    if (!authorized(event) || typeof url !== "string") return { ok: false, error: "unavailable" };
    return controller.openInNewTab(url);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_ACTIVATE_TAB, (event, tabId: unknown) => {
    if (!authorized(event) || typeof tabId !== "string") return false;
    return controller.activateTab(tabId);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_CLOSE_TAB, (event, tabId: unknown) => {
    if (!authorized(event) || typeof tabId !== "string") return false;
    return controller.closeTab(tabId);
  });
  input.ipc.handle(IPC.BROWSER_PANEL_CLEAR_COOKIES, async (event) => {
    if (!authorized(event)) return { ok: false, error: "unavailable" };
    try {
      await controller.clearCookies();
      return { ok: true };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });
  return controller;
}
