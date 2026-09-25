/**
 * 界面字体导入/恢复（Electron 设置页 IPC 与 native 设置窗动作共用）。
 *
 * 行为与旧 settings-ipc 内联实现一致：
 *   - 只接受 .ttf/.otf，<=50MB；复制到 userData/ui-fonts/custom-<uuid>.<ext>
 *   - 保存 general.uiFont = { kind: "custom", fileName, displayName }
 *   - 替换/恢复时清理旧的自定义字体文件
 * 返回结构化结果，调用方负责弹提示（native 走 settings-notice）。
 */
import { app, dialog } from "electron";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { DEFAULT_UI_FONT, isSupportedFontFileName } from "../../shared/ui-font";
import type { GeneralSettings } from "./general-settings";

export interface UiFontDeps {
  getGeneralSettings(): GeneralSettings;
  saveGeneralSettings(patch: Partial<GeneralSettings>): GeneralSettings;
}

export function getUiFontsDir(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

export function getCustomFontDisplayName(filePath: string): string {
  return (
    path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim().slice(0, 80) || "自定义字体"
  );
}

export interface UiFontResult {
  ok: boolean;
  canceled?: boolean;
  displayName?: string;
  error?: string;
}

/** 弹系统文件框选择并导入字体（native 不传路径，宿主弹框）。 */
export async function pickAndImportUiFont(deps: UiFontDeps): Promise<UiFontResult> {
  const selected = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
  const sourcePath = selected.filePaths[0];
  try {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension !== ".ttf" && extension !== ".otf") throw new Error("仅支持 .ttf 或 .otf 字体文件");
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) {
      throw new Error("字体文件无效或超过 50 MB");
    }
    const fileName = `custom-${randomUUID()}${extension}`;
    if (!isSupportedFontFileName(fileName)) throw new Error("字体文件名无效");
    const fontsDir = getUiFontsDir();
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(fontsDir, fileName));
    const before = deps.getGeneralSettings().uiFont;
    const saved = deps.saveGeneralSettings({
      uiFont: { kind: "custom", fileName, displayName: getCustomFontDisplayName(sourcePath) },
    });
    if (before.kind === "custom" && before.fileName !== fileName) {
      const oldPath = path.join(fontsDir, before.fileName);
      if (isSupportedFontFileName(before.fileName)) fs.rmSync(oldPath, { force: true });
    }
    return { ok: true, displayName: saved.uiFont.kind === "custom" ? saved.uiFont.displayName : "思源黑体（默认）" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 恢复默认字体并清理自定义字体文件。 */
export function resetUiFont(deps: UiFontDeps): UiFontResult {
  try {
    const before = deps.getGeneralSettings().uiFont;
    const saved = deps.saveGeneralSettings({ uiFont: DEFAULT_UI_FONT });
    if (before.kind === "custom" && isSupportedFontFileName(before.fileName)) {
      fs.rmSync(path.join(getUiFontsDir(), before.fileName), { force: true });
    }
    return { ok: true, displayName: saved.uiFont.kind === "custom" ? saved.uiFont.displayName : "思源黑体（默认）" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
