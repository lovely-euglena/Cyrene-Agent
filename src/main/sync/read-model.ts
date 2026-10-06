/**
 * 云端同步 · 合并读模型（IKJK2I）。
 *
 * 契约（设计稿 §5.2）：CHATS_GET 组合会话后，若同步启用且该会话存在远端事件，
 * 以「本地投影 + 远端 overlay」合并出 UI 消息流；同步未启用 / 无远端事件时原样返回。
 *
 * 本文件为接口冻结占位：签名不变，实现体由实现簇落地（replay 合并 / 排序 / 去重）。
 */

import type { ChatSession } from "../../shared/chat-types";
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

/**
 * 构建合并 provider；source 为空或未启用时返回 null（调用方将 undefined 传给 chats-ipc）。
 * 占位实现恒返回 null（未启用等价），真实实现由实现簇替换（保持签名不变）。
 */
export function createRemoteMergeProvider(source: RemoteMergeSource | null): RemoteMergeProvider | null {
  void source;
  return null;
}
