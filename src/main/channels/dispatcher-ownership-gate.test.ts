// dispatcher 归属处理门闩（§5.6 第二道防线）：owner≠desktop 时直接丢弃。
import { expect, it, vi } from "vitest";
import { ChannelDispatcher } from "./dispatcher";
import { createKeyedQueue } from "./keyed-queue";
import { createChannelRateLimiter } from "./rate-limiter";
import { createChannelContext } from "./channel-context";
import { setChannelProcessGate, shouldProcessChannel } from "./ownership";
import type { ChannelsSettings } from "./settings-store";

it("dispatcher 处理门闩：owner≠desktop 时直接丢弃（不写 journal/不调用 agent）", async () => {
  const appendUser = vi.fn(async (_conversationId: string, input: { id?: string }) => ({ id: input.id ?? "u1" }));
  const buildAndRunAgent = vi.fn();
  const dispatcher = new ChannelDispatcher({
    queue: createKeyedQueue({ maxPendingPerKey: 20 }),
    limiter: createChannelRateLimiter({ limits: { perUser: 10, perChannel: 100 } }),
    context: createChannelContext({ migrateHistory: vi.fn() }),
    journal: {
      appendUser,
      appendPresentation: vi.fn(async () => undefined),
      buildModelContext: vi.fn(async () => ({ messages: [], uncertainEffects: [], throughSeq: 0 })),
      createRunSink: vi.fn(),
      appendDeliveryReceipt: vi.fn(async () => undefined),
    },
    composer: { compose: vi.fn(), cleanupTransientFiles: vi.fn(async () => undefined) },
    delivery: { send: vi.fn(async () => ({ ok: true })) },
    buildAndRunAgent,
    loadSettings: () => ({
      rateLimitPerUser: 10,
      rateLimitPerChannel: 100,
      ttsEnabled: true,
      stickerEnabled: true,
      mirrorToDesktop: true,
    } as ChannelsSettings),
    loadGeneralSettings: () => ({}),
  });

  setChannelProcessGate(() => false);
  try {
    const result = await dispatcher.handleIncoming({
      channel: "wechat",
      senderId: "u1",
      chatId: "u1",
      text: "云端托管中",
      at: new Date(),
    });
    expect(result).toBeNull();
    expect(appendUser).not.toHaveBeenCalled();
    expect(buildAndRunAgent).not.toHaveBeenCalled();
    expect(shouldProcessChannel("wechat")).toBe(false);
  } finally {
    setChannelProcessGate(null);
  }
  expect(shouldProcessChannel("wechat")).toBe(true);
});
