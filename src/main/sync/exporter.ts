/**
 * 云端同步 · 事件导出器（IKJK2I）。
 *
 * 契约（设计稿 §2 / 附录 A）：全量会话迁移驱动（幂等）→ journal audit → v0 事件
 * （4 类映射 + presentation 随行 + 时钟分配 + session.create 标题修订），追加 outbox；
 * state 由调用方在成功后持久化。崩溃重入由 eventId 去重兜底。
 */

import type { ChatSessionMeta } from "../../shared/chat-types";
import type {
  TranscriptEntry,
  TranscriptPresentationPatch,
} from "../orchestrator/conversation-transcript-types";
import { contentToText, mergePresentationPatch } from "../orchestrator/conversation-transcript-projection";
import type { SyncEventStore } from "./event-store";
import { SYNC_PRESENTATION_PATCH_KEYS, type SyncEventTypeV0, type SyncEventV0 } from "./sync-protocol";
import type { SyncConversationState, SyncState } from "./sync-state";

export interface SyncExporterDeps {
  userDataPath: string;
  state: SyncState;
  store: SyncEventStore;
  listSessions(): Promise<ChatSessionMeta[]>;
  ensureMigrated(sessionId: string): Promise<void>;
  readAuditEntries(sessionId: string): Promise<TranscriptEntry[]>;
}

export interface SyncExporter {
  /**
   * 迁移驱动 + 导出未导出事件（追加 outbox、更新 state 对象）；调用方随后持久化 state。
   * `exported` = 本轮新增事件数；`sessions` = 本轮有新事件的会话数。
   */
  exportPending(): Promise<{ exported: number; sessions: number }>;
}

/** 单个 messageId 的 presentation 合并快照（patchRevision 大者新，同级取 seq 大者）。 */
interface PresentationSnapshot {
  patchRevision: number;
  seq: number;
  patch: TranscriptPresentationPatch;
}

export function createSyncExporter(deps: SyncExporterDeps): SyncExporter {
  return {
    async exportPending(): Promise<{ exported: number; sessions: number }> {
      const { state, store } = deps;
      // 会话按 createdAt 升序（并列按 id 序），保证多会话首次导出顺序确定。
      const sessions = [...(await deps.listSessions())].sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );

      // 崩溃重入：事件 append 成功但 state 尚未持久化时，outbox 水位高于 state。
      // 时钟下限取 outbox 高水位，保证新事件 lamport / seq 严格大于已落盘事件
      //（服务端按 (session, device) 校验 seq 严格递增）。
      let lamport = state.lamport;
      let seq = state.seq;
      for (const event of store.getLocalEvents()) {
        if (event.lamport > lamport) lamport = event.lamport;
        if (event.seq > seq) seq = event.seq;
      }

      const localIds = store.getLocalEventIds();
      const newEvents: SyncEventV0[] = [];
      const conversationUpdates = new Map<string, SyncConversationState>();
      let exportedSessions = 0;

      /** 分配时钟并暂存事件；eventId 已在 outbox 则跳过（不重分配时钟）。 */
      const allocate = (
        sessionId: string,
        eventId: string,
        type: SyncEventTypeV0,
        ts: string,
        payload: Record<string, unknown>,
      ): boolean => {
        if (localIds.has(eventId)) return false;
        lamport += 1;
        seq += 1;
        localIds.add(eventId);
        newEvents.push({ eventId, sessionId, type, lamport, deviceId: state.deviceId, seq, ts, payload });
        return true;
      };

      for (const session of sessions) {
        // 存量迁移驱动：每个会话先确保 v1 → v2 迁移完成，再读全量 audit（含归档段）。
        await deps.ensureMigrated(session.id);
        const entries = [...(await deps.readAuditEntries(session.id))].sort(
          (left, right) => left.seq - right.seq,
        );
        const previous = state.conversations[session.id];
        const watermark = previous?.exportedThroughSeq ?? 0;
        const title = truncateTitle(session.title ?? "");
        let titleRevision = previous?.titleRevision ?? 0;
        let lastTitle = previous?.lastTitle ?? "";
        let hasNewEvents = false;

        // session.create：首次（含空标题）或标题变更时发新修订，先于该会话消息事件。
        if (!previous || title !== previous.lastTitle) {
          titleRevision += 1;
          lastTitle = title;
          if (allocate(
            session.id,
            `screate:${session.id}:r${titleRevision}`,
            "session.create",
            isoTime(session.createdAt),
            { title, createdAt: isoTime(session.createdAt) },
          )) {
            hasNewEvents = true;
          }
        }

        const presentations = collectPresentations(entries);

        for (const entry of entries) {
          if (entry.seq <= watermark) continue; // 快路径：水位内条目无需再映射
          const ts = isoTime(entry.at);
          switch (entry.kind) {
            case "user": {
              if (!entry.turnId) break; // 防御：user 必带 turnId（rewind 锚点）
              if (allocate(session.id, entry.id, "message.append", ts, {
                role: "user",
                text: entry.payload.text,
                turnId: entry.turnId,
              })) hasNewEvents = true;
              break;
            }
            case "assistant": {
              if (entry.payload.visibility === "internal") break; // 内部消息不上云
              const text = contentToText(entry.payload.content);
              if (text.length === 0) break; // 空文本不产生空气泡
              // presentation 按别名查找：UI 消息 id 为 turnId ?? entry.id（设计 §2.2），
              // 但渠道等写入路径以 assistant entry id 键控补丁（dispatcher getLastAssistantEntryId）。
              const presentation = lookupPresentation(presentations, entry.id, entry.turnId);
              const patch = presentation ? filterPresentationPatch(presentation.patch) : undefined;
              if (allocate(session.id, entry.id, "message.append", ts, {
                role: "assistant",
                text,
                ...(entry.turnId ? { turnId: entry.turnId } : {}),
                ...(presentation && patch
                  ? { presentation: { patchRevision: presentation.patchRevision, patch } }
                  : {}),
              })) hasNewEvents = true;
              break;
            }
            case "turn_rewind": {
              const payload: Record<string, unknown> = {
                anchorUserTurnId: entry.payload.anchorUserTurnId,
                disposition: entry.payload.disposition,
                reason: entry.payload.reason,
              };
              if (entry.payload.disposition === "replace_user") {
                // 防御：协议要求 replacementUser 与 revision 必填（CTA 写入路径已保证）。
                if (!entry.payload.replacementUser || !entry.revision) break;
                payload.replacementUser = { text: entry.payload.replacementUser.text };
                payload.revision = entry.revision;
              }
              if (allocate(session.id, entry.id, "turn_rewind", ts, payload)) hasNewEvents = true;
              break;
            }
            case "turn_tombstone": {
              if (allocate(session.id, entry.id, "tombstone", ts, {
                targetUserTurnId: entry.payload.targetUserTurnId,
                reason: entry.payload.reason,
              })) hasNewEvents = true;
              break;
            }
            default:
              // compaction_checkpoint / tool_result / tool_started / task_state /
              // effect_resolution / interruption / backfill_boundary / presentation_patch /
              // delivery_receipt：不同步（设计 §2.1 映射表）。
              break;
          }
        }

        // 水位推进到该会话 audit 最大 seq（含本轮被 eventId 去重跳过的条目）。
        const finalConversation: SyncConversationState = {
          exportedThroughSeq: Math.max(watermark, entries.at(-1)?.seq ?? 0),
          titleRevision,
          lastTitle,
        };
        if (!previous ||
          previous.exportedThroughSeq !== finalConversation.exportedThroughSeq ||
          previous.titleRevision !== finalConversation.titleRevision ||
          previous.lastTitle !== finalConversation.lastTitle) {
          conversationUpdates.set(session.id, finalConversation);
        }
        if (hasNewEvents) exportedSessions += 1;
      }

      // 持久化顺序：事件先 append+fsync，成功后才更新 state 对象（调用方随后落盘）。
      if (newEvents.length > 0) await store.appendLocal(newEvents);
      state.lamport = lamport;
      state.seq = seq;
      for (const [sessionId, conversation] of conversationUpdates) {
        state.conversations[sessionId] = conversation;
      }
      return { exported: newEvents.length, sessions: exportedSessions };
    },
  };
}

/** 逐 messageId 合并 presentation patch（对齐投影层语义：revision 大者新，同级取 seq 大者）。 */
function collectPresentations(entries: TranscriptEntry[]): Map<string, PresentationSnapshot> {
  const presentations = new Map<string, PresentationSnapshot>();
  for (const entry of entries) {
    if (entry.kind !== "presentation_patch") continue;
    const current = presentations.get(entry.payload.messageId);
    if (current && (entry.payload.patchRevision < current.patchRevision ||
      (entry.payload.patchRevision === current.patchRevision && entry.seq <= current.seq))) {
      continue;
    }
    presentations.set(entry.payload.messageId, {
      patchRevision: entry.payload.patchRevision,
      seq: entry.seq,
      patch: mergePresentationPatch(current?.patch, entry.payload.patch),
    });
  }
  return presentations;
}

/**
 * 按别名查找 presentation 快照：assistant 的 UI 消息 id 为 `turnId ?? entry.id`，
 * 而渠道等写入路径以 entry id 键控补丁（dispatcher 的 getLastAssistantEntryId）。
 * 两个别名都查；命中多处时跨键按 (patchRevision, seq) 取新者为基准、旧者并入，
 * 重叠字段以新者为准。
 *
 * 与投影层的口径差异（conversation-transcript-projection.ts:782-801 逐 messageId
 * 键独立合并、915-918 经 byAlias 按插入序依次 applyPatch）：投影对两个键各自合并后
 * 再按插入序应用，重叠字段以后应用者为准；exporter 为单次快照合并，始终取
 * (patchRevision, seq) 新者。仅当「两键字段重叠且低 (rev,seq) 键在投影中更晚应用」
 * 时两者结果不同；当前无调用方同时写两键，属防御性分支。
 */
function lookupPresentation(
  presentations: Map<string, PresentationSnapshot>,
  entryId: string,
  turnId: string | undefined,
): PresentationSnapshot | undefined {
  const byEntryId = presentations.get(entryId);
  const byTurnId = turnId ? presentations.get(turnId) : undefined;
  if (!byEntryId) return byTurnId;
  if (!byTurnId || byEntryId === byTurnId) return byEntryId;
  const entryIsNewer = byEntryId.patchRevision > byTurnId.patchRevision ||
    (byEntryId.patchRevision === byTurnId.patchRevision && byEntryId.seq >= byTurnId.seq);
  const newer = entryIsNewer ? byEntryId : byTurnId;
  const older = entryIsNewer ? byTurnId : byEntryId;
  return {
    patchRevision: newer.patchRevision,
    seq: newer.seq,
    patch: mergePresentationPatch(older.patch, newer.patch),
  };
}

/** 协议白名单过滤（设计 §2.2）：仅保留 SYNC_PRESENTATION_PATCH_KEYS 键；空则整体省略。 */
function filterPresentationPatch(patch: TranscriptPresentationPatch): TranscriptPresentationPatch | undefined {
  const allowed = new Set<string>(SYNC_PRESENTATION_PATCH_KEYS);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.has(key)) filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered as TranscriptPresentationPatch : undefined;
}

/** 协议上限 200（UTF-16 码元）。 */
function truncateTitle(title: string): string {
  return title.length > 200 ? title.slice(0, 200) : title;
}

/** ISO 8601 UTC 毫秒精度（协议 ts 形态）；非法时间戳退回当前时刻。 */
function isoTime(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}
