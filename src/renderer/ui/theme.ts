import "./window-corner-radius";
import "./message-typography";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
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

// ── 界面字体（外观设置「界面字体」导入/恢复默认） ─────────────────────
// 自定义字体经 local-font:// 协议加载（userData/ui-fonts/ 白名单映射）；
// 通过覆写 --rb-font-ui 让 tokens.css 的 --rb-font-sans / 各组件字体一并生效。
// 上游 2026-09-27 砍掉过这段应用逻辑（只留存储），fork 保留功能需在此恢复。
const CUSTOM_FONT_STYLE_ID = "cyrene-custom-font";
const DEFAULT_FONT_STACK =
  'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

function applyFont(value: unknown): void {
  const font = normalizeUiFont(value);
  const style = document.getElementById(CUSTOM_FONT_STYLE_ID);
  if (font.kind !== "custom") {
    style?.remove();
    document.documentElement.style.removeProperty("--rb-font-ui");
    document.documentElement.dataset.uiFont = "source-han";
    return;
  }
  const customStyle = style ?? document.head.appendChild(
    Object.assign(document.createElement("style"), { id: CUSTOM_FONT_STYLE_ID }),
  );
  const format = font.fileName.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
  customStyle.textContent =
    `@font-face { font-family: "Cyrene Custom Font"; src: url("local-font://${encodeURIComponent(font.fileName)}") format("${format}"); font-display: swap; }`;
  document.documentElement.style.setProperty("--rb-font-ui", `"Cyrene Custom Font", ${DEFAULT_FONT_STACK}`);
  document.documentElement.dataset.uiFont = "custom";
}

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

// 界面字体：先按默认渲染，再拉取当前值；切换时（含 native 设置窗导入）实时应用
applyFont(DEFAULT_UI_FONT);
void window.cyreneFont?.get()
  .then(applyFont)
  .catch(() => applyFont(DEFAULT_UI_FONT));
window.cyreneFont?.onChanged((font) => {
  applyFont(font);
});
