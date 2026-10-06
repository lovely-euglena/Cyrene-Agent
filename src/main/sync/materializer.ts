/**
 * 云端同步 · 协议事件重放共享核心（IKJK2I）。
 *
 * 重放语义与 cloud-server DialogLoop.Replay 逐条对齐
 * （契约：docs/specs/2026-10-04-sync-protocol-v0.md §2.2–2.4）：
 * - message.append：按规范序追加；role=user 且 turnId 非空时记录锚点；
 * - turn_rewind keep_user：保留锚点 user、裁掉其后全部（重生成，锚点指向 rewind 事件）；
 * - turn_rewind replace_user：锚点 user 换为 replacementUser（revision+1），其后全部裁掉；
 * - tombstone：移除目标轮（user + 紧随的 assistant 段）；
 * - session.create：只进元数据（标题/创建时间），不进消息流。
 *
 * 桌面合并读模型（read-model）与 PWA 手机端渲染共用本核心，避免两端语义漂移。
 * 输入假定已去重 + 规范序（readSyncBatch / 同步服务保证）；未知锚点 no-op。
 */
import type { SyncEventV0 } from "./sync-protocol";

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
