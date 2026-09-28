/**
 * 便携模式：Electron 侧运行时（指针读取 + userData 切换 + 设置页状态查询）。
 *
 * `applyPortableDataDirAtStartup` 由 bootstrap.ts 在 index.ts 第一条 import 处
 * 同步调用（app.ready 之前），保证单实例锁、日志、设置存储等都落在最终目录。
 */

import { app } from "electron";
import * as fs from "node:fs";
import {
  readPortableConfig,
  resolveDefaultPortableDataDir,
  resolveInstallRoot,
  resolvePortableConfigPath,
  type DataLocationInput,
} from "./portable-location";
import type { PortableDataLocationStatus } from "../../shared/portable-mode";

export type { PortableDataLocationStatus };

interface PortableRuntimeInfo {
  systemDataDir: string;
  installRoot: string;
  suggestedDir: string;
  configPath: string;
}

let runtime: PortableRuntimeInfo | null = null;

function captureRuntimeInfo(): PortableRuntimeInfo {
  const input: DataLocationInput = {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    executablePath: app.getPath("exe"),
  };
  return {
    // 必须在 setPath 之前读取：这是系统默认，用于「关闭便携模式」的目标与界面展示。
    systemDataDir: app.getPath("userData"),
    installRoot: resolveInstallRoot(input),
    suggestedDir: resolveDefaultPortableDataDir(input),
    configPath: resolvePortableConfigPath(input),
  };
}

/** app.ready 之前调用：读取指针文件并切换 userData（幂等）。 */
export function applyPortableDataDirAtStartup(): void {
  if (runtime) return;
  runtime = captureRuntimeInfo();
  const { dataDir } = readPortableConfig(runtime.configPath);
  if (!dataDir) return;
  try {
    // app.setPath 要求目录已存在（否则抛错）；首次启用/程序搬移后自动补建。
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath("userData", dataDir);
    console.log("[Portable] 数据目录:", dataDir);
  } catch (error) {
    console.error("[Portable] 数据目录不可用，回退系统默认:", dataDir, error);
  }
}

export function getPortableRuntimeInfo(): PortableRuntimeInfo {
  if (!runtime) applyPortableDataDirAtStartup();
  if (!runtime) throw new Error("便携模式运行时未初始化");
  return runtime;
}

/** 设置页查询：实时读指针文件（用户可能手改过），生效值取 app.getPath("userData")。 */
export function getPortableDataLocationStatus(): PortableDataLocationStatus {
  const info = getPortableRuntimeInfo();
  const config = readPortableConfig(info.configPath);
  return {
    enabled: config.dataDir !== null,
    dataDir: config.dataDir,
    displayDir: config.storedValue,
    effectiveDataDir: app.getPath("userData"),
    systemDataDir: info.systemDataDir,
    installRoot: info.installRoot,
    suggestedDir: info.suggestedDir,
    configPath: info.configPath,
  };
}
