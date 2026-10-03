/**
 * web_search native 轨接线测试（IKJK3V T1 剩余）：
 *  - native 可用：调用前实时下发 webSearch 配置（引擎/各源 key），按件看门狗 25s
 *  - native 不可用：静默回退 TS 实现（错误语义一致：off → E_SEARCH_NOT_ENABLED）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: { timeoutMs?: number; signal?: AbortSignal } }>,
  setRuntimeSettings: vi.fn(),
  nativeResult: null as string | null,
}));

vi.mock("../native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: nativeMocks.setRuntimeSettings },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    nativeMocks.calls.push({ tool, args, options });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    // 模拟真实 nativeFirst 的故障回退语义
    return fallback(args);
  },
}));

import { clearWebSearchCache, setSearchConfig, webSearchTool } from "./web-search-tool";

function configure(engine: string, keys: Partial<{ bocha: string; tavily: string; anySearch: string }> = {}): void {
  setSearchConfig(
    () => engine,
    () => keys.bocha ?? "",
    () => keys.tavily ?? "",
    () => keys.anySearch ?? "",
  );
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.setRuntimeSettings.mockClear();
  clearWebSearchCache();
});

describe("web_search native 轨", () => {
  it("native 可用：实时下发引擎/key，透传结果，看门狗 25s", async () => {
    configure("bocha", { bocha: "bocha-key-1" });
    nativeMocks.nativeResult = '{"success":true,"query":"上海天气"}';

    const out = await webSearchTool.execute({ query: "上海天气" }, undefined);

    expect(out).toBe('{"success":true,"query":"上海天气"}');
    expect(nativeMocks.setRuntimeSettings).toHaveBeenCalledWith({
      webSearch: { engine: "bocha", bochaKey: "bocha-key-1", tavilyKey: "", anySearchKey: "" },
    });
    expect(nativeMocks.calls).toEqual([
      {
        tool: "web_search",
        args: { query: "上海天气" },
        options: { timeoutMs: 25_000, signal: undefined },
      },
    ]);
  });

  it("改设置后下一次调用下发新配置", async () => {
    configure("bocha", { bocha: "k1" });
    nativeMocks.nativeResult = "{}";
    await webSearchTool.execute({ query: "a" }, undefined);

    configure("tavily", { tavily: "k2" });
    nativeMocks.nativeResult = "{}";
    await webSearchTool.execute({ query: "b" }, undefined);

    expect(nativeMocks.setRuntimeSettings).toHaveBeenNthCalledWith(1, {
      webSearch: { engine: "bocha", bochaKey: "k1", tavilyKey: "", anySearchKey: "" },
    });
    expect(nativeMocks.setRuntimeSettings).toHaveBeenNthCalledWith(2, {
      webSearch: { engine: "tavily", bochaKey: "", tavilyKey: "k2", anySearchKey: "" },
    });
  });

  it("native 不可用时回退 TS 实现（off → E_SEARCH_NOT_ENABLED）", async () => {
    configure("off");
    await expect(webSearchTool.execute({ query: "x" }, undefined)).rejects.toThrow("E_SEARCH_NOT_ENABLED");
  });
});
