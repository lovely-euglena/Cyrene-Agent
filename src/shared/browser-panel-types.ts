export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPanelState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  crashed: boolean;
}

export type BrowserPanelResult =
  | { ok: true }
  | { ok: false; error: "invalid_url" | "unsupported_protocol" | "unavailable" };

export const EMPTY_BROWSER_PANEL_STATE: BrowserPanelState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
};
