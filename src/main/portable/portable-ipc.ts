/**
 * 便携模式：应用变更的执行入口（设置页 IPC + native 设置窗共用）。
 *
 * 应用变更的询问：
 *   - 旧 Electron 设置页：请求不带选择 → 宿主弹 Electron 原生对话框；
 *   - .NET 设置窗：WPF 已把 migrationChoice/overwrite 随请求带来 → 不再弹窗。
 * 确认后：mkdir →（可选覆盖清空）→ 复制数据 → 写指针文件 → 重启应用。
 */

import { app, dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import * as fs from "node:fs";
import { IPC } from "../../shared/ipc-channels";
import type { PortableApplyRequest, PortableApplyResult } from "../../shared/portable-mode";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import {
  clearDirectory,
  hasExistingData,
  migrateDataDir,
  validateDataDir,
  writePortableConfig,
} from "./portable-location";
import { applyPortableDataLocation, type PortableApplyDeps } from "./portable-apply";
import { getPortableDataLocationStatus } from "./portable-runtime";

export interface PortableIpcDependencies {
  getParentWindow: () => BrowserWindow | null;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

function showMessageBox(
  parent: BrowserWindow | undefined,
  options: MessageBoxOptions,
): ReturnType<typeof dialog.showMessageBox> {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// 对话框父窗口：registerPortableIpc 注入（旧 Electron 设置页）；
// 未注册（纯 native 路径且请求缺选择）时无父窗口弹框。
let dialogParentProvider: () => BrowserWindow | null = () => null;

function buildApplyDeps(): Omit<PortableApplyDeps, "confirmMigrate" | "confirmOverwrite"> {
  return {
    getStatus: () => getPortableDataLocationStatus(),
    validateTarget: (target, current) => validateDataDir(target, current),
    exists: (dir) => fs.existsSync(dir),
    isDirectory: (dir) => fs.statSync(dir).isDirectory(),
    hasData: (dir) => hasExistingData(dir),
    ensureDirectory: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    clearDirectory: (dir) => clearDirectory(dir),
    migrate: (source, target) => migrateDataDir(source, target),
    writeConfig: (value) => {
      const status = getPortableDataLocationStatus();
      writePortableConfig(status.configPath, value);
    },
    scheduleRelaunch: (task) => {
      setTimeout(task, 800);
    },
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    logger: console,
  };
}

/**
 * 执行数据位置变更（IPC 与 native 设置窗共用）。
 * 请求已带 migrationChoice/overwrite 时不再弹确认框。
 */
export async function applyPortableChange(
  request: PortableApplyRequest,
): Promise<PortableApplyResult> {
  const parent = dialogParentProvider() ?? undefined;
  return applyPortableDataLocation(request, {
    ...buildApplyDeps(),
    confirmMigrate: async ({ currentDir, targetDir }) => {
      const { response } = await showMessageBox(parent, {
        type: "question",
        noLink: true,
        title: "更改数据存储位置",
        message: "是否把现有数据迁移到新目录？",
        detail: [
          `当前数据目录：\n${currentDir}`,
          `新数据目录：\n${targetDir}`,
          "迁移 = 复制聊天记录、设置与插件数据到新目录后重启；不迁移则新目录从现有内容开始（旧目录保留，可手动删除）。",
        ].join("\n\n"),
        buttons: ["迁移数据并重启", "仅切换，不迁移", "取消"],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) return "migrate";
      if (response === 1) return "switch";
      return "cancel";
    },
    confirmOverwrite: async ({ targetDir }) => {
      const { response } = await showMessageBox(parent, {
        type: "warning",
        noLink: true,
        title: "目标目录已有数据",
        message: "迁移会先清空目标目录中的现有内容。",
        detail: `${targetDir}\n\n覆盖后原有内容无法恢复，是否继续？`,
        buttons: ["覆盖并迁移", "取消"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
  });
}

export function registerPortableIpc(deps: PortableIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  dialogParentProvider = deps.getParentWindow;

  ipc.handle(IPC.SETTINGS_PORTABLE_GET, () => getPortableDataLocationStatus());

  ipc.handle(IPC.SETTINGS_PORTABLE_PICK_DIR, async () => {
    const parent = deps.getParentWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择数据目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipc.handle(IPC.SETTINGS_PORTABLE_APPLY, async (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { enabled?: unknown; dir?: unknown };
    return applyPortableChange({
      enabled: raw.enabled === true,
      dir: typeof raw.dir === "string" ? raw.dir : "",
    });
  });
}
