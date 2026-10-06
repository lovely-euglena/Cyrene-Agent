/**
 * 云端昔涟 PWA · 事件重放与物化视图（IKJK2L）。
 *
 * 重放核心（replaySession / BranchMessage）已抽取到 src/main/sync/materializer.ts
 * 供桌面合并读模型与 PWA 共享（IKJK2I §5.1，语义与 cloud-server DialogLoop.Replay
 * 逐条对齐）；本文件保留 PWA 导出形状，并承载 PWA 专有的轮次分组与会话摘要。
 */
import {
  SYNC_MEMORY_SESSION_ID,
  SYNC_MOOD_SESSION_ID,
  type SyncEventV0,
} from "../../main/sync/sync-protocol";
import { replaySession } from "../../main/sync/materializer";
import type { BranchMessage } from "../../main/sync/materializer";

export { replaySession };
export type { BranchMessage };

export interface Turn {
  turnId: string;
  user: BranchMessage;
  assistants: BranchMessage[];
}

/** 扁平分支消息 → 轮次视图（user 开轮；紧随的 assistant 挂当前轮）。 */
export function groupTurns(messages: readonly BranchMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { turnId: message.turnId, user: message, assistants: [] };
      turns.push(current);
    } else if (current) {
      current.assistants.push(message);
    }
    // 孤立 assistant（无 user 的异常数据）不渲染：服务端生成只会挂在 user 之后
  }
  return turns;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string | null;
  lastTs: string | null;
  preview: string;
  messageCount: number;
}

/**
 * 全部事件 → 会话摘要列表（按最近活动倒序；标题取最后一个非空 session.create）。
 * 保留命名空间（__memory__ / __mood__）只承载记忆/心情事件，不是真实会话：
 * 跳过其分组，避免会话列表出现空预览伪会话（IKJK2O P2-5）。
 */
export function summarizeSessions(events: readonly SyncEventV0[]): SessionSummary[] {
  const bySession = new Map<string, SyncEventV0[]>();
  for (const event of events) {
    if (event.sessionId === SYNC_MEMORY_SESSION_ID || event.sessionId === SYNC_MOOD_SESSION_ID) continue;
    const list = bySession.get(event.sessionId);
    if (list) list.push(event);
    else bySession.set(event.sessionId, [event]);
  }
  const summaries: SessionSummary[] = [];
  for (const [sessionId, sessionEvents] of bySession) {
    let title = "";
    let createdAt: string | null = null;
    for (const event of sessionEvents) {
      if (event.type !== "session.create") continue;
      const payload = event.payload as { title?: unknown; createdAt?: unknown };
      if (typeof payload.title === "string" && payload.title.trim().length > 0) title = payload.title;
      if (createdAt === null && typeof payload.createdAt === "string") createdAt = payload.createdAt;
    }
    const messages = replaySession(sessionEvents);
    const last = messages[messages.length - 1];
    summaries.push({
      sessionId,
      title: title || `会话 ${sessionId.slice(0, 8)}`,
      createdAt,
      lastTs: last?.ts ?? createdAt,
      preview: last?.text ?? "",
      messageCount: messages.length,
    });
  }
  summaries.sort(
    (a, b) =>
      (b.lastTs ?? "").localeCompare(a.lastTs ?? "") ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return summaries;
}
