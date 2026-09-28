// 记忆动作层：memory IPC（渲染页「记忆」面板）与 native 设置窗（WPF「记忆」
// section）共用同一实现，避免两侧字段白名单/对话框流程漂移。
//
// 覆盖：L0/L1 编辑保存、导入文档删除、Obsidian Vault 绑定/解绑/导出/同步。

import { dialog } from "electron";
import { deleteImportedDoc } from "../rag";
import { memoryStore } from "./memory-store";
import { exportMemoryToObsidianVault, syncToBoundVault } from "./obsidian-exporter";
import { loadObsidianVaultConfig, saveObsidianVaultConfig, unbindVault, type ObsidianVaultConfig } from "./obsidian-vault-config";
import { startVaultWatcher, stopVaultWatcher } from "./obsidian-importer";

export const MEMORY_L0_EDITABLE_KEYS = [
  "preferredName",
  "occupation",
  "longTermInterests",
  "language",
  "permanentNote",
] as const;

export const MEMORY_L1_EDITABLE_KEYS = [
  "recentGoals",
  "recentPreferences",
  "currentProject",
] as const;

export type MemoryL0Patch = Partial<Record<(typeof MEMORY_L0_EDITABLE_KEYS)[number], string>>;
export type MemoryL1Patch = Partial<Record<(typeof MEMORY_L1_EDITABLE_KEYS)[number], string>>;

export interface MemorySaveResult {
  ok: boolean;
  saved?: Record<string, string>;
  error?: string;
}

export interface VaultSyncResult {
  ok: boolean;
  fileCount?: number;
  error?: string;
}

export interface VaultBindResult extends VaultSyncResult {
  canceled?: boolean;
  vaultPath?: string;
}

export interface VaultExportResult {
  ok: boolean;
  canceled?: boolean;
  fileCount?: number;
  error?: string;
}

/** 只保留白名单字段的字符串值并 trim（两侧共用同一口径）。 */
function sanitizePatch<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const patch: Partial<Record<K, string>> = {};
  if (!raw || typeof raw !== "object") return patch;
  const input = raw as Record<string, unknown>;
  for (const key of keys) {
    if (typeof input[key] === "string") {
      patch[key] = (input[key] as string).trim();
    }
  }
  return patch;
}

export function sanitizeMemoryL0Patch(raw: unknown): MemoryL0Patch {
  return sanitizePatch(raw, MEMORY_L0_EDITABLE_KEYS);
}

export function sanitizeMemoryL1Patch(raw: unknown): MemoryL1Patch {
  return sanitizePatch(raw, MEMORY_L1_EDITABLE_KEYS);
}

/** 保存 L0（白名单字段）；空 patch 不写盘。 */
export async function saveMemoryL0(raw: unknown): Promise<MemorySaveResult> {
  try {
    const patch = sanitizeMemoryL0Patch(raw);
    if (Object.keys(patch).length > 0) await memoryStore.updateL0(patch);
    return { ok: true, saved: patch as Record<string, string> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 保存 L1（白名单字段）；空 patch 不写盘。 */
export async function saveMemoryL1(raw: unknown): Promise<MemorySaveResult> {
  try {
    const patch = sanitizeMemoryL1Patch(raw);
    if (Object.keys(patch).length > 0) await memoryStore.updateL1(patch);
    return { ok: true, saved: patch as Record<string, string> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 删除一条导入文档（importId 优先，旧数据用 fileName）；返回删除条数。 */
export function removeImportedDocEntry(importId: string, fileName?: string): number {
  return deleteImportedDoc(importId, fileName);
}

/** 弹目录选择框并一次性导出（不绑定）。 */
export async function exportMemoryVault(): Promise<VaultExportResult> {
  const result = await dialog.showOpenDialog({
    title: "选择 Obsidian Vault 导出位置",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  return exportMemoryToObsidianVault(result.filePaths[0]);
}

/** 弹目录选择框绑定 vault：保存路径 → 立即同步一次 → 启动回流监听。 */
export async function bindMemoryVault(): Promise<VaultBindResult> {
  const result = await dialog.showOpenDialog({
    title: "选择要绑定的 Obsidian Vault 文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  const vaultPath = result.filePaths[0];
  saveObsidianVaultConfig({ vaultPath });
  const syncResult = await syncToBoundVault();
  startVaultWatcher(vaultPath);
  return { ok: syncResult.ok, vaultPath, fileCount: syncResult.fileCount, error: syncResult.error };
}

/** 解绑：先停监听再清配置。 */
export function unbindMemoryVault(): void {
  stopVaultWatcher();
  unbindVault();
}

export function getMemoryVaultConfig(): ObsidianVaultConfig {
  return loadObsidianVaultConfig();
}

export function setMemoryVaultAutoSync(autoSync: boolean): ObsidianVaultConfig {
  return saveObsidianVaultConfig({ autoSync: Boolean(autoSync) });
}

export async function syncMemoryVaultNow(): Promise<VaultSyncResult> {
  return syncToBoundVault();
}