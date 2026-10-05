// 微信 iLink 归一化与出站请求体构造（纯函数）。
//
// 行为对齐桌面 adapters/wechat/ilink-bot-adapter.ts：
//   - 入站文本 = 全部 type=1 text_item 顺序拼接；message_type !== 1（bot 自回显）过滤；
//   - 媒体描述符复用 inbound-media.ts 的 describeInboundWechatMedia（含可分析扩展名表）；
//   - 出站 item 构造（text/image/voice/file/video）与适配器逐字一致，CDN 上传结果由调用方注入。
// 服务端 C# 镜像见 dotnet/cyrene-core/Channels/Normalizers/WeChatNormalizer.cs，fixtures/channels 双端锁定。
import type { IncomingMessage, OutgoingMessage } from "../types";
import {
  describeInboundWechatMedia,
  type InboundMediaDescriptor,
} from "../adapters/wechat/inbound-media";

export interface WechatCdnMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type?: 0 | 1;
  full_url?: string;
}

export type WechatInboundMedia = InboundMediaDescriptor;

export interface WechatNormalizedInbound {
  /** 归一化入站消息（attachments 由适配器下载后补 filePath，此处不含） */
  message: IncomingMessage;
  /** 媒体描述符（适配器据此下载/转写） */
  media: WechatInboundMedia[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** iLink WireMessage 的文本提取（多个 text_item 顺序拼接；与协议客户端 #wireToMessage 一致）。 */
export function extractWechatText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .filter((item) => {
      const record = asRecord(item);
      const textItem = asRecord(record?.text_item);
      return record?.type === 1 && typeof textItem?.text === "string" && textItem.text.length > 0;
    })
    .map((item) => (asRecord(asRecord(item)?.text_item)!.text as string))
    .join("");
}

function normalizeCdnMedia(value: unknown): WechatCdnMedia | undefined {
  const record = asRecord(value);
  if (!record || typeof record.encrypt_query_param !== "string" || typeof record.aes_key !== "string") {
    return undefined;
  }
  const media: WechatCdnMedia = {
    encrypt_query_param: record.encrypt_query_param,
    aes_key: record.aes_key,
  };
  if (record.encrypt_type === 0 || record.encrypt_type === 1) media.encrypt_type = record.encrypt_type;
  if (typeof record.full_url === "string") media.full_url = record.full_url;
  return media;
}

/**
 * iLink WireMessage → 归一化入站结果。
 * `options.now` 仅在缺 create_time_ms 时兜底（fixtures 显式给出，避免时钟依赖）。
 * 返回 null = 非用户消息（message_type !== 1）或 payload 不是对象。
 */
export function normalizeWechatInbound(
  raw: unknown,
  options: { now: Date },
): WechatNormalizedInbound | null {
  const wire = asRecord(raw);
  if (!wire) return null;
  if (wire.message_type !== 1) return null;

  const fromUserId = typeof wire.from_user_id === "string" ? wire.from_user_id : "";
  const createTimeMs = typeof wire.create_time_ms === "number" && Number.isFinite(wire.create_time_ms)
    ? wire.create_time_ms
    : undefined;
  const media = describeInboundWechatMedia(Array.isArray(wire.item_list) ? wire.item_list : []).map((item) => ({
    ...item,
    media: normalizeCdnMedia(item.media),
  }));

  return {
    message: {
      channel: "wechat",
      senderId: fromUserId,
      chatId: fromUserId,
      messageId: String(wire.message_id ?? ""),
      text: extractWechatText(wire.item_list),
      at: createTimeMs !== undefined ? new Date(createTimeMs) : options.now,
    },
    media,
  };
}

// ── 出站 ─────────────────────────────────────────────────────────────────────

export interface WechatVoiceUpload {
  media: WechatCdnMedia;
  playtime: number;
  sampleRate: number;
  encodeType: number;
}

export interface WechatSendContext {
  /** 入站消息原样带回（缺失时适配器拒绝发送） */
  contextToken: string;
  /** 消息唯一 id（UUID；fixtures 注入固定值，真机随机） */
  clientId: string;
  /** filePath/imagePath → CDN 上传结果 */
  uploads?: Record<string, WechatCdnMedia>;
  /** filePath → 语音编码 + 上传结果（分期能力） */
  voices?: Record<string, WechatVoiceUpload>;
}

export interface WechatSendRequest {
  msg: {
    from_user_id: "";
    to_user_id: string;
    client_id: string;
    message_type: 2;
    message_state: 2;
    context_token: string;
    item_list: WechatSendItem[];
  };
  base_info: { channel_version: "2.0.0" };
}

export interface WechatSendItem {
  type: 1 | 2 | 3 | 4 | 5;
  text_item?: { text: string };
  image_item?: { media: WechatCdnMedia };
  voice_item?: { media: WechatCdnMedia; encode_type: number; sample_rate: number; playtime: number };
  file_item?: { file_name: string; media: WechatCdnMedia };
  video_item?: { media: WechatCdnMedia };
}

export interface WechatSendPlan {
  requests: WechatSendRequest[];
  error?: string;
}

export function buildImageItem(media: WechatCdnMedia): WechatSendItem {
  return { type: 2, image_item: { media } };
}

export function buildFileItem(media: WechatCdnMedia, fileName: string): WechatSendItem {
  return { type: 4, file_item: { file_name: fileName, media } };
}

export function buildVideoItem(media: WechatCdnMedia): WechatSendItem {
  return { type: 5, video_item: { media } };
}

export function buildVoiceItem(
  media: WechatCdnMedia,
  playtime: number,
  sampleRate: number,
  encodeType: number,
): WechatSendItem {
  return { type: 3, voice_item: { media, encode_type: encodeType, sample_rate: sampleRate, playtime } };
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function requestFor(toUserId: string, context: WechatSendContext, itemList: WechatSendItem[]): WechatSendRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: context.clientId,
      message_type: 2,
      message_state: 2,
      context_token: context.contextToken,
      item_list: itemList,
    },
    base_info: { channel_version: "2.0.0" },
  };
}

/**
 * OutgoingMessage → iLink sendmessage 请求体列表。
 * 与适配器 send 的 part 分支一致：文本逐段单独发；图片/表情/语音/文件/视频各一条；
 * card（capability=false）静默跳过；图片缺 filePath 时整体拒绝（桌面同文案）。
 */
export function buildWechatSendRequests(
  message: OutgoingMessage,
  context: WechatSendContext,
): WechatSendPlan {
  const requests: WechatSendRequest[] = [];
  for (const part of message.parts) {
    if (part.kind === "text") {
      const text = part.text.trim();
      if (!text) continue;
      requests.push(requestFor(message.targetId, context, [{ type: 1, text_item: { text } }]));
    } else if (part.kind === "image") {
      if (!part.filePath) return { requests: [], error: "微信图片发送需要本地 filePath" };
      const media = context.uploads?.[part.filePath];
      if (!media) return { requests: [], error: `缺少上传结果: ${part.filePath}` };
      requests.push(requestFor(message.targetId, context, [buildImageItem(media)]));
    } else if (part.kind === "sticker") {
      const media = context.uploads?.[part.imagePath];
      if (!media) return { requests: [], error: `缺少上传结果: ${part.imagePath}` };
      requests.push(requestFor(message.targetId, context, [buildImageItem(media)]));
    } else if (part.kind === "audio") {
      const voice = context.voices?.[part.filePath];
      if (!voice) return { requests: [], error: `缺少语音编码结果: ${part.filePath}` };
      requests.push(requestFor(message.targetId, context, [
        buildVoiceItem(voice.media, voice.playtime, voice.sampleRate, voice.encodeType),
      ]));
    } else if (part.kind === "file") {
      const media = context.uploads?.[part.filePath];
      if (!media) return { requests: [], error: `缺少上传结果: ${part.filePath}` };
      requests.push(requestFor(message.targetId, context, [buildFileItem(media, basename(part.name ?? part.filePath))]));
    } else if (part.kind === "video") {
      const media = context.uploads?.[part.filePath];
      if (!media) return { requests: [], error: `缺少上传结果: ${part.filePath}` };
      requests.push(requestFor(message.targetId, context, [buildVideoItem(media)]));
    }
    // card：微信 capability=false，桌面适配器同样无分支（静默跳过）
  }
  return { requests };
}
