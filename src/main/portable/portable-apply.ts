/**
 * 便携模式：应用数据位置变更的编排（对话框决策 + 迁移/覆盖 + 写指针 + 重启）。
 *
 * 与 Electron 解耦（全部副作用注入），便于单测覆盖取消/覆盖/失败等分支；
 * 真实接线见 portable-ipc.ts（原生对话框 + fs + app.relaunch/quit）。
 */

import * as path from "node:path";
import {
  isSamePath,
  PORTABLE_DEFAULT_DIR_VALUE,
  type DataDirValidation,
  type MigrationReport,
} from "./portable-location";
import type {
  PortableApplyRequest,
  PortableApplyResult,
  PortableDataLocationStatus,
  PortableMigrationChoice,
} from "../../shared/portable-mode";

export type {
  PortableApplyRequest,
  PortableApplyResult,
  PortableMigrationChoice,
} from "../../shared/portable-mode";

export interface PortableApplyDeps {
  getStatus(): PortableDataLocationStatus;
  validateTarget(targetDir: string, currentDataDir: string): DataDirValidation;
  /** 询问是否迁移；取消/仅切换/迁移由实现决定文案与按钮。 */
  confirmMigrate(input: { currentDir: string; targetDir: string }): Promise<PortableMigrationChoice>;
  /** 目标已有数据且选择迁移时询问是否覆盖。 */
  confirmOverwrite(input: { targetDir: string }): Promise<boolean>;
  exists(dir: string): boolean;
  isDirectory(dir: string): boolean;
  hasData(dir: string): boolean;
  ensureDirectory(dir: string): void;
  clearDirectory(dir: string): void;
  migrate(sourceDir: string, targetDir: string): MigrationReport;
  writeConfig(dataDir: string | null): void;
  /** 延迟重启（给 IPC 响应留出到达渲染进程的时间）；测试注入同步执行。 */
  scheduleRelaunch(task: () => void): void;
  relaunch(): void;
  quit(): void;
  logger?: Pick<Console, "warn" | "error">;
}

/** 相对存储值规范化：去掉尾部斜杠，保留相对形式（如 "data2"、"..\\Shared"）。 */
function normalizeRelativeValue(value: string): string {
  const normalized = path.normalize(value);
  const trimmed = normalized.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : value;
}

export async function applyPortableDataLocation(
  request: PortableApplyRequest,
  deps: PortableApplyDeps,
): Promise<PortableApplyResult> {
  const status = deps.getStatus();
  // 相对路径按程序目录解析（指针文件与程序目录同级：程序整体搬移后仍有效）。
  const rawInput = request.enabled ? request.dir.trim() : "";
  const requestedRaw = request.enabled
    ? rawInput
      ? path.resolve(status.installRoot, rawInput)
      : status.suggestedDir
    : status.systemDataDir;

  if (request.enabled && isSamePath(requestedRaw, status.installRoot)) {
    return { status: "error", error: "数据目录不能是程序目录本身，请用程序目录下的子目录（如 data）" };
  }

  const validation = deps.validateTarget(requestedRaw, status.effectiveDataDir);
  if (!validation.ok) {
    return { status: "error", error: validation.error };
  }
  const targetDir = validation.resolved;

  if (isSamePath(targetDir, status.effectiveDataDir)) {
    return { status: "noop", dataDir: targetDir };
  }
  if (deps.exists(targetDir) && !deps.isDirectory(targetDir)) {
    return { status: "error", error: "目标位置已存在同名文件" };
  }

  // native 设置窗已带选择时不重复弹窗；缺省走宿主确认框（旧 Electron 设置页）。
  const choice = request.migrationChoice ?? (await deps.confirmMigrate({
    currentDir: status.effectiveDataDir,
    targetDir,
  }));
  if (choice === "cancel") return { status: "cancelled" };
  const shouldMigrate = choice === "migrate";

  let overwrite = false;
  if (shouldMigrate && deps.hasData(targetDir)) {
    // native 已确认覆盖时（overwrite=true）直接用；缺省宿主弹确认框。
    overwrite = request.overwrite ?? (await deps.confirmOverwrite({ targetDir }));
    if (!overwrite) return { status: "cancelled" };
  }

  let report: MigrationReport | null = null;
  try {
    deps.ensureDirectory(targetDir);
    if (shouldMigrate) {
      if (overwrite) deps.clearDirectory(targetDir);
      report = deps.migrate(status.effectiveDataDir, targetDir);
    }
    // 存储值：默认便携目录固定 "data"；用户输入相对路径时原样存相对值
    //（程序整体搬移后仍有效），绝对输入存绝对路径。
    const storedValue = request.enabled
      ? isSamePath(targetDir, status.suggestedDir)
        ? PORTABLE_DEFAULT_DIR_VALUE
        : rawInput && !path.isAbsolute(rawInput)
          ? normalizeRelativeValue(rawInput)
          : targetDir
      : null;
    deps.writeConfig(storedValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger?.error("[Portable] 应用数据位置失败:", message);
    return { status: "error", error: `应用失败：${message}` };
  }

  if (report && report.failed.length > 0) {
    deps.logger?.warn("[Portable] 部分数据复制失败:", report.failed);
  }

  deps.scheduleRelaunch(() => {
    deps.relaunch();
    deps.quit();
  });
  return {
    status: "applied",
    targetDir,
    migrated: shouldMigrate,
    overwrite,
    failedEntries: report?.failed.map((entry) => entry.entry) ?? [],
    relaunching: true,
  };
}
