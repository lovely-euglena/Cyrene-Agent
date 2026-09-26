/**
 * 便携模式：数据目录的指针文件解析与迁移 —— 纯逻辑（fs 可注入），不依赖 Electron。
 *
 * 指针文件 `cyrene-portable.json` 与程序同级（打包版 = exe 所在目录；开发版 = 仓库根）：
 *
 *     { "dataDir": "data" }            // 相对路径：相对程序目录解析（默认可随程序整体搬移）
 *     { "dataDir": "D:\\CyreneData" }  // 绝对路径：自定义目录
 *     // 文件不存在 / dataDir 为空 → 使用系统默认 userData（%APPDATA%\\...）
 *
 * 主进程必须在 app.ready 之前读取该文件并 app.setPath("userData", ...)，见 bootstrap.ts；
 * 设置页应用更改时由 portable-apply.ts 编排迁移/覆盖/重启。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const PORTABLE_CONFIG_FILE_NAME = "cyrene-portable.json";

/** 默认便携数据目录的存储值（相对程序目录，程序整体搬移后仍有效）。 */
export const PORTABLE_DEFAULT_DIR_VALUE = "data";

/** 迁移时跳过的 Chromium 易失文件（重启后自动重建；含单实例锁文件）。 */
export const MIGRATION_EXCLUDED_ENTRIES: readonly string[] = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "blob_storage",
  "Crashpad",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "lockfile",
];

export interface PortableFs {
  existsSync(p: string): boolean;
  statSync(p: string): { isDirectory(): boolean };
  readFileSync(p: string, encoding: "utf8"): string;
  writeFileSync(p: string, data: string, encoding: "utf8"): void;
  mkdirSync(p: string, options: { recursive: true }): unknown;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(p: string, options: { recursive: true; force: true }): void;
  readdirSync(p: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  cpSync(
    src: string,
    dest: string,
    options: { recursive: true; force: true; preserveTimestamps: true; errorOnExist: false },
  ): void;
}

const nodeFs = fs as unknown as PortableFs;

export interface DataLocationInput {
  isPackaged: boolean;
  appPath: string;
  executablePath: string;
}

/** 程序根目录：打包版 = exe 所在目录；开发版 = 仓库根。 */
export function resolveInstallRoot(input: DataLocationInput): string {
  return input.isPackaged ? path.dirname(input.executablePath) : input.appPath;
}

/** 指针文件路径（与程序同级）。 */
export function resolvePortableConfigPath(input: DataLocationInput): string {
  return path.join(resolveInstallRoot(input), PORTABLE_CONFIG_FILE_NAME);
}

/** 默认便携数据目录：<程序目录>/data。 */
export function resolveDefaultPortableDataDir(input: DataLocationInput): string {
  return path.join(resolveInstallRoot(input), PORTABLE_DEFAULT_DIR_VALUE);
}

export interface PortableConfig {
  /** 解析后的绝对目录；null = 使用系统默认 userData。 */
  dataDir: string | null;
}

/**
 * 读取指针文件。损坏/不可读时按默认处理（不影响启动），设置页可覆盖写回。
 * 相对路径相对指针文件所在目录（即程序目录）解析。
 */
export function readPortableConfig(
  configPath: string,
  fsImpl: PortableFs = nodeFs,
): PortableConfig {
  try {
    if (!fsImpl.existsSync(configPath)) return { dataDir: null };
    // 用户可能用记事本编辑过指针文件（UTF-8 BOM）——先剥掉再解析。
    const text = fsImpl.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as { dataDir?: unknown };
    const value = typeof raw?.dataDir === "string" ? raw.dataDir.trim() : "";
    if (!value) return { dataDir: null };
    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(path.dirname(configPath), value);
    if (resolved === path.parse(resolved).root) return { dataDir: null };
    return { dataDir: resolved };
  } catch {
    return { dataDir: null };
  }
}

/**
 * 写入指针文件：dataDir=null 时删除文件（回到系统默认）。
 * 先写 .tmp 再 rename，避免写一半被启动读到。
 */
export function writePortableConfig(
  configPath: string,
  dataDir: string | null,
  fsImpl: PortableFs = nodeFs,
): void {
  if (!dataDir) {
    fsImpl.rmSync(configPath, { recursive: true, force: true });
    return;
  }
  fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify({ dataDir }, null, 2)}\n`, "utf8");
  fsImpl.renameSync(tmpPath, configPath);
}

/** Windows 下大小写不敏感的同路径判断。 */
export function isSamePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** child 是否位于 parent 内部（含深层嵌套）。 */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type DataDirValidation =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/** 目标目录合法性：绝对路径、非根目录、不与当前目录重叠、不是同名文件。 */
export function validateDataDir(
  target: string,
  currentDataDir: string,
  fsImpl: PortableFs = nodeFs,
): DataDirValidation {
  const trimmed = target.trim();
  if (!trimmed) return { ok: false, error: "请填写数据目录路径" };
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: "请填写绝对路径（如 D:\\CyreneData）" };
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    return { ok: false, error: "不能把数据目录设为磁盘根目录" };
  }
  const current = path.resolve(currentDataDir);
  if (isSamePath(resolved, current)) {
    return { ok: false, error: "目标目录与当前数据目录相同" };
  }
  if (isInside(resolved, current)) {
    return { ok: false, error: "目标目录不能位于当前数据目录内部" };
  }
  if (isInside(current, resolved)) {
    return { ok: false, error: "目标目录不能是当前数据目录的上级目录" };
  }
  if (fsImpl.existsSync(resolved) && !fsImpl.statSync(resolved).isDirectory()) {
    return { ok: false, error: "目标位置已存在同名文件" };
  }
  return { ok: true, resolved };
}

/** 目录是否存在且非空（读不了也按有数据处理，交给用户确认覆盖）。 */
export function hasExistingData(dir: string, fsImpl: PortableFs = nodeFs): boolean {
  if (!fsImpl.existsSync(dir)) return false;
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true }).length > 0;
  } catch {
    return true;
  }
}

/** 清空目录内容（保留目录本身）。 */
export function clearDirectory(dir: string, fsImpl: PortableFs = nodeFs): void {
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    fsImpl.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

export interface MigrationReport {
  copied: string[];
  skipped: string[];
  failed: Array<{ entry: string; error: string }>;
}

/**
 * 把数据目录内容复制到新目录（顶层逐项复制，跳过易失缓存）。
 * 逐项 try/catch：单个文件被占用不阻断整体迁移，失败项记入 report。
 */
export function migrateDataDir(
  sourceDir: string,
  targetDir: string,
  options: { fsImpl?: PortableFs; excludes?: readonly string[] } = {},
): MigrationReport {
  const fsImpl = options.fsImpl ?? nodeFs;
  const excludes = new Set(options.excludes ?? MIGRATION_EXCLUDED_ENTRIES);
  const report: MigrationReport = { copied: [], skipped: [], failed: [] };
  fsImpl.mkdirSync(targetDir, { recursive: true });
  for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
    if (excludes.has(entry.name)) {
      report.skipped.push(entry.name);
      continue;
    }
    try {
      fsImpl.cpSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
        recursive: true,
        force: true,
        preserveTimestamps: true,
        errorOnExist: false,
      });
      report.copied.push(entry.name);
    } catch (error) {
      report.failed.push({
        entry: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
