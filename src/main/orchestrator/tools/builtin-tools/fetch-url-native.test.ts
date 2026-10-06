/**
 * fetch_url native 轨接线测试（IKJK3V T2 库替代批）：
 *  - native 可用：按件看门狗 25s + 取消信号透传，结果原样返回
 *  - native 不可用：静默回退 TS 实现（校验语义一致：非 http(s) → [错误] 前缀）
 *  - 取消（AbortError）：原样上抛，不得回退重跑
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: { timeoutMs?: number; signal?: AbortSignal } }>,
  nativeResult: null as string | null,
  nativeError: null as Error | null,
}));

vi.mock("../native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: vi.fn() },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    nativeMocks.calls.push({ tool, args, options });
    if (nativeMocks.nativeError !== null) throw nativeMocks.nativeError;
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    return fallback(args);
  },
}));

import { clearFetchUrlCache, fetchUrlTool } from "./fetch-url-tool";

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.nativeError = null;
  clearFetchUrlCache();
});

describe("fetch_url native 轨", () => {
  it("native 可用：透传结果，看门狗 25s，args 原样", async () => {
    nativeMocks.nativeResult = "URL: https://example.com\n\n# hi";
    const signal = new AbortController().signal;

    const out = await fetchUrlTool.execute({ url: "https://example.com" }, { signal } as never);

    expect(out).toBe("URL: https://example.com\n\n# hi");
    expect(nativeMocks.calls).toEqual([
      {
        tool: "fetch_url",
        args: { url: "https://example.com" },
        options: { timeoutMs: 25_000, signal, abandonOnTimeout: true },
      },
    ]);
  });

  it("native 不可用：回退 TS 实现（非 http(s) 校验错误一致）", async () => {
    const out = await fetchUrlTool.execute({ url: "ftp://example.com" }, undefined);
    expect(out).toBe("[错误] url 必须以 http:// 或 https:// 开头");
  });

  it("取消（AbortError）：原样上抛，不回退 TS", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    nativeMocks.nativeError = err;

    await expect(fetchUrlTool.execute({ url: "https://example.com" }, undefined)).rejects.toThrow("aborted");
  });
});
