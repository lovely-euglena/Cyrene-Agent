import { describe, expect, it } from "vitest";
import { parseHeadlessScheduledArgs } from "./headless-args";

describe("parseHeadlessScheduledArgs（IKJK51 headless 参数）", () => {
  it("解析任务 id（必填）", () => {
    expect(parseHeadlessScheduledArgs(["Cyrene.exe", "--scheduled-task", "task-1"])).toEqual({
      taskId: "task-1",
      historyId: undefined,
      fireAt: undefined,
    });
  });

  it("解析 historyId / fireAt（托盘预建历史与计划触发时刻）", () => {
    expect(parseHeadlessScheduledArgs([
      "Cyrene.exe",
      "--scheduled-task", "t1",
      "--scheduled-history", "hist-1",
      "--scheduled-fire-at", "2026-10-05T00:00:00.000Z",
    ])).toEqual({ taskId: "t1", historyId: "hist-1", fireAt: "2026-10-05T00:00:00.000Z" });
  });

  it("缺参 / 缺值 / 值撞参数名 → null", () => {
    expect(parseHeadlessScheduledArgs(["Cyrene.exe"])).toBeNull();
    expect(parseHeadlessScheduledArgs(["Cyrene.exe", "--scheduled-task"])).toBeNull();
    expect(parseHeadlessScheduledArgs(["Cyrene.exe", "--scheduled-task", "--scheduled-history", "h"])).toBeNull();
  });
});
