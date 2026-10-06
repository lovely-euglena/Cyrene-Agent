import { describe, expect, it } from "vitest";
import { groupTurns, replaySession, summarizeSessions } from "./materializer";
import { assistantMessage, event, userMessage } from "./test-helpers";

describe("replaySession", () => {
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
});

describe("groupTurns", () => {
  it("user 开轮、assistant 挂当前轮；孤立 assistant 忽略", () => {
    const events = [
      assistantMessage("孤儿", undefined, { eventId: "a0" }),
      userMessage("问", "t1", { eventId: "u1" }),
      assistantMessage("答1", "t1", { eventId: "a1" }),
      assistantMessage("答2", "t1", { eventId: "a2" }),
      userMessage("问2", "t2", { eventId: "u2" }),
    ];
    const turns = groupTurns(replaySession(events));
    expect(turns).toHaveLength(2);
    expect(turns[0].assistants.map((item) => item.text)).toEqual(["答1", "答2"]);
    expect(turns[1].assistants).toEqual([]);
  });
});

describe("summarizeSessions", () => {
  it("标题/预览/最近活动排序", () => {
    const events = [
      event({ type: "session.create", payload: { title: "会话甲", createdAt: "2026-10-04T01:00:00.000Z" }, sessionId: "s1" }),
      userMessage("甲的消息", "t1", { sessionId: "s1", eventId: "u1", ts: "2026-10-04T01:01:00.000Z" }),
      event({ type: "session.create", payload: { title: "会话乙", createdAt: "2026-10-04T02:00:00.000Z" }, sessionId: "s2" }),
      userMessage("乙的消息", "t2", { sessionId: "s2", eventId: "u2", ts: "2026-10-04T02:01:00.000Z" }),
    ];
    const summaries = summarizeSessions(events);
    expect(summaries.map((item) => item.sessionId)).toEqual(["s2", "s1"]);
    expect(summaries[0]).toMatchObject({ title: "会话乙", preview: "乙的消息", messageCount: 1 });
  });

  it("无标题回退、空会话取 createdAt", () => {
    const events = [
      event({ type: "session.create", payload: { title: "", createdAt: "2026-10-04T03:00:00.000Z" }, sessionId: "abcdef123456" }),
    ];
    const [summary] = summarizeSessions(events);
    expect(summary.title).toBe("会话 abcdef12");
    expect(summary.preview).toBe("");
    expect(summary.lastTs).toBe("2026-10-04T03:00:00.000Z");
  });

  it("过滤保留命名空间：__memory__ / __mood__ 不产出伪会话，正常会话不受影响", () => {
    const events = [
      event({ type: "session.create", payload: { title: "会话甲", createdAt: "2026-10-04T01:00:00.000Z" }, sessionId: "s1" }),
      userMessage("甲的消息", "t1", { sessionId: "s1", eventId: "u1", ts: "2026-10-04T01:01:00.000Z" }),
      event({
        type: "memory.write",
        payload: { memoryId: "m1", op: "upsert", content: "记忆内容", weight: 50 },
        sessionId: "__memory__",
        eventId: "mem1",
        ts: "2026-10-04T02:00:00.000Z",
      }),
      event({
        type: "mood.shift",
        payload: { feeling: "开心" },
        sessionId: "__mood__",
        eventId: "mood1",
        ts: "2026-10-04T02:01:00.000Z",
      }),
    ];
    const summaries = summarizeSessions(events);
    expect(summaries.map((item) => item.sessionId)).toEqual(["s1"]);
    expect(summaries[0]).toMatchObject({ title: "会话甲", preview: "甲的消息", messageCount: 1 });
  });

  it("仅保留命名空间事件 → 空会话列表", () => {
    const events = [
      event({ type: "memory.write", payload: { memoryId: "m1", op: "delete" }, sessionId: "__memory__", eventId: "mem1" }),
      event({ type: "mood.shift", payload: { feeling: "温柔" }, sessionId: "__mood__", eventId: "mood1" }),
    ];
    expect(summarizeSessions(events)).toEqual([]);
  });
});
