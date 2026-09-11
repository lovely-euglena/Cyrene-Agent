import { afterEach, describe, expect, it, vi } from "vitest";
import { createAguiStreamThrottle } from "./agui-stream-throttle";

// 固定 100ms 窗口的行为语义测试（不测真实时钟——vi.useFakeTimers 控制）

describe("createAguiStreamThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers CONTENT events and merges deltas per messageId", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const t = createAguiStreamThrottle();
    t.setDeliver(deliver);
    t.setTargetVisible(() => true);

    expect(t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "你" })).toBe(true);
    expect(t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "好" })).toBe(true);
    expect(t.offer({ type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "t1", delta: "想" })).toBe(true);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    // 两条合并事件：正文一条（delta 拼接）+ thinking 一条
    expect(deliver).toHaveBeenCalledTimes(1);
    const batch = deliver.mock.calls[0][0] as Array<{ type: string; messageId: string; delta: string }>;
    expect(batch).toHaveLength(2);
    const text = batch.find((e) => e.messageId === "m1")!;
    expect(text.delta).toBe("你好");
    expect(batch.find((e) => e.messageId === "t1")!.delta).toBe("想");

    t.dispose();
  });

  it("flushes pending batch before END events (ordering guarantee)", () => {
    vi.useFakeTimers();
    const delivered: Array<Record<string, unknown>> = [];
    const t = createAguiStreamThrottle();
    const immediate: Array<Record<string, unknown>> = [];
    t.setDeliver((events) => delivered.push(...(events as Array<Record<string, unknown>>)));
    t.setTargetVisible(() => true);

    t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "尾部" });
    // END 屏障：先 flush（deliver 被调）再返回 false（立即投递）
    const passthrough = t.offer({ type: "TEXT_MESSAGE_END", messageId: "m1" });
    expect(passthrough).toBe(false);
    immediate.push({ type: "TEXT_MESSAGE_END", messageId: "m1" });

    expect(delivered).toHaveLength(1);
    // 投递顺序：CONTENT（flush 出的）先于 END（调用方 immediate）
    const all = [...delivered, ...immediate];
    expect(all[0].type).toBe("TEXT_MESSAGE_CONTENT");
    expect(all[1].type).toBe("TEXT_MESSAGE_END");

    t.dispose();
  });

  it("holds batch when target invisible; force flush settles data", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const t = createAguiStreamThrottle();
    t.setDeliver(deliver);
    let visible = false;
    t.setTargetVisible(() => visible);

    t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "后台" });
    vi.advanceTimersByTime(300);
    expect(deliver).not.toHaveBeenCalled(); // 不可见：不吐

    visible = true;
    t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "回来" });
    vi.advanceTimersByTime(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    const batch = deliver.mock.calls[0][0] as Array<{ delta: string }>;
    expect(batch[0].delta).toBe("后台回来"); // 攒批期间的数据不丢

    t.dispose();
  });

  it("flush() is idempotent and force-delivers even when invisible", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const t = createAguiStreamThrottle();
    t.setDeliver(deliver);
    t.setTargetVisible(() => false); // 始终不可见

    t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "终态兜底" });
    t.flush(); // run 终态强制 flush（数据完整性优先于可见性）
    t.flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    t.dispose();
  });

  it("passes control events through without buffering", () => {
    const t = createAguiStreamThrottle();
    t.setDeliver(vi.fn());
    t.setTargetVisible(() => true);

    expect(t.offer({ type: "RUN_STARTED" })).toBe(false);
    expect(t.offer({ type: "TOOL_CALL_START", toolCallId: "x" })).toBe(false);
    expect(t.offer({ type: "RUN_FINISHED" })).toBe(false);
    expect(t.offer("not-an-object")).toBe(false);
    expect(t.offer(null)).toBe(false);

    t.dispose();
  });

  it("dispose clears timer and flushes remainder", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const t = createAguiStreamThrottle();
    t.setDeliver(deliver);
    t.setTargetVisible(() => true);

    t.offer({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "残" });
    t.dispose();
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(deliver).toHaveBeenCalledTimes(1); // timer 已清，不再重复
  });
});
