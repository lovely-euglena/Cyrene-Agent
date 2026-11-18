import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  readPngSize,
  SnipasteScreenshotClient,
  SwitchableScreenshotClient,
  type SnipasteChildProcess,
  type SnipasteClientOptions,
} from "./snipaste-client";
import type { ScreenshotHelperClient } from "./helper-client";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const EXE = "C:\\Tools\\Snipaste\\Snipaste.exe";

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

interface FakeChild extends SnipasteChildProcess {
  emit(event: "error" | "exit", value?: Error | number | null): void;
  killed: boolean;
}

function createFakeChild(): FakeChild {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: FakeChild = {
    killed: false,
    on(event: string, listener: (...args: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      handlers.set(event, list);
      return child;
    },
    emit(event, value) {
      for (const listener of handlers.get(event) ?? []) listener(value);
    },
    kill() {
      child.killed = true;
      return true;
    },
  };
  return child;
}

function createClient(
  overrides: Partial<SnipasteClientOptions> & {
    resolveExecutable?: SnipasteClientOptions["resolveExecutable"];
    readClipboardPng?: SnipasteClientOptions["readClipboardPng"];
  } = {},
): { client: SnipasteScreenshotClient; writes: Array<{ filePath: string; data: Buffer }>; calls: string[] } {
  const writes: Array<{ filePath: string; data: Buffer }> = [];
  const calls: string[] = [];
  const client = new SnipasteScreenshotClient({
    resolveExecutable: async () => EXE,
    screenshotDirectory: path.join("C:\\", "shots"),
    readClipboardPng: () => null,
    isProcessRunningImpl: async () => true,
    // 默认 Beta 版本：既有用例保持原 CLI/取消语义；CLI 支持度专用用例单独注入
    readVersionImpl: () => "2.8.8 Beta",
    createRequestId: () => REQUEST_ID,
    writeFileImpl: async (filePath, data) => {
      writes.push({ filePath, data });
    },
    spawnImpl: (command, args) => {
      calls.push([command, ...args].join(" "));
      const child = createFakeChild();
      setTimeout(() => child.emit("exit", 0), 0);
      return child;
    },
    ...overrides,
  });
  return { client, writes, calls };
}

describe("readPngSize", () => {
  it("解析合法 PNG 头", () => {
    expect(readPngSize(pngBuffer(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("拒绝非 PNG / 截断数据", () => {
    expect(readPngSize(Buffer.from("not a png"))).toBeNull();
    expect(readPngSize(Buffer.alloc(10))).toBeNull();
  });
});

describe("SnipasteScreenshotClient", () => {
  it("未检测到 Snipaste 时抛 SNIPASTE_NOT_FOUND 并标记 unavailable", async () => {
    const { client } = createClient({ resolveExecutable: async () => null });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_NOT_FOUND");
    expect(client.processState).toBe("unavailable");
  });

  it("chat-button：截图成功后写文件并返回尺寸", async () => {
    const image = pngBuffer(800, 600);
    let clipboard: Buffer | null = null;
    const { client, writes, calls } = createClient({
      readClipboardPng: () => clipboard,
      spawnImpl: (command, args) => {
        calls.push([command, ...args].join(" "));
        const child = createFakeChild();
        setTimeout(() => {
          clipboard = image;
          child.emit("exit", 0);
        }, 0);
        return child;
      },
    });

    const result = await client.start("clipboard-and-file", "chat-button");
    expect(calls[0]).toContain("snip --block -o clipboard");
    expect(result.filePath).toBe(path.join("C:\\", "shots", `${REQUEST_ID}.png`));
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(writes).toHaveLength(1);
    expect(writes[0].data.equals(image)).toBe(true);
    expect(result.clipboardWritten).toBe(true);
  });

  it("剪贴板无变化（用户取消）时抛 SCREENSHOT_CANCELLED", async () => {
    const same = pngBuffer(100, 100);
    const { client } = createClient({ readClipboardPng: () => same });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SCREENSHOT_CANCELLED:user");
  });

  it("版本预检：稳定版（无 Beta 标记）不发 CLI 参数，直接抛 SNIPASTE_CLI_UNSUPPORTED", async () => {
    const { client, calls } = createClient({ readVersionImpl: () => "2.8.8" });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_CLI_UNSUPPORTED");
    expect(calls.join("\n")).not.toContain("snip");
  });

  it("行为探测兜底：unknown 版本 + CLI 进程秒退 + 剪贴板无变化 → SNIPASTE_CLI_UNSUPPORTED", async () => {
    const { client } = createClient({
      readVersionImpl: () => null, // 版本读不出（unknown），启用秒退探测
      readClipboardPng: () => null, // 剪贴板始终无变化
    });
    // mock spawnImpl 秒退（工厂默认 setTimeout 0 退出）→ isQuickExit 命中
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_CLI_UNSUPPORTED");
  });

  it("unknown 版本但非秒退（用户先选区再取消）保持 SCREENSHOT_CANCELLED 语义", async () => {
    const { client } = createClient({
      readVersionImpl: () => null,
      readClipboardPng: () => null,
      spawnImpl: (command, args) => {
        void command; void args;
        const child = createFakeChild();
        setTimeout(() => child.emit("exit", 0), 1600);
        return child;
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SCREENSHOT_CANCELLED:user");
  });

  it("hotkey（clipboard-only）不落盘", async () => {
    const image = pngBuffer(320, 200);
    let clipboard: Buffer | null = null;
    const { client, writes } = createClient({
      readClipboardPng: () => clipboard,
      spawnImpl: () => {
        const child = createFakeChild();
        setTimeout(() => {
          clipboard = image;
          child.emit("exit", 0);
        }, 0);
        return child;
      },
    });
    const result = await client.start("clipboard-only", "hotkey");
    expect(result.filePath).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("常驻进程未运行时先拉起再等待就绪", async () => {
    const image = pngBuffer(10, 10);
    let running = false;
    let launched = 0;
    let clipboard: Buffer | null = null;
    let fakeNow = 0;
    const { client } = createClient({
      isProcessRunningImpl: async () => running,
      startProcessImpl: () => {
        launched += 1;
        running = true;
      },
      readClipboardPng: () => clipboard,
      spawnImpl: () => {
        const child = createFakeChild();
        setTimeout(() => {
          clipboard = image;
          child.emit("exit", 0);
        }, 0);
        return child;
      },
      now: () => fakeNow,
      sleepImpl: async (ms) => {
        fakeNow += ms;
      },
    });
    await client.start("clipboard-and-file", "chat-button");
    expect(launched).toBe(1);
  });

  it("常驻进程始终起不来时抛 SNIPASTE_START_FAILED", async () => {
    let fakeNow = 0;
    const { client } = createClient({
      isProcessRunningImpl: async () => false,
      startProcessImpl: () => undefined,
      now: () => fakeNow,
      sleepImpl: async (ms) => {
        fakeNow += ms;
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_START_FAILED");
  });

  it("子进程 error 转 SNIPASTE_FAILED", async () => {
    const { client } = createClient({
      spawnImpl: () => {
        const child = createFakeChild();
        setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 0);
        return child;
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_FAILED");
  });

  it("交互超时（硬上限）时终止等待并 kill", async () => {
    let child: FakeChild | null = null;
    const { client } = createClient({
      maxInteractionMs: 20,
      spawnImpl: () => {
        child = createFakeChild();
        return child;
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_TIMEOUT");
    expect(child!.killed).toBe(true);
  });

  it("cancel 是无操作（不抛错）", async () => {
    const { client } = createClient();
    expect(() => client.cancel("whatever")).not.toThrow();
  });
});

describe("SwitchableScreenshotClient", () => {
  it("切换后委托到新后端", async () => {
    const calls: string[] = [];
    const make = (name: string): ScreenshotHelperClient => ({
      processState: "ready",
      captureState: "idle",
      pendingRequests: new Map(),
      ensureStarted: async () => {
        calls.push(`${name}:ensure`);
      },
      start: async () => {
        calls.push(`${name}:start`);
        return {
          requestId: "r",
          filePath: null,
          width: 1,
          height: 1,
          mime: "image/png",
          clipboardWritten: false,
          hasAnnotations: false,
        };
      },
      cancel: () => undefined,
      shutdown: async () => undefined,
    });
    const router = new SwitchableScreenshotClient(make("a"));
    await router.ensureStarted();
    router.setActive(make("b"));
    await router.start("clipboard-only", "hotkey");
    expect(calls).toEqual(["a:ensure", "b:start"]);
  });
});
