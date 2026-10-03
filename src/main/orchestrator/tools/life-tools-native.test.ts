/**
 * life-tools native 轨接线测试（exchange_rate 首件）：
 *  - native 可用：走 ToolHost，调用前实时下发 dateLocale/timezone
 *  - native 不可用：静默回退 TS 实现（fetch 原路径），行为零差异
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  setRuntimeSettings: vi.fn(),
  nativeResult: null as string | null,
}));

vi.mock("./native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: nativeMocks.setRuntimeSettings },
  nativeFirst: async (tool: string, args: Record<string, unknown>, fallback: (a: Record<string, unknown>) => unknown) => {
    nativeMocks.calls.push({ tool, args });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    // 模拟真实 nativeFirst 的故障回退语义
    return fallback(args);
  },
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "Asia/Shanghai" }));

import { clearExchangeRateCache, registerLifeTools } from "./life-tools";

registerLifeTools();

function getTool(id: string) {
  const tool = registry.get(id) as
    | { execute: (args: Record<string, unknown>) => Promise<string> }
    | undefined;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.setRuntimeSettings.mockClear();
  clearExchangeRateCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exchange_rate native 轨", () => {
  it("native 可用时透传参数并实时下发 locale/时区", async () => {
    nativeMocks.nativeResult = "[exchange_rate] native 结果";
    const out = await getTool("exchange_rate").execute({ from: "USD", to: "CNY", amount: 100 });

    expect(out).toBe("[exchange_rate] native 结果");
    expect(nativeMocks.calls).toEqual([
      { tool: "exchange_rate", args: { from: "USD", to: "CNY", amount: 100 } },
    ]);
    expect(nativeMocks.setRuntimeSettings).toHaveBeenCalledWith({
      dateLocale: "zh-CN",
      timezone: "Asia/Shanghai",
    });
  });

  it("native 不可用时回退 TS 实现（fetch 原路径保留）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rates: { CNY: 7.12 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await getTool("exchange_rate").execute({ from: "USD", to: "CNY", amount: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toContain("100 USD = 712.00 CNY");
    expect(out).toContain("汇率 7.12");
  });
});
