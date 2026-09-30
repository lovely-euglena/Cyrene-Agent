import "./window-corner-radius";
import "./message-typography";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import type { UiFont } from "../../shared/ui-font";
import type { ChatAppearanceSettings } from "../../shared/chat-appearance";

declare global {
  interface Window {
    cyreneTheme?: {
      get: () => Promise<UiTheme>;
      onChanged: (callback: (theme: UiTheme) => void) => () => void;
      getRadius: () => Promise<boolean>;
      onRadiusChanged: (callback: (theme: boolean) => void) => () => void;
    };
    cyreneFont?: {
      get: () => Promise<UiFont>;
      onChanged: (callback: (font: UiFont) => void) => () => void;
    };
    cyreneAppearance?: {
      get: () => Promise<ChatAppearanceSettings>;
      onChanged: (callback: (settings: ChatAppearanceSettings) => void) => () => void;
    };
  }
}

export function applyUiTheme(theme: unknown): void {
  document.documentElement.dataset.uiTheme = normalizeUiTheme(theme);
  delete document.documentElement.dataset.uiThemePending;
}

function applyRadius(radius: boolean): void {
  document.documentElement.dataset.uiRadius = radius ? undefined : "false";
}

document.documentElement.dataset.uiFont = "source-han";

void window.cyreneTheme?.get()
  .then(applyUiTheme)
  .catch(() => applyUiTheme("pearl-white"));

window.cyreneTheme?.onChanged((theme) => {
  applyUiTheme(theme);
});

void window.cyreneTheme?.getRadius()
  .then(applyRadius)
  .catch(() => applyRadius(true));

window.cyreneTheme?.onRadiusChanged((theme) => {
  applyRadius(theme);
});
