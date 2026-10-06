/**
 * 云端同步 · 合并读模型（IKJK2I）。
 *
 * 契约（设计稿 §5.2）：CHATS_GET 组合会话后，若同步启用且该会话存在远端事件，
 * 以「本地投影 + 远端 overlay」合并出 UI 消息流；同步未启用 / 无远端事件时原样返回。
 *
 * 边界：远端集合 replay 后仅保留最小 ChatMessage（id=eventId / role / content / at），
 * 空文本 assistant 不产生空气泡；本地消息保持原序，远端消息按其 ts 插入；
 * 远端 rewind / tombstone 锚点为本地回合时 no-op（replay 未知锚点即 no-op）。
 */

import type { ChatMessage, ChatSession } from "../../shared/chat-types";
import { replaySession, type BranchMessage } from "./materializer";
import type { SyncEventV0 } from "./sync-protocol";

/** 同步服务对读模型暴露的最小接口（由 sync-service 实现）。 */
export interface RemoteMergeSource {
  /** 同步是否启用（未启用 → 不做任何合并）。 */
  isEnabled(): boolean;
  /** 该会话的远端事件（inbox 中 deviceId ≠ 本机；已去重、规范序）。 */
  getRemoteSessionEvents(sessionId: string): Promise<SyncEventV0[]>;
}

/** CHATS_GET 使用的合并函数：输入本地组合会话，输出（可能）并入远端消息的会话。 */
export type RemoteMergeProvider = (session: ChatSession) => Promise<ChatSession>;

/** 远端分支消息 → 最小 ChatMessage（协议 role assistant 映射为桌面 ChatRole model）。 */
function toChatMessage(message: BranchMessage): ChatMessage {
  return {
    id: message.eventId,
    role: message.role === "assistant" ? "model" : "user",
    content: message.text,
    at: Date.parse(message.ts),
  };
}

/**
 * 构建合并 provider；source 为空时返回 null（调用方将 undefined 传给 chats-ipc）。
 * provider 本身无状态：gating 在每次调用时读取 source.isEnabled()。
 */
export function createRemoteMergeProvider(source: RemoteMergeSource | null): RemoteMergeProvider | null {
  if (!source) return null;
  return async (session: ChatSession): Promise<ChatSession> => {
    // gating：同步未启用 → 不触碰 inbox，UI 零变化（原样返回同一对象）。
    if (!source.isEnabled()) return session;
    const events = await source.getRemoteSessionEvents(session.id);
    if (events.length === 0) return session;

    // 远端集合 replay（与 PWA 同一共享核心）→ 最小消息；空文本 assistant 跳过。
    const remoteMessages: ChatMessage[] = [];
    for (const message of replaySession(events)) {
      if (message.role === "assistant" && message.text.trim().length === 0) continue;
      remoteMessages.push(toChatMessage(message));
    }

    // 本地消息保持原序；远端按其 ts 稳定插入（同刻本地在前）；重复 eventId 防御性跳过。
    const localIds = new Set(session.messages.map((message) => message.id));
    const merged = [...session.messages];
    for (const remote of remoteMessages) {
      if (localIds.has(remote.id)) continue;
      const index = merged.findIndex((message) => message.at > remote.at);
      if (index === -1) merged.push(remote);
      else merged.splice(index, 0, remote);
    }
    return { ...session, messages: merged };
  };
}
