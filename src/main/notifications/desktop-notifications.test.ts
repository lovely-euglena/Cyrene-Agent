import { describe, expect, it } from "vitest";

import { extractNotification } from "./desktop-notifications";

describe("extractNotification（issue #153 系统通知场景提取）", () => {
  it("RUN_FINISHED 终态映射", () => {
    expect(extractNotification({ type: "RUN_FINISHED", result: { status: "success" } })).toEqual({
      title: "任务完成", body: "昔涟已完成这轮任务，点击查看结果。",
    });
    expect(extractNotification({ type: "RUN_FINISHED", result: { status: "timeout" } })?.title).toBe("任务超时");
    expect(extractNotification({ type: "RUN_FINISHED", result: { status: "runtime_error" } })?.title).toBe("任务出错");
  });

  it("cancelled 静默（用户主动行为）", () => {
    expect(extractNotification({ type: "RUN_FINISHED", result: { status: "cancelled" } })).toBeUndefined();
  });

  it("cyrene.choice 等待输入", () => {
    expect(extractNotification({ type: "CUSTOM", name: "cyrene.choice", value: {} })).toEqual({
      title: "等待你的输入", body: "昔涟有问题要问你，点击回到对话。",
    });
    expect(extractNotification({ type: "CUSTOM", name: "cyrene.sticker", value: {} })).toBeUndefined();
  });

  it("非目标事件静默", () => {
    expect(extractNotification(undefined)).toBeUndefined();
    expect(extractNotification("string")).toBeUndefined();
    expect(extractNotification({ type: "TEXT_MESSAGE_CONTENT", delta: "x" })).toBeUndefined();
  });
});
