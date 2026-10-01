import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 不直接用 vi.fn 做替换实现：Vitest 会把 mock 实现里抛出的错误记为测试错误
// （即使调用方已 catch），这里用 hoisted 状态 + 普通 async 函数规避。
const { ocrState } = vi.hoisted(() => ({
  ocrState: { result: undefined as unknown, error: undefined as unknown },
}));

vi.mock("../../../ocr/ocr-registry", () => ({
  runOcr: async () => {
    if (ocrState.error) throw ocrState.error;
    return ocrState.result;
  },
}));

import { OcrError } from "../../../ocr/types";
import { ocrImageTool } from "./ocr-image-tool";

function makeTempImage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-ocr-tool-"));
  const file = path.join(dir, "shot.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

describe("ocr_image 工具", () => {
  beforeEach(() => {
    ocrState.result = undefined;
    ocrState.error = undefined;
  });

  it("非绝对路径直接拒绝", async () => {
    expect(await ocrImageTool.execute({ path: "shot.png" })).toBe("[错误] path 必须是绝对路径");
  });

  it("文件不存在返回明确错误", async () => {
    const missing = path.join(os.tmpdir(), "cyrene-ocr-missing-" + Date.now() + ".png");
    expect(await ocrImageTool.execute({ path: missing })).toContain("[错误] 文件不存在或无法访问");
  });

  it("成功时返回识别文本（无坐标）", async () => {
    const file = makeTempImage();
    ocrState.result = {
      text: "你好世界\nsecond line",
      lines: [],
      language: "zh-Hans-CN",
      provider: "local",
      durationMs: 12,
    };

    const out = await ocrImageTool.execute({ path: file });
    expect(out).toContain("[OCR·本地] 语言 zh-Hans-CN");
    expect(out).toContain("你好世界");
    expect(out).toContain("second line");
    expect(out).not.toContain("坐标原点");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("positions=true 时输出行/词坐标", async () => {
    const file = makeTempImage();
    ocrState.result = {
      text: "你好",
      lines: [{ text: "你好", words: [{ text: "你好", x: 10, y: 20, width: 30, height: 40 }] }],
      language: "zh-Hans-CN",
      provider: "local",
      durationMs: 5,
    };

    const out = await ocrImageTool.execute({ path: file, positions: true });
    expect(out).toContain("坐标原点在图片左上角");
    expect(out).toContain("你好(10,20,30×40)");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("OcrError 映射为 [错误·OCR <code>]", async () => {
    const file = makeTempImage();
    ocrState.error = new OcrError("OCR_IMAGE_NOT_FOUND", "图片不存在");

    const out = await ocrImageTool.execute({ path: file });
    expect(out).toContain("[错误·OCR OCR_IMAGE_NOT_FOUND]");
    expect(out).toContain("图片不存在");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("工具元数据：read 效果 + fs-read 风险", () => {
    expect(ocrImageTool.id).toBe("ocr_image");
    expect(ocrImageTool.risk).toBe("fs-read");
    expect(ocrImageTool.effectKind).toBe("read");
    expect(ocrImageTool.verificationPolicy).toBe("none");
    expect(ocrImageTool.inputSchema.required).toEqual(["path"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});