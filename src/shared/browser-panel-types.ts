export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPanelTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  crashed: boolean;
}

export interface BrowserPanelState {
  activeTabId: string;
  tabs: BrowserPanelTabState[];
}

export type BrowserPanelResult =
  | { ok: true }
  | { ok: false; error: "invalid_url" | "unsupported_protocol" | "unavailable" };

export const EMPTY_BROWSER_PANEL_STATE: BrowserPanelState = { activeTabId: "", tabs: [] };
