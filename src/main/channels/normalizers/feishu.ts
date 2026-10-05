// 飞书事件归一化与出站请求体构造（纯函数）。
//
// 入站对齐桌面 adapters/feishu/index.ts 的 normalizeLarkMessage（长连接 SDK 归一化后的行为）：
//   - 仅私聊（chat_type=p2p），群/频道事件忽略（返回 null）；
//   - text：content JSON 的 text 字段，解析失败退回原始 content；
//   - image/file/audio/video/sticker：text 占位 `[<message_type>]`，媒体进 media 描述符
//     （本地路径由适配器下载后补）；
//   - 其它 message_type：text 占位 `[<message_type>]`。
// 出站对齐 sendLark：文本/图片/文件/音频/卡片/表情逐 part 一条 im/v1/messages 请求体；
// 图片/文件/音频的 file_key/image_key 由调用方先上传后注入。
// 服务端 C# 镜像见 dotnet/cyrene-core/Channels/Normalizers/FeishuNormalizer.cs，fixtures/channels 双端锁定。
import type { IncomingMessage, OutgoingMessage } from "../types";

export interface FeishuInboundMedia {
  kind: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
  duration?: number;
}

export interface FeishuNormalizedInbound {
  message: IncomingMessage;
  media: FeishuInboundMedia[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const t = Number(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * 飞书事件 envelope（已解密）→ 归一化入站结果。
 * 返回 null = 非 `im.message.receive_v1`、非 p2p、或 payload 结构不合法。
 * `options.now` 仅在事件缺时间戳时兜底（fixtures 显式给出）。
 */
export function normalizeFeishuInbound(
  raw: unknown,
  options: { now: Date },
): FeishuNormalizedInbound | null {
  const envelope = asRecord(raw);
  const header = asRecord(envelope?.header);
  if (!envelope || !header || header.event_type !== "im.message.receive_v1") return null;
  const event = asRecord(envelope.event);
  if (!event) return null;
  const message = asRecord(event.message);
  if (!message) return null;
  if (message.chat_type !== "p2p") return null;

  const sender = asRecord(event.sender);
  const senderIds = asRecord(sender?.sender_id);
  const senderId = typeof senderIds?.open_id === "string" ? senderIds.open_id : "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const threadId = typeof message.thread_id === "string" && message.thread_id ? message.thread_id : undefined;
  const rawType = typeof message.message_type === "string" && message.message_type ? message.message_type : "text";

  let text = "";
  const media: FeishuInboundMedia[] = [];
  if (rawType === "text") {
    const content = parseJsonObject(message.content);
    text = typeof content?.text === "string" ? content.text : String(message.content ?? "");
  } else if (rawType === "image") {
    text = "[image]";
    const content = parseJsonObject(message.content);
    if (typeof content?.image_key === "string") media.push({ kind: "image", fileKey: content.image_key });
  } else if (rawType === "file") {
    text = "[file]";
    const content = parseJsonObject(message.content);
    if (typeof content?.file_key === "string") {
      media.push({
        kind: "file",
        fileKey: content.file_key,
        ...(typeof content.file_name === "string" ? { fileName: content.file_name } : {}),
      });
    }
  } else if (rawType === "audio") {
    text = "[audio]";
    const content = parseJsonObject(message.content);
    if (typeof content?.file_key === "string") {
      media.push({
        kind: "audio",
        fileKey: content.file_key,
        ...(typeof content.duration === "number" ? { duration: content.duration } : {}),
      });
    }
  } else if (rawType === "video") {
    text = "[video]";
    const content = parseJsonObject(message.content);
    if (typeof content?.file_key === "string") {
      media.push({
        kind: "video",
        fileKey: content.file_key,
        ...(typeof content.file_name === "string" ? { fileName: content.file_name } : {}),
      });
    }
  } else if (rawType === "sticker") {
    text = "[sticker]";
    const content = parseJsonObject(message.content);
    if (typeof content?.file_key === "string") media.push({ kind: "image", fileKey: content.file_key });
  } else {
    // post / interactive / shareChat 等：桌面同口径占位
    text = `[${rawType}]`;
  }

  const atMs = parseEpochMs(event.timestamp) ?? parseEpochMs(header.create_time);
  return {
    message: {
      channel: "feishu",
      senderId,
      chatId,
      ...(threadId ? { threadId } : {}),
      messageId,
      text,
      at: atMs !== undefined ? new Date(atMs) : options.now,
    },
    media,
  };
}

// ── 出站 ─────────────────────────────────────────────────────────────────────

export interface FeishuUploadResult {
  image_key?: string;
  file_key?: string;
}

export interface FeishuSendContext {
  /** receive_id_type（缺省：私聊 open_id / 群 chat_id） */
  receiveIdType?: "open_id" | "chat_id";
  /** filePath/imagePath → 上传结果（image_key / file_key） */
  uploads?: Record<string, FeishuUploadResult>;
  /** filePath → 音频时长（ms；非 Opus 音频飞书要求显式） */
  durations?: Record<string, number>;
}

export interface FeishuSendRequest {
  receive_id: string;
  msg_type: string;
  /** 飞书要求 content 为 JSON 字符串（紧凑、无空格） */
  content: string;
}

export interface FeishuSendPlan {
  /** 调用方拼 `?receive_id_type=<...>` 用 */
  receiveIdType: "open_id" | "chat_id";
  requests: FeishuSendRequest[];
  error?: string;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** 飞书资源类型 → 扩展名 + MIME（适配器下载落盘用；桌面既有表）。 */
export function resourceKindToExt(ktype: string): { ext: string; mime: string } {
  switch (ktype) {
    case "image": return { ext: ".png", mime: "image/png" };
    case "audio": return { ext: ".mp3", mime: "audio/mpeg" };
    case "video": return { ext: ".mp4", mime: "video/mp4" };
    case "file":  return { ext: ".bin", mime: "application/octet-stream" };
    case "sticker": return { ext: ".png", mime: "image/png" };
    default: return { ext: ".bin", mime: "application/octet-stream" };
  }
}

function cardPayload(part: Extract<OutgoingMessage["parts"][number], { kind: "card" }>): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: part.title }, template: "blue" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: part.markdown ?? "" } },
      ...(part.fields && part.fields.length > 0
        ? [
            {
              tag: "div",
              fields: part.fields.map((f) => ({
                is_short: true,
                text: { tag: "lark_md", content: `**${f.key}**\n${f.value}` },
              })),
            },
          ]
        : []),
    ],
  };
}

/** OutgoingMessage → 飞书 im/v1/messages 请求体列表（多 parts 循环，与桌面 sendLark 同构）。 */
export function buildFeishuSendRequests(
  message: OutgoingMessage,
  context: FeishuSendContext = {},
): FeishuSendPlan {
  const receiveIdType = context.receiveIdType ?? (message.chatType === "group" ? "chat_id" : "open_id");
  const requests: FeishuSendRequest[] = [];
  const fail = (error: string): FeishuSendPlan => ({ receiveIdType, requests: [], error });
  for (const part of message.parts) {
    if (part.kind === "text") {
      requests.push({
        receive_id: message.targetId,
        msg_type: "text",
        content: JSON.stringify({ text: part.text }),
      });
    } else if (part.kind === "image") {
      const upload = part.filePath ? context.uploads?.[part.filePath] : undefined;
      if (!upload?.image_key) return fail(`缺少图片上传结果: ${part.filePath ?? "url"}`);
      requests.push({
        receive_id: message.targetId,
        msg_type: "image",
        content: JSON.stringify({ image_key: upload.image_key }),
      });
    } else if (part.kind === "sticker") {
      const upload = context.uploads?.[part.imagePath];
      if (!upload?.image_key) return fail(`缺少图片上传结果: ${part.imagePath}`);
      requests.push({
        receive_id: message.targetId,
        msg_type: "image",
        content: JSON.stringify({ image_key: upload.image_key }),
      });
    } else if (part.kind === "file") {
      const upload = context.uploads?.[part.filePath];
      if (!upload?.file_key) return fail(`缺少文件上传结果: ${part.filePath}`);
      requests.push({
        receive_id: message.targetId,
        msg_type: "file",
        content: JSON.stringify({ file_key: upload.file_key, file_name: part.name ?? basename(part.filePath) }),
      });
    } else if (part.kind === "audio") {
      const upload = context.uploads?.[part.filePath];
      if (!upload?.file_key) return fail(`缺少音频上传结果: ${part.filePath}`);
      const duration = context.durations?.[part.filePath];
      requests.push({
        receive_id: message.targetId,
        msg_type: "audio",
        content: JSON.stringify(duration !== undefined ? { file_key: upload.file_key, duration } : { file_key: upload.file_key }),
      });
    } else if (part.kind === "video") {
      const upload = context.uploads?.[part.filePath];
      if (!upload?.file_key) return fail(`缺少视频上传结果: ${part.filePath}`);
      requests.push({
        receive_id: message.targetId,
        msg_type: "media",
        content: JSON.stringify(
          upload.image_key !== undefined
            ? { file_key: upload.file_key, image_key: upload.image_key }
            : { file_key: upload.file_key },
        ),
      });
    } else if (part.kind === "card") {
      requests.push({
        receive_id: message.targetId,
        msg_type: "interactive",
        content: JSON.stringify(cardPayload(part)),
      });
    }
  }
  return { receiveIdType, requests };
}
