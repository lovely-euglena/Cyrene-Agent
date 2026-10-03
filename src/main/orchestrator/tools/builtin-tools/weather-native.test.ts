/**
 * weather native 轨接线测试（IKJK3V T1 剩余）：
 *  - native 可用：调用前实时下发 weather 配置（默认城市/源/key/语言），透传结果
 *  - 卡片事件：onEvent(weather_card) → weatherCardCallback(payload, context)
 *  - 卡片去重：native 已发卡后回退，共享标记不二次发卡（防看门狗边界双卡）
 *  - native 不可用：回退 TS 实现（未启用/无城市等确定性文案）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry/tool-context";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; options?: Record<string, unknown> }>,
  setRuntimeSettings: vi.fn(),
  nativeResult: null as string | null,
  nativeEmit: null as { kind: string; payload: unknown } | null,
}));

vi.mock("../native-tool-host", () => ({
  nativeToolHost: { setRuntimeSettings: nativeMocks.setRuntimeSettings },
  nativeFirst: async (
    tool: string,
    args: Record<string, unknown>,
    fallback: (a: Record<string, unknown>) => unknown,
    options?: Record<string, unknown>,
  ) => {
    nativeMocks.calls.push({ tool, args, options });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    if (nativeMocks.nativeEmit) {
      (options?.onEvent as ((e: { kind: string; payload: unknown }) => void) | undefined)?.(nativeMocks.nativeEmit);
    }
    return fallback(args);
  },
}));

import { clearWeatherCaches, setWeatherConfig, weatherTool } from "./weather-tool";

function context(): ToolContext {
  return { userQuery: "今天天气", conversationId: "s1", mode: "work" };
}

/** 构造 fetch Response 形状的桩（与 weather-tool.test.ts 同） */
function makeResp(json: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => json } as unknown as Response;
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.nativeEmit = null;
  nativeMocks.setRuntimeSettings.mockClear();
  clearWeatherCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("weather native 轨", () => {
  it("native 可用：下发 weather 配置 + 看门狗 40s + onEvent 接线", async () => {
    const cardCb = vi.fn();
    setWeatherConfig(() => "北京", () => "open-meteo", () => "", cardCb, () => true);
    nativeMocks.nativeResult = '{"city":"北京"}';

    const out = await weatherTool.execute({}, context());

    expect(out).toBe('{"city":"北京"}');
    expect(nativeMocks.setRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
      weather: { city: "北京", source: "open-meteo", amapKey: "", enabled: true, language: expect.any(String) },
    }));
    expect(nativeMocks.calls).toHaveLength(1);
    const call = nativeMocks.calls[0];
    expect(call.tool).toBe("weather");
    expect(call.args).toEqual({});
    const options = call.options as { timeoutMs: number; signal?: AbortSignal; onEvent?: (e: { kind: string; payload: unknown }) => void };
    expect(options.timeoutMs).toBe(40_000);
    expect(typeof options.onEvent).toBe("function");

    // 卡片事件路由：weather_card → weatherCardCallback(payload, context)
    const payload = { source: "open-meteo", location: { province: "北京市", city: "北京" }, temp: 20 };
    options.onEvent!({ kind: "weather_card", payload });
    expect(cardCb).toHaveBeenCalledTimes(1);
    expect(cardCb).toHaveBeenCalledWith(payload, expect.objectContaining({ conversationId: "s1" }));

    // 非 weather_card 事件不触发
    options.onEvent!({ kind: "other", payload: {} });
    expect(cardCb).toHaveBeenCalledTimes(1);
  });

  it("native 不可用：回退 TS（未启用 → 同文案）", async () => {
    setWeatherConfig(() => "北京", () => "open-meteo", () => "", undefined, () => false);
    const out = await weatherTool.execute({}, context());
    expect(out).toBe("[错误] 天气查询功能未启用，请在设置里开启");
  });

  it("未传城市且无默认城市：回退 TS 提示文案", async () => {
    setWeatherConfig(() => "", () => "open-meteo", () => "");
    const out = await weatherTool.execute({}, context());
    expect(out).toContain("没有指定城市");
  });

  it("native 已发卡后回退：共享去重标记，卡片只发一次", async () => {
    const cardCb = vi.fn();
    setWeatherConfig(() => "上海", () => "open-meteo", () => "", cardCb, () => true);
    // native 轨先经事件帧发卡，随后调用失败回退；回退成功拉到数据也不得二次发卡
    const nativePayload = { source: "open-meteo", location: { province: "上海市", city: "上海" }, temp: 20 };
    nativeMocks.nativeEmit = { kind: "weather_card", payload: nativePayload };
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("geocoding-api")) {
        return makeResp({ results: [{ name: "上海", latitude: 31.23, longitude: 121.47, country: "中国", admin1: "上海市" }] });
      }
      return makeResp({
        current: {
          temperature_2m: 22.5, relative_humidity_2m: 60, apparent_temperature: 21.8,
          precipitation: 0, weather_code: 1, wind_speed_10m: 12, wind_direction_10m: 135,
          surface_pressure: 1013, uv_index: 3, visibility: 10000,
        },
        daily: {
          time: ["2026-10-04"], temperature_2m_max: [26], temperature_2m_min: [18],
          weather_code: [1], wind_speed_10m_max: [15], wind_direction_10m_dominant: [135],
        },
      });
    }));

    const out = await weatherTool.execute({}, context());

    expect(JSON.parse(out)).toMatchObject({ city: "上海" });
    expect(cardCb).toHaveBeenCalledTimes(1);
    expect(cardCb).toHaveBeenCalledWith(nativePayload, expect.objectContaining({ conversationId: "s1" }));
  });
});
