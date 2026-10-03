/**
 * plan_trip native 轨接线测试（IKJK3V T1 剩余）：
 *  - native 可用：调用前实时下发 travel 配置（高德 key/enabled），透传结果
 *  - native 不可用：回退 TS 实现（未配置 key / 未启用 的确定性文案）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: Record<string, unknown> }>,
  setRuntimeSettings: vi.fn(),
  nativeResult: null as string | null,
}));

vi.mock("./native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: nativeMocks.setRuntimeSettings },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: Record<string, unknown>,
  ) => {
    nativeMocks.calls.push({ tool, args, options });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    return fallback(args);
  },
}));

const registry = new Map<string, { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<string> }>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: { id: string }) => void registry.set(tool.id, tool as never),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LogTag: { TravelTools: "TravelTools" },
}));

import { registerTravelTools, setTravelConfig } from "./travel-tools";

registerTravelTools();

function getTool() {
  const tool = registry.get("plan_trip");
  if (!tool) throw new Error("plan_trip 未注册");
  return tool;
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.setRuntimeSettings.mockClear();
});

describe("plan_trip native 轨", () => {
  it("native 可用：下发 travel 配置 + 看门狗 50s", async () => {
    setTravelConfig(() => "amap-key-1", () => true);
    nativeMocks.nativeResult = "🚗 驾车路线";

    const out = await getTool().execute({ origin: "故宫", destination: "天安门" });

    expect(out).toBe("🚗 驾车路线");
    expect(nativeMocks.setRuntimeSettings).toHaveBeenCalledWith({
      travel: { amapKey: "amap-key-1", enabled: true },
    });
    expect(nativeMocks.calls).toEqual([
      {
        tool: "plan_trip",
        args: { origin: "故宫", destination: "天安门" },
        options: { timeoutMs: 50_000, signal: undefined },
      },
    ]);
  });

  it("native 不可用：回退 TS（无 key → 同文案）", async () => {
    setTravelConfig(() => "");
    const out = await getTool().execute({ origin: "A", destination: "B" });
    expect(out).toBe("[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。");
  });

  it("未启用：回退 TS 同文案", async () => {
    setTravelConfig(() => "k", () => false);
    const out = await getTool().execute({ origin: "A", destination: "B" });
    expect(out).toBe("[错误] 出行工具未启用，请在设置里开启");
  });
});
