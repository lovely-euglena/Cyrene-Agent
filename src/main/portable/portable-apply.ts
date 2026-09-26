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

export async function applyPortableDataLocation(
  request: PortableApplyRequest,
  deps: PortableApplyDeps,
): Promise<PortableApplyResult> {
  const status = deps.getStatus();
  const requestedRaw = request.enabled
    ? request.dir.trim()
      ? path.resolve(request.dir.trim())
      : status.suggestedDir
    : status.systemDataDir;

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

  const choice = await deps.confirmMigrate({
    currentDir: status.effectiveDataDir,
    targetDir,
  });
  if (choice === "cancel") return { status: "cancelled" };
  const shouldMigrate = choice === "migrate";

  let overwrite = false;
  if (shouldMigrate && deps.hasData(targetDir)) {
    overwrite = await deps.confirmOverwrite({ targetDir });
    if (!overwrite) return { status: "cancelled" };
  }

  let report: MigrationReport | null = null;
  try {
    deps.ensureDirectory(targetDir);
    if (shouldMigrate) {
      if (overwrite) deps.clearDirectory(targetDir);
      report = deps.migrate(status.effectiveDataDir, targetDir);
    }
    // 默认便携目录存相对值（"data"）：程序整体搬移后指针仍然有效。
    const storedValue = request.enabled
      ? isSamePath(targetDir, status.suggestedDir)
        ? PORTABLE_DEFAULT_DIR_VALUE
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
