import { describe, expect, it } from "vitest";
import { conversationSortTimeKey, conversationTimeBucket, normalizeConversationSortMode } from "./chat-ui";

describe("conversationSortTimeKey（#194 排序口径）", () => {
  const meta = { lastOpenedAt: 2000, updatedAt: 1000 };

  it("last-opened 口径用 lastOpenedAt（打开就算）", () => {
    expect(conversationSortTimeKey(meta, "last-opened")).toBe(2000);
  });

  it("last-message 口径用 updatedAt（发消息才算，旧行为）", () => {
    expect(conversationSortTimeKey(meta, "last-message")).toBe(1000);
  });

  it("旧会话无 lastOpenedAt 回落 updatedAt", () => {
    expect(conversationSortTimeKey({ updatedAt: 1000 }, "last-opened")).toBe(1000);
  });

  it("normalizeConversationSortMode 非法值回落 last-opened", () => {
    expect(normalizeConversationSortMode("last-message")).toBe("last-message");
    expect(normalizeConversationSortMode("last-opened")).toBe("last-opened");
    expect(normalizeConversationSortMode("bogus")).toBe("last-opened");
    expect(normalizeConversationSortMode(undefined)).toBe("last-opened");
  });

describe("conversationTimeBucket（#196 时间分桶）", () => {
  // 固定"现在"= 2026-10-22 15:00 本地时间，排除真实时钟干扰
  const now = (() => { const d = new Date("2026-10-22T15:00:00"); return d.getTime(); })();
  const at = (iso: string): number => new Date(iso).getTime();

  it("今天（同自然日，凌晨也算今天）", () => {
    expect(conversationTimeBucket(at("2026-10-22T00:01:00"), now)).toBe("today");
    expect(conversationTimeBucket(at("2026-10-22T14:59:00"), now)).toBe("today");
  });

  it("昨天（跨自然日即归昨天，哪怕不足 24h）", () => {
    expect(conversationTimeBucket(at("2026-10-21T23:59:00"), now)).toBe("yesterday");
    expect(conversationTimeBucket(at("2026-10-21T00:00:00"), now)).toBe("yesterday");
  });

  it("最近 7 天（2-7 天前）", () => {
    expect(conversationTimeBucket(at("2026-10-20T23:00:00"), now)).toBe("last7");
    expect(conversationTimeBucket(at("2026-10-16T00:00:00"), now)).toBe("last7");
  });

  it("更早（≥7 自然日前）", () => {
    // today0 - 7d = 10-15T00:00，故 10-15 全天在 last7；10-14 起为 older
    expect(conversationTimeBucket(at("2026-10-14T23:59:00"), now)).toBe("older");
    expect(conversationTimeBucket(at("2026-01-01T00:00:00"), now)).toBe("older");
  });
});
});
