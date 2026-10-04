import { describe, expect, it } from "vitest";
import { validateSyncEvent } from "../../main/sync/sync-protocol";
import { computeClock, createUserMessageEvent } from "./event-factory";
import { event } from "./test-helpers";

describe("computeClock", () => {
  it("lamport 取全设备最大；seq 只取本设备最大", () => {
    const events = [
      event({ type: "message.append", payload: {}, deviceId: "dev-a", lamport: 3, seq: 2 }),
      event({ type: "message.append", payload: {}, deviceId: "server", lamport: 7, seq: 5 }),
      event({ type: "message.append", payload: {}, deviceId: "dev-a", lamport: 5, seq: 4 }),
    ];
    expect(computeClock(events, "dev-a")).toEqual({ maxLamport: 7, maxSeq: 4 });
    expect(computeClock(events, "dev-b")).toEqual({ maxLamport: 7, maxSeq: 0 });
  });

  it("空事件流从 0 起步", () => {
    expect(computeClock([], "dev-a")).toEqual({ maxLamport: 0, maxSeq: 0 });
  });
});

describe("createUserMessageEvent", () => {
  it("构造合法事件（水位 +1、turnId 必填、ISO 毫秒 UTC）", () => {
    const created = createUserMessageEvent({
      sessionId: "s1",
      text: "来自手机",
      deviceId: "pwa-dev",
      clock: { maxLamport: 9, maxSeq: 4 },
      now: new Date("2026-10-04T08:00:00.123Z"),
      idFactory: () => "fixed-id",
    });
    expect(validateSyncEvent(created)).toBeNull();
    expect(created).toMatchObject({
      eventId: "pwa-fixed-id",
      sessionId: "s1",
      type: "message.append",
      lamport: 10,
      deviceId: "pwa-dev",
      seq: 5,
      ts: "2026-10-04T08:00:00.123Z",
    });
    expect(created.payload).toEqual({ role: "user", text: "来自手机", turnId: "turn-fixed-id" });
  });

  it("Unicode / 换行文本原样保留", () => {
    const text = "你好🌙\n第二行";
    const created = createUserMessageEvent({
      sessionId: "s1",
      text,
      deviceId: "pwa-dev",
      clock: { maxLamport: 0, maxSeq: 0 },
      idFactory: () => "u1",
    });
    expect(created.payload.text).toBe(text);
    expect(validateSyncEvent(created)).toBeNull();
  });

  it("默认 idFactory 产出唯一 eventId/turnId", () => {
    const make = () =>
      createUserMessageEvent({
        sessionId: "s1",
        text: "x",
        deviceId: "pwa-dev",
        clock: { maxLamport: 0, maxSeq: 0 },
      });
    const first = make();
    const second = make();
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.payload.turnId).not.toBe(second.payload.turnId);
  });
});
