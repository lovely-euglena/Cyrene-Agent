/**
 * 便携模式：设置页 IPC（状态查询 / 目录选择 / 应用变更）。
 *
 * 应用变更的全部询问走原生对话框（迁移/覆盖），确认后：
 * mkdir →（可选覆盖清空）→ 复制数据 → 写指针文件 → 重启应用。
 */

import { app, dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import * as fs from "node:fs";
import { IPC } from "../../shared/ipc-channels";
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

export function registerPortableIpc(deps: PortableIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();

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
    const parent = deps.getParentWindow() ?? undefined;

    const applyDeps: Omit<PortableApplyDeps, "confirmMigrate" | "confirmOverwrite"> = {
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

    return applyPortableDataLocation(
      {
        enabled: raw.enabled === true,
        dir: typeof raw.dir === "string" ? raw.dir : "",
      },
      {
        ...applyDeps,
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
      },
    );
  });
}
