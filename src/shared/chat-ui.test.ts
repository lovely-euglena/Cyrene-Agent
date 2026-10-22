import { describe, expect, it } from "vitest";
import { conversationSortTimeKey, normalizeConversationSortMode } from "./chat-ui";

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
});
