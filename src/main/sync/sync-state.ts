/**
 * 云端同步 · 状态（IKJK2I）。
 *
 * 契约（设计稿附录 A）：{schemaVersion:1, deviceId, lamport, seq, fetchCursor, pushedCount,
 * serverDeviceId, conversations, updatedAt}；load 对缺失 / 损坏做恢复，save 原子写（tmp+rename）。
 * 本文件为接口冻结占位：签名不变，实现体由 A 簇落地。
 */

export interface SyncConversationState {
  /** 已导出到 outbox 的最大 CTA entry seq（快路径水位）。 */
  exportedThroughSeq: number;
  /** session.create 标题修订号（0 = 尚未发出）。 */
  titleRevision: number;
  /** 上次导出的标题（用于检测变更）。 */
  lastTitle: string;
}

export interface SyncState {
  schemaVersion: 1;
  /** 协议身份（desk-*；本地生成，与服务器 deviceId 解耦）。 */
  deviceId: string;
  /** 全局 lamport 水位（已分配 / 已见的最大值）。 */
  lamport: number;
  /** 本机事件全局单调 seq 计数器。 */
  seq: number;
  /** 服务器 fetch 游标（字符串；null = 尚未初次拉取）。 */
  fetchCursor: string | null;
  /** events-local.jsonl 中已成功推送的事件数。 */
  pushedCount: number;
  /** 服务器签发设备（dev_*；配对后可得）。 */
  serverDeviceId: string | null;
  conversations: Record<string, SyncConversationState>;
  updatedAt: string;
}

export function createSyncState(): SyncState {
  throw new Error("IKJK2I: sync-state 实现见 A 簇（接口冻结占位）");
}

export async function loadSyncState(syncDir: string): Promise<SyncState> {
  void syncDir;
  throw new Error("IKJK2I: sync-state 实现见 A 簇（接口冻结占位）");
}

export async function saveSyncState(syncDir: string, state: SyncState): Promise<void> {
  void syncDir;
  void state;
  throw new Error("IKJK2I: sync-state 实现见 A 簇（接口冻结占位）");
}
