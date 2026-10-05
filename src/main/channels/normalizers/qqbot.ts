// QQ 官方 bot 归一化与被动回复请求体构造（纯函数，从 adapters/qqbot/qqbot-adapter.ts 抽出）。
//
// 行为与桌面适配器逐字一致；服务端 C# 侧镜像见
// dotnet/cyrene-core/Channels/Normalizers/QqBotNormalizer.cs，fixtures/channels 双端锁定。
import type { ChannelAttachment, IncomingMessage, OutgoingMessage } from "../types";
import { splitQqText } from "./qq-text";

/** 归一化可消费的事件类型（READY/RESUMED 等由适配器自行处理）。 */
export const QQBOT_MESSAGE_EVENTS = [
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
  "GROUP_MESSAGE_CREATE",
] as const;

/** 事件体 → IncomingMessage（attachments 由适配器侧下载后补 filePath）。 */
export function normalizeQqBotEvent(
  type: string,
  data: Record<string, unknown>,
  options: { now?: Date } = {},
): IncomingMessage | null {
  if (type !== "C2C_MESSAGE_CREATE" && type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE") {
    return null;
  }
  const author = (data.author ?? {}) as Record<string, unknown>;
  const isGroup = type !== "C2C_MESSAGE_CREATE";
  const senderId = String(author[isGroup ? "member_openid" : "user_openid"] ?? "");
  const chatId = isGroup ? String(data.group_openid ?? "") : senderId;
  if (!senderId || !chatId) return null;
  const content = String(data.content ?? "").trim();
  const attachments = parseAttachments(data.attachments);
  if (!content && attachments.length === 0) return null;
  const at = parseTimestamp(String(data.timestamp ?? ""), options.now);
  return {
    channel: "qqbot",
    chatType: isGroup ? "group" : "private",
    messageId: String(data.id ?? ""),
    senderId,
    senderName: typeof author.username === "string" && author.username ? author.username : undefined,
    chatId,
    text: content,
    attachments: attachments.length > 0 ? attachments : undefined,
    at,
    _raw: data,
  };
}

function parseAttachments(raw: unknown): ChannelAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelAttachment[] = [];
  for (const item of raw) {
    const a = (item ?? {}) as Record<string, unknown>;
    const contentType = String(a.content_type ?? "");
    const url = String(a.voice_wav_url ?? a.url ?? "");
    if (!url) continue;
    let kind: ChannelAttachment["kind"] = "file";
    if (contentType.startsWith("image/")) kind = "image";
    else if (contentType === "voice") kind = "audio";
    else if (contentType.startsWith("video/")) kind = "video";
    out.push({
      kind,
      url,
      mime: contentType || undefined,
      caption: typeof a.filename === "string" && a.filename ? a.filename : undefined,
    });
  }
  return out;
}

function parseTimestamp(value: string, now?: Date): Date {
  if (value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t);
  }
  return now ?? new Date();
}

export interface QqBotReplyRequest {
  msg_type: 0;
  content: string;
  msg_id: string;
  msg_seq: number;
}

export interface QqBotReplyContext {
  /** 触发消息 id（被动回复窗口内必填） */
  messageId: string;
  /** 该触发消息已用掉的回复次数（桌面语义：从 0 起） */
  msgSeqUsed?: number;
  /** 次数上限（单聊 4 / 群 5）；缺省 = 不限 */
  seqLimit?: number;
}

export interface QqBotReplyPlan {
  requests: QqBotReplyRequest[];
  error?: string;
}

/** OutgoingMessage → 被动回复请求体列表（分片 + msg_seq 递增 + 超限错误）。 */
export function buildQqBotPassiveReplies(
  message: OutgoingMessage,
  context: QqBotReplyContext,
): QqBotReplyPlan {
  const chunks: string[] = [];
  let lastError: string | undefined;
  for (const part of message.parts) {
    if (part.kind === "text") {
      chunks.push(...splitQqText(part.text));
    } else if (part.kind === "card") {
      const text = [part.title, part.markdown, ...(part.fields ?? []).map((f) => `${f.key}: ${f.value}`)]
        .filter(Boolean)
        .join("\n");
      chunks.push(...splitQqText(text));
    } else {
      lastError = `QQ Bot 官方渠道暂不支持发送 ${part.kind} 类型内容`;
    }
  }
  if (chunks.length === 0) {
    return { requests: [], error: lastError || "没有可发送的 QQ Bot 内容" };
  }

  const requests: QqBotReplyRequest[] = [];
  let seqUsed = context.msgSeqUsed ?? 0;
  const seqLimit = context.seqLimit ?? Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    if (seqUsed >= seqLimit) {
      lastError = `回复次数达上限，余下 ${chunks.length - requests.length} 段未发送`;
      break;
    }
    seqUsed++;
    requests.push({
      msg_type: 0,
      content: chunk,
      msg_id: context.messageId,
      msg_seq: seqUsed,
    });
  }
  return lastError ? { requests, error: lastError } : { requests };
}
