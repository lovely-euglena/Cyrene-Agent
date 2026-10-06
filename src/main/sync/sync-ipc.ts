/**
 * 云端同步 · IPC 桥（IKJK2I B 簇）。
 *
 * 契约：docs/design/2026-10-06-desktop-cloud-wiring.md §6（通道常量见 shared/ipc-channels.ts）。
 * - 读取类（SYNC_GET_CONFIG / SYNC_GET_STATUS）直接返回数据；
 * - 动作类（SYNC_SAVE_CONFIG / SYNC_NOW / SYNC_PAIR / SYNC_PAIR_CODE / SYNC_UNPAIR）统一返回
 *   SyncOpResult<T>（错误带稳定 code）；
 * - 配置 / 配对 / 解除配对成功后、手动同步（SYNC_NOW）终态向所有窗口广播 SYNC_CHANGED
 *   （参照 channels broadcastChannelsStatus；后台 60s 轮次不广播）。
 */

import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { SyncConfigPublic, SyncOpResult, SyncPairInput, SyncSaveConfigInput } from "../../shared/sync-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { SyncHttpError } from "./http-client";
import type { SyncService } from "./sync-service";

/** 设置端口：读取类通道的公开配置来源（组合根注入 service.getConfig；测试可注入假快照）。 */
export interface SyncIpcSettingsPort {
  getPublicConfig(): Promise<SyncConfigPublic>;
}

function opError(error: unknown): SyncOpResult<never> {
  if (error instanceof SyncHttpError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "internal", message: message.slice(0, 300) } };
}

/** baseUrl 长度上限（渲染层输入不可信，主进程校验）。 */
const SYNC_BASE_URL_MAX_LENGTH = 2048;

/**
 * 校验渲染层传入的 baseUrl：空串允许（用于清除地址）；非空必须是 http(s) 且长度受限。
 * 非法输入抛 invalid_config（handler 统一映射为 SyncOpResult）。
 */
function normalizeBaseUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > SYNC_BASE_URL_MAX_LENGTH) {
    throw new SyncHttpError("invalid_config", 0, undefined, "服务器地址过长");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SyncHttpError("invalid_config", 0, undefined, "服务器地址不是合法的 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SyncHttpError("invalid_config", 0, undefined, "服务器地址必须以 http:// 或 https:// 开头");
  }
  return trimmed;
}

function normalizeSaveInput(input: unknown): SyncSaveConfigInput {
  const record = (input ?? {}) as Record<string, unknown>;
  const out: SyncSaveConfigInput = {};
  if (typeof record.enabled === "boolean") out.enabled = record.enabled;
  if (typeof record.baseUrl === "string") out.baseUrl = normalizeBaseUrlInput(record.baseUrl);
  if (typeof record.deviceName === "string") out.deviceName = record.deviceName;
  if (typeof record.token === "string") out.token = record.token;
  if (record.clearToken === true) out.clearToken = true;
  return out;
}

/** 配对输入同样走 baseUrl 校验（首次填地址主路径；空值允许，由 service 回退当前配置）。 */
function normalizePairInput(input: unknown): SyncPairInput | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  if (!code.trim()) return null;
  return {
    code,
    ...(typeof record.baseUrl === "string" ? { baseUrl: normalizeBaseUrlInput(record.baseUrl) } : {}),
    ...(typeof record.deviceName === "string" ? { deviceName: record.deviceName } : {}),
  };
}

/** 向所有存活窗口广播同步配置变更（窗口可能正在关闭，逐窗容错）。 */
export function broadcastSyncChanged(payload?: SyncConfigPublic): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.SYNC_CHANGED, payload);
    } catch {
      // 窗口可能正在关闭，忽略
    }
  }
}

export function registerSyncIpc(
  scope: IpcScope | undefined,
  service: SyncService,
  settings: SyncIpcSettingsPort,
): void {
  const ipc = scope ?? createIpcScope();

  // ── 读取类：直接返回数据（不包 SyncOpResult）────────────────────────────
  ipc.handle(IPC.SYNC_GET_CONFIG, () => settings.getPublicConfig());
  ipc.handle(IPC.SYNC_GET_STATUS, () => service.getStatus());

  // ── 动作类：统一 SyncOpResult<T> ─────────────────────────────────────────
  ipc.handle(IPC.SYNC_SAVE_CONFIG, async (_event, input: unknown): Promise<SyncOpResult<SyncConfigPublic>> => {
    try {
      const data = await service.saveConfig(normalizeSaveInput(input));
      broadcastSyncChanged(data);
      return { ok: true, data };
    } catch (error) {
      return opError(error);
    }
  });

  ipc.handle(IPC.SYNC_NOW, async (): Promise<SyncOpResult<Awaited<ReturnType<SyncService["getStatus"]>>>> => {
    try {
      const result = await service.syncNow();
      if (!result.ok) return { ok: false, error: result.error ?? { code: "http", message: "同步失败" } };
      return { ok: true, data: await service.getStatus() };
    } catch (error) {
      return opError(error);
    } finally {
      // 手动同步终态（成功 / 失败 / 异常）广播一次，面板据此刷新状态与 lastError；后台轮次不广播
      broadcastSyncChanged();
    }
  });

  ipc.handle(IPC.SYNC_PAIR, async (_event, input: unknown): Promise<SyncOpResult<SyncConfigPublic>> => {
    try {
      // 校验（含 baseUrl）移入 try：非法地址统一映射为 SyncOpResult.invalid_config
      const pairInput = normalizePairInput(input);
      if (!pairInput) return { ok: false, error: { code: "invalid_config", message: "缺少配对码" } };
      const data = await service.pair(pairInput);
      broadcastSyncChanged(data);
      return { ok: true, data };
    } catch (error) {
      return opError(error);
    }
  });

  ipc.handle(IPC.SYNC_PAIR_CODE, async (): Promise<SyncOpResult<Awaited<ReturnType<SyncService["createPairCode"]>>>> => {
    try {
      return { ok: true, data: await service.createPairCode() };
    } catch (error) {
      return opError(error);
    }
  });

  ipc.handle(IPC.SYNC_UNPAIR, async (): Promise<SyncOpResult<SyncConfigPublic>> => {
    try {
      const data = await service.unpair();
      broadcastSyncChanged(data);
      return { ok: true, data };
    } catch (error) {
      return opError(error);
    }
  });
}
