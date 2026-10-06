/**
 * calculator / now native 轨接线测试（#IKJLP2 只读轻量隔离锁定）：
 *  - 两者经 nativeFirst 透传 abandonOnTimeout: true（超时轻量隔离）；
 *  - now 调用前实时下发时区（既有行为顺带锁定，防漏接线回归）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: { signal?: AbortSignal; abandonOnTimeout?: boolean } }>,
  nativeResult: null as string | null,
  setTimezone: vi.fn(),
}));

vi.mock("../native-tool-host", () => ({
  nativeToolHost: { setTimezone: nativeMocks.setTimezone },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: { signal?: AbortSignal; abandonOnTimeout?: boolean },
  ) => {
    nativeMocks.calls.push({ tool, args, options });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    return fallback(args);
  },
}));

import { calculatorTool, nowTool, setUtilityTimezoneConfig } from "./utility-tools";

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.setTimezone.mockClear();
  setUtilityTimezoneConfig(() => "Asia/Shanghai");
});

describe("calculator/now native 轨轻量隔离接线（#IKJLP2）", () => {
  it("calculator：透传 abandonOnTimeout: true", async () => {
    nativeMocks.nativeResult = "1+1 = 2";
    const out = await calculatorTool.execute({ expression: "1+1" }, {} as never);

    expect(out).toBe("1+1 = 2");
    expect(nativeMocks.calls).toEqual([
      { tool: "calculator", args: { expression: "1+1" }, options: { signal: undefined, abandonOnTimeout: true } },
    ]);
  });

  it("now：透传 abandonOnTimeout: true 并实时下发时区", async () => {
    nativeMocks.nativeResult = "2026-10-06 星期一（时区 Asia/Shanghai）";
    const out = await nowTool.execute({}, {} as never);

    expect(out).toBe("2026-10-06 星期一（时区 Asia/Shanghai）");
    expect(nativeMocks.calls).toEqual([
      { tool: "now", args: {}, options: { signal: undefined, abandonOnTimeout: true } },
    ]);
    expect(nativeMocks.setTimezone).toHaveBeenCalledWith("Asia/Shanghai");
  });
});
