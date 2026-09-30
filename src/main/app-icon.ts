import * as path from "path";
import { DEFAULT_UI_ICON, UI_ICON_PRESETS, type UiIcon } from "../shared/ui-icon";

export function getAppIconPath(icon: UiIcon): string {
  const preset = UI_ICON_PRESETS.find((item) => item.id === icon)
    ?? UI_ICON_PRESETS.find((item) => item.id === DEFAULT_UI_ICON)!;
  return path.join(__dirname, "..", "..", "..", "assets", "icon-presets", preset.fileName);
}
