// 工具图片直发 400 降级链（IKLRQH 后续）——消息变换行为锁定。
// stripToolImagesToCaption 原地改写：tool content 块数组 → 剥图 → caption 文本拼回。
import { describe, expect, it, vi, beforeEach } from "vitest";

const captionImageMock = vi.fn();
const deliveryMock = vi.fn();

vi.mock("../settings/model-settings", () => ({
  resolveModelSettingsProfile: (s: unknown) => s,
  loadModelSettings: () => ({}),
}));
vi.mock("../image-router", () => ({
  resolveToolImageDelivery: (...args: unknown[]) => deliveryMock(...args),
}));
vi.mock("../vision-captioner", () => ({
  captionImage: (...args: unknown[]) => captionImageMock(...args),
}));

import { stripToolImagesToCaption } from "./cyrene-harness";
import type { ChatMessage } from "../vendors/types";

const PNG_DATA_URL = "data:image/png;base64,QUJD";
const toolWithImage = (name: string): ChatMessage => ({
  role: "tool",
  toolCallId: "tc1",
  name,
  content: [
    { type: "text", text: "[网页截图直发主模型；1280×720]" },
    { type: "image_url", image_url: { url: PNG_DATA_URL } },
  ],
});

describe("stripToolImagesToCaption（tool 图片 400 降级）", () => {
  beforeEach(() => {
    captionImageMock.mockReset();
    deliveryMock.mockReset();
  });

  it("caption 模式：剥图转述并拼接标注文本", async () => {
    deliveryMock.mockReturnValue({ mode: "caption", config: { baseUrl: "https://v.test", apiKey: "k", model: "vlm" } });
    captionImageMock.mockResolvedValue("截图内容描述");
    const messages: ChatMessage[] = [toolWithImage("browser_screenshot")];
    await expect(stripToolImagesToCaption(messages)).resolves.toBe(true);
    const m = messages[0];
    expect(typeof m.content).toBe("string");
    const text = m.content as string;
    expect(text).toContain("[网页截图直发主模型；1280×720]");
    expect(text).toContain("图片直发不被当前端点支持");
    expect(text).toContain("截图内容描述");
    expect(captionImageMock).toHaveBeenCalledWith(
      { base64: "QUJD", mime: "image/png" },
      expect.stringContaining("browser_screenshot"),
      { baseUrl: "https://v.test", apiKey: "k", model: "vlm" },
    );
  });

  it("direct/reject 模式：无 VLM 可用，不做变换", async () => {
    deliveryMock.mockReturnValue({ mode: "direct" });
    const messages: ChatMessage[] = [toolWithImage("read_image")];
    await expect(stripToolImagesToCaption(messages)).resolves.toBe(false);
    expect(Array.isArray(messages[0].content)).toBe(true); // 原样未动
    expect(captionImageMock).not.toHaveBeenCalled();
  });

  it("caption 失败（[错误·...] 字符串）不拖垮变换：错误文本入 content", async () => {
    deliveryMock.mockReturnValue({ mode: "caption", config: { baseUrl: "https://v.test", apiKey: "k", model: "vlm" } });
    captionImageMock.mockResolvedValue("[错误·连接] 视觉模型超时");
    const messages: ChatMessage[] = [toolWithImage("read_image")];
    await expect(stripToolImagesToCaption(messages)).resolves.toBe(true);
    expect(messages[0].content).toContain("[错误·连接] 视觉模型超时");
  });

  it("无图片的纯文本 tool 消息不受影响", async () => {
    deliveryMock.mockReturnValue({ mode: "caption", config: { baseUrl: "https://v.test", apiKey: "k", model: "vlm" } });
    const messages: ChatMessage[] = [{ role: "tool", toolCallId: "tc2", name: "fs_list", content: "普通文本结果" }];
    await expect(stripToolImagesToCaption(messages)).resolves.toBe(false);
    expect(messages[0].content).toBe("普通文本结果");
  });
});
