/**
 * 服务端重放（IKJN79）：协议 v0 事件流 → 活动分支消息流。
 *
 * 与 .NET DialogLoop.Replay / TrimContext 逐条对齐：
 * - message.append：user 带 turnId 建立锚点索引；assistant 追加；
 * - turn_rewind keep_user：裁掉锚点之后全部（重生成），锚点事件改为回退事件；
 * - turn_rewind replace_user：连锚点一起替换为 replacementUser（编辑），其后全部裁掉；
 * - tombstone：移除目标轮及其后连续 assistant；
 * - 任何裁剪后重建锚点索引（Reindex）。
 */
import type { SyncEventV0 } from "../../../src/main/sync/sync-protocol";
import { isRecord } from "./util";

export interface BranchMessage {
  role: "user" | "assistant";
  text: string;
  turnId: string;
  anchorEventId: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export function replayBranch(events: SyncEventV0[]): BranchMessage[] {
  const messages: BranchMessage[] = [];
  const turnIndex = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "message.append": {
        const payload = event.payload;
        const role = payload.role as "user" | "assistant";
        const text = payload.text as string;
        const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
        if (role === "user" && turnId.length > 0) turnIndex.set(turnId, messages.length);
        messages.push({ role, text, turnId, anchorEventId: event.eventId });
        break;
      }
      case "turn_rewind": {
        const payload = event.payload;
        const anchor = payload.anchorUserTurnId as string;
        const disposition = payload.disposition as string;
        const index = turnIndex.get(anchor);
        if (index === undefined) break;
        if (disposition === "keep_user") {
          messages.splice(index + 1);
          messages[index] = { ...messages[index], anchorEventId: event.eventId };
        } else {
          messages.splice(index);
          const replacement = payload.replacementUser;
          const text = isRecord(replacement) ? (replacement.text as string) : "";
          messages.push({ role: "user", text, turnId: anchor, anchorEventId: event.eventId });
        }
        reindex(messages, turnIndex);
        break;
      }
      case "tombstone": {
        const target = event.payload.targetUserTurnId as string;
        const index = turnIndex.get(target);
        if (index === undefined) break;
        let end = index + 1;
        while (end < messages.length && messages[end].role === "assistant") end++;
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

function reindex(messages: BranchMessage[], turnIndex: Map<string, number>): void {
  turnIndex.clear();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user" && message.turnId.length > 0) turnIndex.set(message.turnId, index);
  }
}

/**
 * 按字符预算从最旧开始丢（保留 system prompt 与最后一条待回复 user；与 .NET TrimContext 一致）。
 * 原地修改并返回同一数组。
 */
export function trimContext(context: ChatMessage[], contextChars: number): ChatMessage[] {
  const startIndex = context.length > 0 && context[0].role === "system" ? 1 : 0;
  let total = context.reduce((sum, item) => sum + item.content.length, 0);
  let drop = startIndex;
  const maxDrop = context.length - 1;
  while (total > contextChars && drop < maxDrop) {
    total -= context[drop].content.length;
    drop++;
  }
  if (drop > startIndex) context.splice(startIndex, drop - startIndex);
  return context;
}
