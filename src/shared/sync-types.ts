/**
 * 云端同步（IKJK2I）共享类型：主进程 IPC ↔ preload ↔ 设置页。
 *
 * 冻结口径（设计稿 docs/design/2026-10-06-desktop-cloud-wiring.md §6 / 附录 A）：
 * - 配置对外快照永不携带 token（仅 hasToken 布尔）；
 * - 动作类 IPC 统一返回 SyncOpResult<T>（错误带稳定 code，便于 UI 分支）。
 */

export interface SyncConfigPublic {
  enabled: boolean;
  baseUrl: string;
  deviceName: string;
  hasToken: boolean;
  /** 协议身份（desk-*；本地生成，与服务器 deviceId 解耦）。 */
  deviceId: string | null;
  /** 服务器签发设备（dev_*；配对后可得）。 */
  serverDeviceId: string | null;
}

export interface SyncSaveConfigInput {
  enabled?: boolean;
  baseUrl?: string;
  deviceName?: string;
  /** 明文 token（保存时加密落盘）；缺省表示不修改；clearToken 优先。 */
  token?: string;
  clearToken?: boolean;
}

export interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  hasToken: boolean;
  deviceId: string | null;
  serverDeviceId: string | null;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: { code: string; message: string } | null;
  /** 待推送事件数（outbox 中尚未成功 push 的部分）。 */
  pendingCount: number;
  /** 服务器 fetch 游标（字符串；null = 尚未初次拉取）。 */
  cursor: string | null;
  localEventCount: number;
  remoteEventCount: number;
}

export interface SyncPairInput {
  baseUrl?: string;
  code: string;
  deviceName?: string;
}

export interface SyncPairCodeResult {
  code: string;
  /** ISO 时间（已归一化为毫秒精度）。 */
  expiresAt: string;
}

export type SyncOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
