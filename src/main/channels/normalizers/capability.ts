// 服务端渠道能力冻结表（docs/design/2026-10-05-server-channel.md §2.2）。
//
// 与桌面 adapter 的 capability 声明刻意区分：服务端按分期冻结（如飞书 audio 在
// ffmpeg 落地前为 false），fixtures/channels 双端锁定。
import type { ChannelCapability } from "../types";

export const CHANNEL_CAPABILITIES: Record<"wechat" | "feishu" | "qqbot", ChannelCapability> = {
  wechat: {
    text: true,
    image: true,
    audio: false,
    file: true,
    video: true,
    markdown: false,
    card: false,
    sticker: true,
    maxTextLength: 2048,
  },
  feishu: {
    text: true,
    image: true,
    audio: false,
    file: true,
    video: true,
    markdown: true,
    card: true,
    sticker: true,
    maxTextLength: 4000,
  },
  qqbot: {
    text: true,
    image: false,
    audio: false,
    file: false,
    video: false,
    markdown: false,
    card: false,
    sticker: false,
    maxTextLength: 0,
  },
};

export function channelCapability(channel: "wechat" | "feishu" | "qqbot"): ChannelCapability {
  return CHANNEL_CAPABILITIES[channel];
}
