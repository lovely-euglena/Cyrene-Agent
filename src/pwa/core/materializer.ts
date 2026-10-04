/**
 * 云端昔涟 PWA · 事件重放与物化视图（IKJK2L）。
 *
 * 重放语义与 cloud-server DialogLoop.Replay 逐条对齐
 * （契约：docs/specs/2026-10-04-sync-protocol-v0.md §2.2–2.4）：
 * - message.append：按规范序追加；role=user 且 turnId 非空时记录锚点；
 * - turn_rewind keep_user：保留锚点 user、裁掉其后全部（重生成，锚点指向 rewind 事件）；
 * - turn_rewind replace_user：锚点 user 换为 replacementUser（revision+1），其后全部裁掉；
 * - tombstone：移除目标轮（user + 紧随的 assistant 段）；
 * - session.create：只进元数据（标题/创建时间），不进消息流。
 *
 * 手机端因此渲染的活动分支与桌面/服务端生成所用分支一致。
 */
import type { SyncEventV0 } from "../../main/sync/sync-protocol";

export interface BranchMessage {
  role: "user" | "assistant";
  text: string;
  /** user 必填；assistant 可空串（无 turnId 的旧事件）。 */
  turnId: string;
  eventId: string;
  ts: string;
}

/** 重放单会话事件（输入须为规范序）→ 活动分支消息流。 */
export function replaySession(events: readonly SyncEventV0[]): BranchMessage[] {
  const messages: BranchMessage[] = [];
  const turnIndex = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "message.append": {
        const payload = event.payload as { role?: unknown; text?: unknown; turnId?: unknown };
        const role = payload.role === "assistant" ? "assistant" : "user";
        const text = typeof payload.text === "string" ? payload.text : "";
        const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
        if (role === "user" && turnId.length > 0) {
          turnIndex.set(turnId, messages.length);
        }
        messages.push({ role, text, turnId, eventId: event.eventId, ts: event.ts });
        break;
      }
      case "turn_rewind": {
        const payload = event.payload as {
          anchorUserTurnId?: unknown;
          disposition?: unknown;
          replacementUser?: { text?: unknown };
        };
        const anchor = typeof payload.anchorUserTurnId === "string" ? payload.anchorUserTurnId : "";
        const index = turnIndex.get(anchor);
        if (index === undefined) break;
        if (payload.disposition === "keep_user") {
          messages.splice(index + 1);
          messages[index] = { ...messages[index], eventId: event.eventId, ts: event.ts };
        } else {
          messages.splice(index);
          const replacement = typeof payload.replacementUser?.text === "string" ? payload.replacementUser.text : "";
          messages.push({ role: "user", text: replacement, turnId: anchor, eventId: event.eventId, ts: event.ts });
        }
        reindex(messages, turnIndex);
        break;
      }
      case "tombstone": {
        const payload = event.payload as { targetUserTurnId?: unknown };
        const target = typeof payload.targetUserTurnId === "string" ? payload.targetUserTurnId : "";
        const index = turnIndex.get(target);
        if (index === undefined) break;
        let end = index + 1;
        while (end < messages.length && messages[end].role === "assistant") {
          end++;
        }
        messages.splice(index, end - index);
        reindex(messages, turnIndex);
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

function reindex(messages: readonly BranchMessage[], turnIndex: Map<string, number>): void {
  turnIndex.clear();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "user" && message.turnId.length > 0) {
      turnIndex.set(message.turnId, i);
    }
  }
}

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

/** 全部事件 → 会话摘要列表（按最近活动倒序；标题取最后一个非空 session.create）。 */
export function summarizeSessions(events: readonly SyncEventV0[]): SessionSummary[] {
  const bySession = new Map<string, SyncEventV0[]>();
  for (const event of events) {
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
