/**
 * 云端同步 · 事件导出器（IKJK2I）。
 *
 * 契约（设计稿 §2 / 附录 A）：全量会话迁移驱动（幂等）→ journal audit → v0 事件
 * （4 类映射 + presentation 随行 + 时钟分配 + session.create 标题修订），追加 outbox；
 * state 由调用方在成功后持久化。崩溃重入由 eventId 去重兜底。
 * 本文件为接口冻结占位：签名不变，实现体由 A 簇落地。
 */

import type { ChatSessionMeta } from "../../shared/chat-types";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import type { SyncEventStore } from "./event-store";
import type { SyncState } from "./sync-state";

export interface SyncExporterDeps {
  userDataPath: string;
  state: SyncState;
  store: SyncEventStore;
  listSessions(): Promise<ChatSessionMeta[]>;
  ensureMigrated(sessionId: string): Promise<void>;
  readAuditEntries(sessionId: string): Promise<TranscriptEntry[]>;
}

export interface SyncExporter {
  /** 迁移驱动 + 导出未导出事件（追加 outbox、更新 state 对象）；调用方随后持久化 state。 */
  exportPending(): Promise<{ exported: number; sessions: number }>;
}

export function createSyncExporter(deps: SyncExporterDeps): SyncExporter {
  void deps;
  throw new Error("IKJK2I: exporter 实现见 A 簇（接口冻结占位）");
}
