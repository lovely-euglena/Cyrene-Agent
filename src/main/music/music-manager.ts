// 本地音乐窗口管理（TS 侧）：
//   - 设置读取（musicFolders / musicAgentAccess）与持久化（音乐窗 cmd 事件）；
//   - native 配置下发（dbPath / mpvPath / folders）与窗口打开；
//   - 播放与曲库本体在 cyrene-native 进程（MusicService），本模块只做胶水。
//
// 权限模型：Agent 音乐权限独立成档（musicAgentAccess），由音乐窗/偏好设置显式
// 开启；工具实现（music-tools.ts）按档位 fail-closed。P2 写标签等文件操作会
// 额外叠加全局 fs-write 闸门。

import { app } from "electron";
import * as path from "path";
import { detectMpvBinary } from "../utils/mpv-detect";
import { loadGeneralSettings, saveGeneralSettings } from "../settings/settings-facade";
import { getActiveNativeClient, spawnNativeWindow } from "../windows/native-windows-bridge";
import { logger, LogTag } from "../logger";

export type MusicAgentAccess = "off" | "read" | "control" | "manage";

export function getMusicAgentAccess(): MusicAgentAccess {
  const access = loadGeneralSettings().musicAgentAccess;
  return access === "off" || access === "control" || access === "manage" ? access : "read";
}

export function getMusicFolders(): string[] {
  return loadGeneralSettings().musicFolders ?? [];
}

export function getMusicDbPath(): string {
  return path.join(app.getPath("userData"), "music", "music-library.db");
}

/** native music.config 载荷（窗口打开与工具查询共用同一路径）。 */
export function buildMusicConfig(): Record<string, unknown> {
  return {
    dbPath: getMusicDbPath(),
    mpvPath: detectMpvBinary(),
    folders: getMusicFolders(),
  };
}

/** 打开本地音乐窗（已开则激活；native 未启用返回 false）。 */
export async function openMusicWindow(): Promise<boolean> {
  const client = getActiveNativeClient();
  if (!client) {
    logger.warn(LogTag.Cyrene, "[Music] native windows unavailable; music window cannot open");
    return false;
  }
  try {
    await client.requestData({ op: "music.config", config: buildMusicConfig() });
    return await spawnNativeWindow("music", { agentAccess: getMusicAgentAccess() });
  } catch (error) {
    logger.warn(LogTag.Cyrene, `[Music] open window failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** 音乐窗 cmd 事件 → 设置持久化（folders-changed / agent-access-changed）。 */
export function handleMusicAction(action: string, payload: Record<string, unknown>): void {
  if (action === "folders-changed") {
    const folders = Array.isArray(payload.folders)
      ? payload.folders.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    saveGeneralSettings({ musicFolders: folders });
    return;
  }
  if (action === "agent-access-changed") {
    const access = payload.access;
    if (access === "off" || access === "read" || access === "control" || access === "manage") {
      saveGeneralSettings({ musicAgentAccess: access });
    }
  }
}
