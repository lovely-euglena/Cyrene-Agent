import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./ocr-sidecar-path", () => ({
  resolveOcrSidecarPath: () => "C:\\fake\\CyreneOcr.exe",
}));

import { LocalOcrProvider, parseSidecarResult } from "./local-ocr-provider";
import { OcrError } from "./types";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function replyWith(stdout: string, exitCode = 0): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("exit", exitCode);
    });
    return child;
  });
}

describe("parseSidecarResult", () => {
  it("取最后一行 JSON，容忍前面的杂音", () => {
    const parsed = parseSidecarResult('warning line\n{"ok":false,"error":"X"}\n');
    expect(parsed).toEqual({ ok: false, error: "X" });
  });

  it("没有 JSON 行返回 null", () => {
    expect(parseSidecarResult("not json at all")).toBeNull();
  });
});

describe("LocalOcrProvider", () => {
  beforeEach(() => spawnMock.mockReset());

  it("recognize 映射成功结果", async () => {
    replyWith(JSON.stringify({
      ok: true,
      text: "你好 Hello",
      language: "zh-Hans-CN",
      durationMs: 42,
      lineCount: 1,
      lines: [{ text: "你好 Hello", words: [{ text: "你好", x: 1, y: 2, width: 3, height: 4 }] }],
    }));

    const provider = new LocalOcrProvider();
    const result = await provider.recognize({ imagePath: "C:\\img\\a.png", withPositions: true });
    expect(result).toMatchObject({ text: "你好 Hello", language: "zh-Hans-CN", durationMs: 42, provider: "local" });
    expect(result.lines[0].words[0]).toEqual({ text: "你好", x: 1, y: 2, width: 3, height: 4 });
  });

  it("recognize 把侧车错误映射成 OcrError（保留错误码）", async () => {
    replyWith('{"ok":false,"error":"OCR_IMAGE_NOT_FOUND","message":"图片不存在"}');
    const provider = new LocalOcrProvider();
    await expect(provider.recognize({ imagePath: "C:\\img\\nope.png" })).rejects.toMatchObject({
      name: "OcrError",
      code: "OCR_IMAGE_NOT_FOUND",
      message: "图片不存在",
    });
  });

  it("无输出时抛 OCR_NO_RESULT", async () => {
    replyWith("", 1);
    const provider = new LocalOcrProvider();
    await expect(provider.recognize({ imagePath: "C:\\img\\a.png" })).rejects.toBeInstanceOf(OcrError);
  });

  it("listLanguagesDetailed 解析语言与默认语言", async () => {
    replyWith(JSON.stringify({
      ok: true,
      languages: [{ tag: "zh-Hans-CN", name: "简体中文" }, { tag: "en-US", name: "英语" }],
      default: "zh-Hans-CN",
    }));
    const provider = new LocalOcrProvider();
    const detailed = await provider.listLanguagesDetailed();
    expect(detailed.defaultLanguage).toBe("zh-Hans-CN");
    expect(detailed.languages).toHaveLength(2);
    expect(detailed.languages[0].tag).toBe("zh-Hans-CN");
  });

  it("isAvailable 依据 exe 探测结果", () => {
    expect(new LocalOcrProvider().isAvailable()).toBe(true);
  });
});