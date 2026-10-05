// proactive 服务端转发（§5.4）：owner=server 时桌面不本机直发。
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendProactiveChannelMessage, type ProactiveOwnershipPort } from "./proactive-delivery";
import {
  ChannelOwnershipClient,
  setActiveOwnershipClient,
  normalizeChannelsRemoteConfig,
} from "./ownership";
import type { ChannelAdapter } from "./adapters/base";

function fakeAdapter(): ChannelAdapter {
  return {
    id: "wechat",
    displayName: "test",
    capability: {} as never,
    onMessage: null,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn(() => ({ enabled: true, phase: "running" as const })),
  };
}

function forwardingPort(overrides: Partial<ProactiveOwnershipPort> = {}): ProactiveOwnershipPort {
  return {
    shouldForwardProactive: () => true,
    deliverProactive: vi.fn(async () => ({ ok: true, delivered: true })),
    ...overrides,
  };
}

describe("proactive 服务端转发（§5.4）", () => {
  afterEach(() => {
    setActiveOwnershipClient(null);
  });

  it("owner=server：改调 /proactive 转发，不调用本机 adapter.send", async () => {
    const adapter = fakeAdapter();
    const ownership = forwardingPort();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      intentId: "intent-1",
      ownership,
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 1 });
    expect(ownership.deliverProactive).toHaveBeenCalledWith("wechat", { intentId: "intent-1", text: "第一句。第二句？" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("缺 intentId：拒绝转发（服务端幂等依赖）", async () => {
    const adapter = fakeAdapter();
    const ownership = forwardingPort();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "你好",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      ownership,
    });
    expect(result).toEqual({ kind: "cancelled", reason: "durable_intent_required" });
    expect(ownership.deliverProactive).not.toHaveBeenCalled();
  });

  it("服务端 delivered=false / 转发失败：记失败且不回退本机（避免双发）", async () => {
    const adapter = fakeAdapter();
    const failedDelivery = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "你好",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      intentId: "intent-1",
      ownership: forwardingPort({
        deliverProactive: vi.fn(async () => ({ ok: true, delivered: false, error: "E_CHANNEL_SEND_FAILED" })),
      }),
    });
    expect(failedDelivery).toEqual({ kind: "cancelled", reason: "E_CHANNEL_SEND_FAILED" });

    const unreachable = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "你好",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      intentId: "intent-1",
      ownership: forwardingPort({
        deliverProactive: vi.fn(async () => ({ ok: false, error: "unreachable" })),
      }),
    });
    expect(unreachable).toEqual({ kind: "cancelled", reason: "unreachable" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("服务端 duplicate 幂等确认：视为 committed，不重发", async () => {
    const adapter = fakeAdapter();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "你好",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      intentId: "intent-1",
      ownership: forwardingPort({
        deliverProactive: vi.fn(async () => ({ ok: true, delivered: true, duplicate: true })),
      }),
    });
    expect(result.kind).toBe("committed");
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("缺省取模块级 active client：owner=server 时自动转发", async () => {
    const config = normalizeChannelsRemoteConfig({ enabled: true, baseUrl: "https://cloud.example.com" });
    const client = new ChannelOwnershipClient({
      loadConfig: () => config,
      fetchImpl: (async (url: string | URL) => {
        if (String(url).endsWith("/v1/channels/ownership")) {
          return new Response(JSON.stringify({
            serverId: "s1",
            leaseTtlSeconds: 180,
            channels: { wechat: { owner: "server" } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ eventId: "proactive-e1", delivered: true }), { status: 200 });
      }) as unknown as typeof fetch,
      log: () => undefined,
    });
    await client.poll();
    setActiveOwnershipClient(client);

    const adapter = fakeAdapter();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "你好",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      intentId: "intent-1",
    });
    expect(result.kind).toBe("committed");
    expect(adapter.send).not.toHaveBeenCalled();
  });
});
