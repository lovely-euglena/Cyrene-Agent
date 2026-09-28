import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  NativeSnipasteCaptureClient,
  parseNativeCaptureResult,
  type NativeSnipasteCaptureChild,
} from "./native-snipaste-client";

interface FakeChild extends NativeSnipasteCaptureChild {
  emitStdout(text: string): void;
  emitExit(code: number): void;
  emitError(error: Error): void;
  killed: boolean;
}

function createFakeChild(): FakeChild {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const stderrHandlers: Array<(chunk: string) => void> = [];
  const child: FakeChild = {
    killed: false,
    stdout: { on: (_event, listener) => { stdoutHandlers.push(listener as (chunk: string) => void); return child; } },
    stderr: { on: (_event, listener) => { stderrHandlers.push(listener as (chunk: string) => void); return child; } },
    on(event: string, listener: (...args: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      handlers.set(event, list);
      return child;
    },
    kill() { child.killed = true; return true; },
    emitStdout(text) { for (const listener of stdoutHandlers) listener(text); },
    emitExit(code) { for (const listener of handlers.get("exit") ?? []) listener(code); },
    emitError(error) { for (const listener of handlers.get("error") ?? []) listener(error); },
  };
  return child;
}

function createClient(options: {
  resolveNativeExe?: () => string | null;
  getSnipastePath?: () => string;
  timeoutMs?: number;
  /** spawn 之后的应答（内部用 setTimeout 0 触发，保证监听器已挂上）。 */
  respond?: (child: FakeChild) => void;
} = {}) {
  const calls: string[][] = [];
  const child = createFakeChild();
  const client = new NativeSnipasteCaptureClient({
    resolveNativeExe: options.resolveNativeExe ?? (() => "C:\\Cyrene\\cyrene-native.exe"),
    getSnipastePath: options.getSnipastePath ?? (() => ""),
    screenshotDirectory: path.join("C:\\", "shots"),
    spawnImpl: (command, args) => {
      calls.push([command, ...args]);
      if (options.respond) {
        const respond = options.respond;
        setTimeout(() => respond(child), 0);
      }
      return child;
    },
    timeoutMs: options.timeoutMs,
  });
  return { client, child, calls };
}

describe("parseNativeCaptureResult", () => {
  it("取最后一行可解析 JSON，忽略杂音", () => {
    const stdout = "some debug\n{\"ok\":true,\"filePath\":\"a.png\",\"width\":10,\"height\":20}\n";
    expect(parseNativeCaptureResult(stdout)).toMatchObject({ ok: true, filePath: "a.png", width: 10, height: 20 });
    expect(parseNativeCaptureResult("not json")).toBeNull();
  });
});

describe("NativeSnipasteCaptureClient", () => {
  it("原生轨不可用时抛 NATIVE_UNAVAILABLE", async () => {
    const { client } = createClient({ resolveNativeExe: () => null });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("NATIVE_UNAVAILABLE");
    expect(client.processState).toBe("unavailable");
  });

  it("chat-button：透传 native 结果并带上参数", async () => {
    const { client, calls } = createClient({
      getSnipastePath: () => "D:\\Snip\\Snipaste.exe",
      respond: (child) => {
        child.emitStdout('{"ok":true,"filePath":"C:\\\\shots\\\\x.png","width":800,"height":600}\n');
        child.emitExit(0);
      },
    });
    const result = await client.start("clipboard-and-file", "chat-button");
    expect(result.filePath).toBe("C:\\shots\\x.png");
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(calls[0].join(" ")).toContain("--snipaste-capture --mode clipboard-and-file");
    expect(calls[0].join(" ")).toContain("--output-dir");
    expect(calls[0].join(" ")).toContain("--snipaste-path D:\\Snip\\Snipaste.exe");
  });

  it("取消：native 回 SCREENSHOT_CANCELLED → 统一错误串", async () => {
    const { client } = createClient({
      respond: (child) => {
        child.emitStdout('{"ok":false,"error":"SCREENSHOT_CANCELLED","message":"已取消截图"}\n');
        child.emitExit(0);
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SCREENSHOT_CANCELLED:user");
  });

  it("未检测到 Snipaste：透传错误码", async () => {
    const { client } = createClient({
      respond: (child) => {
        child.emitStdout('{"ok":false,"error":"SNIPASTE_NOT_FOUND"}\n');
        child.emitExit(0);
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_NOT_FOUND");
  });

  it("无 JSON 输出时归为 NATIVE_SNIPASTE_FAILED", async () => {
    const { client } = createClient({
      respond: (child) => {
        child.emitStdout("boom\n");
        child.emitExit(3);
      },
    });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow(/NATIVE_SNIPASTE_FAILED/);
  });

  it("超时：kill 子进程并抛 SNIPASTE_TIMEOUT", async () => {
    const { client, child } = createClient({ timeoutMs: 20 });
    await expect(client.start("clipboard-and-file", "chat-button")).rejects.toThrow("SNIPASTE_TIMEOUT");
    expect(child.killed).toBe(true);
  });

  it("hotkey（clipboard-only）不带 output-dir", async () => {
    const { client, calls } = createClient({
      respond: (child) => {
        child.emitStdout('{"ok":true,"filePath":null,"width":100,"height":100}\n');
        child.emitExit(0);
      },
    });
    const result = await client.start("clipboard-only", "hotkey");
    expect(result.filePath).toBeNull();
    expect(calls[0].join(" ")).not.toContain("--output-dir");
  });
});
