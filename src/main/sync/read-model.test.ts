/**
 * 合并读模型契约测试（IKJK2I §5.2）：gating 零变化 / 合并排序 / 去重 /
 * 远端 rewind+墓碑 / 空文本 assistant 跳过。
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRole, ChatSession } from "../../shared/chat-types";
import { createRemoteMergeProvider, type RemoteMergeSource } from "./read-model";
import type { SyncEventV0 } from "./sync-protocol";

let counter = 0;

function event(draft: {
  type: SyncEventV0["type"];
  payload: Record<string, unknown>;
  eventId: string;
  at: number;
}): SyncEventV0 {
  counter++;
  return {
    eventId: draft.eventId,
    sessionId: "s1",
    type: draft.type,
    lamport: counter,
    deviceId: "dev-b",
    seq: counter,
    ts: new Date(draft.at).toISOString(),
    payload: draft.payload,
  };
}

function messageEvent(role: "user" | "assistant", text: string, turnId: string, eventId: string, at: number): SyncEventV0 {
  return event({ type: "message.append", payload: { role, text, turnId }, eventId, at });
}

function makeSession(messages: ChatMessage[], overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "会话",
    identityId: null,
    messages,
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function localMessage(id: string, role: ChatRole, content: string, at: number): ChatMessage {
  return { id, role, content, at };
}

function makeSource(events: SyncEventV0[], enabled = true): RemoteMergeSource & { getRemoteSessionEvents: ReturnType<typeof vi.fn> } {
  return {
    isEnabled: () => enabled,
    getRemoteSessionEvents: vi.fn(async () => events),
  };
}

describe("createRemoteMergeProvider", () => {
  it("source 为空 → provider 为 null", () => {
    expect(createRemoteMergeProvider(null)).toBeNull();
  });

  it("同步未启用 → 原样返回且不读 inbox", async () => {
    const source = makeSource([messageEvent("user", "远端", "t1", "r1", 1000)], false);
    const provider = createRemoteMergeProvider(source)!;
    const session = makeSession([localMessage("u1", "user", "本地", 500)]);
    await expect(provider(session)).resolves.toBe(session);
    expect(source.getRemoteSessionEvents).not.toHaveBeenCalled();
  });

  it("启用但无远端事件 → 原样返回", async () => {
    const source = makeSource([]);
    const provider = createRemoteMergeProvider(source)!;
    const session = makeSession([localMessage("u1", "user", "本地", 500)]);
    await expect(provider(session)).resolves.toBe(session);
    expect(source.getRemoteSessionEvents).toHaveBeenCalledWith("s1");
  });

  it("合并排序：本地原序保持，远端按 ts 插入并映射为最小 ChatMessage", async () => {
    const events = [
      messageEvent("user", "远端问题", "t9", "ru1", 2000),
      messageEvent("assistant", "远端回答", "t9", "ra1", 2500),
    ];
    const provider = createRemoteMergeProvider(makeSource(events))!;
    const session = makeSession([
      localMessage("u-local", "user", "本地问题", 1000),
      localMessage("a-local", "model", "本地回答", 3000),
    ]);

    const merged = await provider(session);
    expect(merged).not.toBe(session);
    expect(merged.messages.map((message) => message.id)).toEqual(["u-local", "ru1", "ra1", "a-local"]);
    expect(merged.messages[1]).toEqual({ id: "ru1", role: "user", content: "远端问题", at: 2000 });
    expect(merged.messages[2]).toEqual({ id: "ra1", role: "model", content: "远端回答", at: 2500 });
    // 不可变：原会话消息数组不受影响
    expect(session.messages.map((message) => message.id)).toEqual(["u-local", "a-local"]);
  });

  it("去重：eventId 已存在于本地消息时跳过远端副本", async () => {
    const events = [
      messageEvent("user", "重复", "t1", "dup", 500),
      messageEvent("user", "新消息", "t2", "new", 1500),
    ];
    const provider = createRemoteMergeProvider(makeSource(events))!;
    const session = makeSession([localMessage("dup", "user", "本地权威", 1000)]);

    const merged = await provider(session);
    expect(merged.messages.map((message) => message.id)).toEqual(["dup", "new"]);
    expect(merged.messages[0].content).toBe("本地权威");
  });

  it("远端 keep_user rewind + 墓碑：先重放出活动分支再合并", async () => {
    const events = [
      messageEvent("user", "问题", "t1", "ru1", 1000),
      messageEvent("assistant", "旧答", "t1", "ra1", 1500),
      messageEvent("user", "撤回", "t2", "ru2", 2000),
      messageEvent("assistant", "撤回答", "t2", "ra2", 2500),
      event({ type: "tombstone", payload: { targetUserTurnId: "t2", reason: "pending_withdrawn" }, eventId: "rx1", at: 3000 }),
      event({
        type: "turn_rewind",
        payload: { anchorUserTurnId: "t1", disposition: "keep_user", reason: "regenerate" },
        eventId: "rr1",
        at: 3500,
      }),
      messageEvent("assistant", "新答", "t1", "ra1b", 4000),
    ];
    const provider = createRemoteMergeProvider(makeSource(events))!;
    const session = makeSession([localMessage("local1", "user", "本地", 5000)]);

    const merged = await provider(session);
    // t2 轮被墓碑移除；t1 锚点 eventId/ts 指向 rewind 事件
    expect(merged.messages.map((message) => message.id)).toEqual(["rr1", "ra1b", "local1"]);
    expect(merged.messages[0]).toMatchObject({ role: "user", content: "问题", at: 3500 });
    expect(merged.messages[1]).toMatchObject({ role: "model", content: "新答", at: 4000 });
  });

  it("远端 replace_user rewind：锚点换文本且其后截断", async () => {
    const events = [
      messageEvent("user", "原问", "t1", "ru1", 1000),
      messageEvent("assistant", "旧答", "t1", "ra1", 1500),
      event({
        type: "turn_rewind",
        payload: {
          anchorUserTurnId: "t1",
          disposition: "replace_user",
          reason: "edit",
          replacementUser: { text: "改后" },
          revision: 2,
        },
        eventId: "rr1",
        at: 2000,
      }),
    ];
    const provider = createRemoteMergeProvider(makeSource(events))!;
    const merged = await provider(makeSession([]));

    expect(merged.messages).toEqual([{ id: "rr1", role: "user", content: "改后", at: 2000 }]);
  });

  it("空文本 assistant 跳过（user 保留）", async () => {
    const events = [
      messageEvent("user", "问", "t1", "ru1", 1000),
      messageEvent("assistant", "", "t1", "ra1", 1100),
      messageEvent("assistant", "   ", "t1", "ra2", 1200),
      messageEvent("assistant", "答", "t1", "ra3", 1300),
    ];
    const provider = createRemoteMergeProvider(makeSource(events))!;
    const merged = await provider(makeSession([]));

    expect(merged.messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ["ru1", "user", "问"],
      ["ra3", "model", "答"],
    ]);
  });
});
