export const UI_ICON_PRESETS = [
  { id: "cyrene-sticker", label: "贴纸", fileName: "cyrene-sticker.png", previewPath: "../icons/cyrene-sticker.png" },
  { id: "cyrene-pink", label: "绮梦", fileName: "cyrene-pink.png", previewPath: "../icons/cyrene-pink.png" },
  { id: "cyrene-sun", label: "晴光", fileName: "cyrene-sun.png", previewPath: "../icons/cyrene-sun.png" },
] as const;

export type UiIcon = typeof UI_ICON_PRESETS[number]["id"];

/** 默认桌面图标（昔涟贴纸）；旧预设「绮梦 / 晴光」仍可随时切换。 */
export const DEFAULT_UI_ICON: UiIcon = "cyrene-sticker";

export function normalizeUiIcon(value: unknown): UiIcon {
  return UI_ICON_PRESETS.some((item) => item.id === value) ? (value as UiIcon) : DEFAULT_UI_ICON;
}
