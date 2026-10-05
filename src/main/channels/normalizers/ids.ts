// 渠道 id 派生（服务端渠道契约 v1 的语义源）。
//
// 与桌面既有实现逐字一致，双端 fixtures 锁定：
//   - sessionId：channel:<channel>:<sha256(channel:chatId)[..16]>（原 channel-context.ts）
//   - turnId：messageId 优先，缺省 at:text（换行压成单行空格；原 dispatcher.ts）
//   - 事件 id（服务端事件流，docs/design/2026-10-05-server-channel.md §2.4）：
//       用户消息  ch-<channel>-<sha256(channel:chatId:source)[..32]>
//       助手回复  gen-<sha256(sessionId:anchorEventId)[..32]>（与 DialogLoop 现状一致）
//       主动消息  proactive-<sha256(sessionId:intentId)[..32]>
//   source = messageId；缺省时 `${at.getTime()}:${text}`，与 turnId 同一压缩规则。
import { createHash } from "node:crypto";
import type { IncomingMessage } from "../types";

/** 事件 id / turn id 的公共来源：messageId 优先，缺省 at:text；换行压成单行空格。 */
export function channelTurnSource(
  msg: Pick<IncomingMessage, "messageId" | "at" | "text">,
): string {
  const source = msg.messageId || `${msg.at.getTime()}:${msg.text}`;
  return source.replace(/[\r\n]+/g, " ");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 会话 id：channel:<channel>:<sha256(channel:chatId)[..16]>（与桌面 channel-context 同实现）。 */
export function makeSessionId(channel: string, chatId: string): string {
  return `channel:${channel}:${sha256Hex(`${channel}:${chatId}`).slice(0, 16)}`;
}

/** 轮次 id：`<channel>:<chatId>:<source>:<role>`（与桌面 dispatcher 同实现）。 */
export function makeChannelTurnId(
  msg: Pick<IncomingMessage, "channel" | "chatId" | "messageId" | "at" | "text">,
  role: "user" | "assistant",
): string {
  return `${msg.channel}:${msg.chatId}:${channelTurnSource(msg)}:${role}`;
}

/** 用户消息事件 id（服务端事件流幂等键）。 */
export function makeChannelUserEventId(
  msg: Pick<IncomingMessage, "channel" | "chatId" | "messageId" | "at" | "text">,
): string {
  return `ch-${msg.channel}-${sha256Hex(`${msg.channel}:${msg.chatId}:${channelTurnSource(msg)}`).slice(0, 32)}`;
}

/** 助手回复事件 id：与 DialogLoop 现状一致（gen- + sha256(sessionId:anchorEventId)）。 */
export function makeAssistantEventId(sessionId: string, anchorEventId: string): string {
  return `gen-${sha256Hex(`${sessionId}:${anchorEventId}`).slice(0, 32)}`;
}

/** 主动消息事件 id（intentId 幂等）。 */
export function makeProactiveEventId(sessionId: string, intentId: string): string {
  return `proactive-${sha256Hex(`${sessionId}:${intentId}`).slice(0, 32)}`;
}
