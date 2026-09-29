/**
 * 缓存目录 IPC（数据/缓存分离）：查询当前策略 / 选目录 / 设置覆盖。
 *
 * 与便携 IPC 同风格：get 返回纯状态（渲染端与 native 设置窗共用），
 * set 落设置并提示重启生效；缓存为可重建产物，不做自动迁移
 * （旧目录内容不搬迁，可手动删除）。
 */

import { dialog } from "electron";
import {
  loadGeneralSettings,
  saveGeneralSettings,
} from "../settings/settings-facade";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getPortableDataLocationStatus } from "./portable-runtime";
import { resolveCacheDir, setCacheDirOverride } from "../cache-dir";
import type { PortableIpcDependencies } from "./portable-ipc";
import { IPC } from "../../shared/ipc-channels";

/** 渲染端/native 设置窗展示用的缓存目录状态。 */
export interface CacheDirStatus {
  /** 当前生效缓存根（= override 或默认策略解析结果）。 */
  effectiveDir: string;
  /** 用户覆盖路径（持久值）；null = 跟随默认策略。 */
  override: string | null;
  /** 便携模式是否激活（默认策略 = 程序目录旁 cache/）。 */
  portableActive: boolean;
}

export function registerCacheDirIpc(deps: PortableIpcDependencies): void {
  const ipc: IpcScope = deps.ipc ?? createIpcScope();

  ipc.handle(IPC.SETTINGS_CACHE_GET, (): CacheDirStatus => {
    let portableActive = false;
    try {
      portableActive = getPortableDataLocationStatus().enabled;
    } catch {
      // 启动极早期便携状态不可用
    }
    const override = loadGeneralSettings().cacheDirOverride ?? null;
    return {
      effectiveDir: resolveCacheDir(),
      override,
      portableActive,
    };
  });

  ipc.handle(IPC.SETTINGS_CACHE_PICK_DIR, async () => {
    const parent = deps.getParentWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择缓存目录（模型 / 音频 / 插件包等可重建产物）",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipc.handle(IPC.SETTINGS_CACHE_SET, (_event, payload: unknown) => {
    const dir = typeof payload === "string" && payload.trim() ? payload.trim() : null;
    const current = loadGeneralSettings().cacheDirOverride ?? null;
    if ((dir ?? null) === current) return { ok: true, changed: false, restartRequired: false };
    // 落设置 + 热切换进程内解析（新下载即时走新目录；transformers 等长驻
    // 组件已按旧根加载，需重启换根——统一提示重启）
    saveGeneralSettings({ cacheDirOverride: dir ?? undefined });
    setCacheDirOverride(dir);
    return { ok: true, changed: true, restartRequired: true };
  });
}
