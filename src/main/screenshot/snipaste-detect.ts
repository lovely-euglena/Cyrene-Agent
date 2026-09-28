// Snipaste 可执行文件探测——截图后端「命令行接 Snipaste」的定位层。
//
// 探测优先级：
//   1. 设置里的显式路径（用户手填；填了就以它为准，不再回退自动探测）
//   2. CYRENE_SNIPASTE_PATH 环境变量（调试/便携用途）
//   3. PATH 中的 Snipaste.exe（含微软商店版 App Execution Alias）
//   4. 常见安装目录（Program Files / LocalAppData）
//   5. 注册表卸载项 DisplayIcon / InstallLocation（仅 Windows，best-effort）
//
// 设计：纯函数 + 可注入依赖，便于单测；注册表查询失败静默忽略（探测是 best-effort，
// 不因权限/本地化差异报错）。

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

export const SNIPASTE_EXE_NAME = "Snipaste.exe";

/** 注册表卸载项（HKCU + HKLM 64/32 位视图）。 */
export const SNIPASTE_REGISTRY_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

export interface SnipasteDetectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
  /** 读取注册表卸载项原始输出；默认调 reg.exe（失败返回空串）。 */
  queryRegistry?: () => Promise<string>;
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function cleanPathValue(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/^"|"$/g, "");
  return trimmed ? trimmed : null;
}

/** 在 PATH 目录里查找 Snipaste.exe（覆盖商店版 App Execution Alias）。 */
export function findSnipasteInPath(
  env: NodeJS.ProcessEnv,
  existsSync: (candidate: string) => boolean,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, SNIPASTE_EXE_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 常见安装目录（安装器默认位置 + 商店版别名目录）。 */
export function findSnipasteInCommonLocations(
  env: NodeJS.ProcessEnv,
  existsSync: (candidate: string) => boolean,
): string | null {
  const candidates: string[] = [];
  const programFiles = cleanPathValue(env.ProgramFiles);
  const programFilesX86 = cleanPathValue(env["ProgramFiles(x86)"]);
  const localAppData = cleanPathValue(env.LOCALAPPDATA);
  const appData = cleanPathValue(env.APPDATA);
  if (programFiles) candidates.push(path.join(programFiles, "Snipaste", SNIPASTE_EXE_NAME));
  if (programFilesX86) candidates.push(path.join(programFilesX86, "Snipaste", SNIPASTE_EXE_NAME));
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "Snipaste", SNIPASTE_EXE_NAME));
    candidates.push(path.join(localAppData, "Microsoft", "WindowsApps", SNIPASTE_EXE_NAME));
  }
  if (appData) candidates.push(path.join(appData, "Snipaste", SNIPASTE_EXE_NAME));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 从 `reg query ... /s /f Snipaste` 的输出里解析安装路径。
 *
 * 形如：
 *   `    DisplayIcon    REG_SZ    C:\Program Files\Snipaste\Snipaste.exe,0`
 *   `    InstallLocation    REG_SZ    C:\Program Files\Snipaste`
 * DisplayIcon 更精确，优先；InstallLocation 目录补上文件名。
 */
export function parseSnipasteFromRegistry(output: string): string | null {
  let installLocation: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(DisplayIcon|InstallLocation)\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    let value = match[2].trim().replace(/^"|"$/g, "");
    if (!value) continue;
    if (match[1].toLowerCase() === "displayicon") {
      value = value.replace(/,\d+$/, "");
      if (value.toLowerCase().endsWith(".exe")) return value;
      continue;
    }
    installLocation = value;
  }
  if (installLocation) {
    return installLocation.toLowerCase().endsWith(".exe")
      ? installLocation
      : path.join(installLocation, SNIPASTE_EXE_NAME);
  }
  return null;
}

function runRegQuery(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", key, "/s", "/f", "Snipaste"],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        resolve(error ? "" : String(stdout ?? ""));
      },
    );
  });
}

async function queryWindowsRegistryDefault(): Promise<string> {
  const outputs = await Promise.all(SNIPASTE_REGISTRY_KEYS.map((key) => runRegQuery(key)));
  return outputs.join("\n");
}

/**
 * 探测 Snipaste.exe 绝对路径；找不到返回 null。
 * 显式 override 非空时以它为准：文件不存在也返回 null（不回退自动探测，避免掩盖用户填错的路径）。
 */
export async function detectSnipasteExecutable(
  overridePath: string | undefined,
  deps: SnipasteDetectDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const existsSync = deps.existsSync ?? defaultExists;

  const override = cleanPathValue(overridePath);
  if (override) {
    return existsSync(override) ? override : null;
  }

  const envPath = cleanPathValue(env.CYRENE_SNIPASTE_PATH);
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }

  const fromPath = findSnipasteInPath(env, existsSync);
  if (fromPath) return fromPath;

  const fromCommon = findSnipasteInCommonLocations(env, existsSync);
  if (fromCommon) return fromCommon;

  if (platform === "win32") {
    try {
      const registryOutput = deps.queryRegistry
        ? await deps.queryRegistry()
        : await queryWindowsRegistryDefault();
      const fromRegistry = parseSnipasteFromRegistry(registryOutput);
      if (fromRegistry && existsSync(fromRegistry)) return fromRegistry;
    } catch {
      // best-effort：注册表探测失败不影响其它路径的结果
    }
  }

  return null;
}
