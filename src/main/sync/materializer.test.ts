/**
 * 共享重放核心契约测试（IKJK2I §5.1）：镜像 PWA materializer 用例，
 * 锁定桌面与 PWA 共用同一 replaySession 语义（不回归）。
 */

import { describe, expect, it } from "vitest";
import { replaySession } from "./materializer";
import type { SyncEventV0 } from "./sync-protocol";

let counter = 0;

function event(draft: {
  type: SyncEventV0["type"];
  payload: Record<string, unknown>;
  eventId?: string;
  ts?: string;
}): SyncEventV0 {
  counter++;
  return {
    eventId: draft.eventId ?? `e${counter}`,
    sessionId: "s1",
    type: draft.type,
    lamport: counter,
    deviceId: "dev-a",
    seq: counter,
    ts: draft.ts ?? `2026-10-04T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    payload: draft.payload,
  };
}

function userMessage(text: string, turnId: string, overrides: { eventId?: string } = {}): SyncEventV0 {
  return event({ type: "message.append", payload: { role: "user", text, turnId }, ...overrides });
}

function assistantMessage(text: string, turnId?: string, overrides: { eventId?: string } = {}): SyncEventV0 {
  const payload: Record<string, unknown> = { role: "assistant", text };
  if (turnId !== undefined) payload.turnId = turnId;
  return event({ type: "message.append", payload, ...overrides });
}

describe("replaySession（共享核心）", () => {
  it("追加 user/assistant 消息（含 turnId 关联）", () => {
    const events = [
      userMessage("你好", "t1", { eventId: "u1" }),
      assistantMessage("你好呀", "t1", { eventId: "a1" }),
    ];
    const messages = replaySession(events);
    expect(messages.map((item) => [item.role, item.text])).toEqual([
      ["user", "你好"],
      ["assistant", "你好呀"],
    ]);
  });

  it("keep_user 重生成：保留锚点 user，裁掉其后全部", () => {
    const events = [
      userMessage("第一问", "t1", { eventId: "u1" }),
      assistantMessage("旧回答", "t1", { eventId: "a1" }),
      userMessage("第二问", "t2", { eventId: "u2" }),
      assistantMessage("第二答", "t2", { eventId: "a2" }),
      event({
        type: "turn_rewind",
        payload: { anchorUserTurnId: "t1", disposition: "keep_user", reason: "regenerate" },
        eventId: "r1",
      }),
      assistantMessage("新回答", "t1", { eventId: "a1b" }),
    ];
    const messages = replaySession(events);
    expect(messages.map((item) => [item.role, item.text])).toEqual([
      ["user", "第一问"],
      ["assistant", "新回答"],
    ]);
    // 锚点 user 的 eventId 指向 rewind 事件（与服务端 BranchMessage 语义一致）
    expect(messages[0].eventId).toBe("r1");
  });

  it("replace_user 编辑：锚点换文本并裁掉其后", () => {
    const events = [
      userMessage("原始问题", "t1", { eventId: "u1" }),
      assistantMessage("旧回答", "t1", { eventId: "a1" }),
      event({
        type: "turn_rewind",
        payload: {
          anchorUserTurnId: "t1",
          disposition: "replace_user",
          reason: "edit",
          replacementUser: { text: "修改后的问题" },
          revision: 2,
        },
        eventId: "r1",
      }),
    ];
    const messages = replaySession(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "修改后的问题", turnId: "t1", eventId: "r1" });
  });

  it("tombstone：移除目标轮（user + 紧随 assistant）", () => {
    const events = [
      userMessage("保留", "t1", { eventId: "u1" }),
      assistantMessage("保留答", "t1", { eventId: "a1" }),
      userMessage("撤回", "t2", { eventId: "u2" }),
      assistantMessage("撤回答", "t2", { eventId: "a2" }),
      event({ type: "tombstone", payload: { targetUserTurnId: "t2", reason: "pending_withdrawn" }, eventId: "x1" }),
    ];
    const messages = replaySession(events);
    expect(messages.map((item) => item.text)).toEqual(["保留", "保留答"]);
  });

  it("未知锚点 / 未知目标：no-op", () => {
    const events = [
      userMessage("你好", "t1", { eventId: "u1" }),
      event({ type: "turn_rewind", payload: { anchorUserTurnId: "nope", disposition: "keep_user", reason: "regenerate" }, eventId: "r1" }),
      event({ type: "tombstone", payload: { targetUserTurnId: "nope", reason: "pending_withdrawn" }, eventId: "x1" }),
    ];
    expect(replaySession(events).map((item) => item.text)).toEqual(["你好"]);
  });

  it("session.create 不进消息流", () => {
    const events = [event({ type: "session.create", payload: { title: "标题", createdAt: "2026-10-04T00:00:00.000Z" } })];
    expect(replaySession(events)).toEqual([]);
  });

  it("孤立 assistant（无 user 前置）保留在扁平流中且不占锚点", () => {
    const events = [
      assistantMessage("孤儿", undefined, { eventId: "a0" }),
      userMessage("问", "t1", { eventId: "u1" }),
      assistantMessage("答", "t1", { eventId: "a1" }),
    ];
    const messages = replaySession(events);
    expect(messages.map((item) => [item.role, item.text, item.turnId])).toEqual([
      ["assistant", "孤儿", ""],
      ["user", "问", "t1"],
      ["assistant", "答", "t1"],
    ]);
  });
});
