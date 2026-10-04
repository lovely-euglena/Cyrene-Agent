import { describe, expect, it } from "vitest";
import { canonicalSort, mergeEvents, ordinalCompare } from "./event-store";
import { event } from "./test-helpers";

describe("ordinalCompare", () => {
  it("按 UTF-16 码元序比较", () => {
    expect(ordinalCompare("a", "b")).toBe(-1);
    expect(ordinalCompare("b", "a")).toBe(1);
    expect(ordinalCompare("a", "a")).toBe(0);
    expect(ordinalCompare("Z", "a")).toBe(-1); // 'Z'(0x5A) < 'a'(0x61)
  });
});

describe("canonicalSort", () => {
  it("按 (lamport, deviceId, seq) 排序", () => {
    const input = [
      event({ type: "message.append", payload: {}, eventId: "c", lamport: 2, deviceId: "dev-a", seq: 1 }),
      event({ type: "message.append", payload: {}, eventId: "a", lamport: 1, deviceId: "dev-b", seq: 9 }),
      event({ type: "message.append", payload: {}, eventId: "b", lamport: 1, deviceId: "dev-a", seq: 5 }),
    ];
    expect(canonicalSort(input).map((item) => item.eventId)).toEqual(["b", "a", "c"]);
  });

  it("全同键保持输入序（稳定排序）", () => {
    const input = [
      event({ type: "message.append", payload: {}, eventId: "x", lamport: 1, deviceId: "d", seq: 1 }),
      event({ type: "message.append", payload: {}, eventId: "y", lamport: 1, deviceId: "d", seq: 1 }),
    ];
    expect(canonicalSort(input).map((item) => item.eventId)).toEqual(["x", "y"]);
  });
});

describe("mergeEvents", () => {
  it("eventId 幂等（已有优先）并按规范序合并", () => {
    const existing = [event({ type: "message.append", payload: {}, eventId: "e1", lamport: 1 })];
    const incoming = [
      event({ type: "message.append", payload: {}, eventId: "e1", lamport: 1, deviceId: "other" }),
      event({ type: "message.append", payload: {}, eventId: "e2", lamport: 2 }),
    ];
    const merged = mergeEvents(existing, incoming);
    expect(merged.map((item) => item.eventId)).toEqual(["e1", "e2"]);
    expect(merged[0].deviceId).toBe("dev-a"); // 已有的事件不被覆盖
  });

  it("不修改入参", () => {
    const existing = [event({ type: "message.append", payload: {}, eventId: "e1", lamport: 2 })];
    const snapshot = [...existing];
    mergeEvents(existing, [event({ type: "message.append", payload: {}, eventId: "e2", lamport: 1 })]);
    expect(existing).toEqual(snapshot);
  });
});
