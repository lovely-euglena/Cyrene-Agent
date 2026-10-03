/**
 * life-tools native 轨接线测试（exchange_rate 首件）：
 *  - native 可用：走 ToolHost，调用前实时下发 dateLocale/timezone
 *  - native 不可用：静默回退 TS 实现（fetch 原路径），行为零差异
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: { timeoutMs?: number } }>,
  setRuntimeSettings: vi.fn(),
  nativeResult: null as string | null,
}));

vi.mock("./native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: nativeMocks.setRuntimeSettings },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: { timeoutMs?: number },
  ) => {
    nativeMocks.calls.push({ tool, args, options });
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
  it("native 可用时透传参数、按件看门狗覆盖默认 5s 并实时下发 locale/时区", async () => {
    nativeMocks.nativeResult = "[exchange_rate] native 结果";
    const out = await getTool("exchange_rate").execute({ from: "USD", to: "CNY", amount: 100 });

    expect(out).toBe("[exchange_rate] native 结果");
    expect(nativeMocks.calls).toEqual([
      {
        tool: "exchange_rate",
        args: { from: "USD", to: "CNY", amount: 100 },
        options: { timeoutMs: 65_000 },
      },
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

describe("expense native 轨", () => {
  it("record_expense：native 可用时透传参数", async () => {
    nativeMocks.nativeResult = "[record_expense] 已记录：12.5 元 / 餐饮 / 午饭";
    const out = await getTool("record_expense").execute({ amount: 12.5, category: "餐饮", note: "午饭" });

    expect(out).toBe("[record_expense] 已记录：12.5 元 / 餐饮 / 午饭");
    expect(nativeMocks.calls).toEqual([
      { tool: "record_expense", args: { amount: 12.5, category: "餐饮", note: "午饭" } },
    ]);
  });

  it("query_expense：native 可用时透传参数并实时下发 locale/时区", async () => {
    nativeMocks.nativeResult = "[query_expense] 最近 30 天共 2 笔，合计 53.00 元";
    const out = await getTool("query_expense").execute({ days: 30, summary: true });

    expect(out).toContain("合计 53.00 元");
    expect(nativeMocks.calls).toEqual([
      { tool: "query_expense", args: { days: 30, summary: true } },
    ]);
    expect(nativeMocks.setRuntimeSettings).toHaveBeenCalledWith({
      dateLocale: "zh-CN",
      timezone: "Asia/Shanghai",
    });
  });
});
