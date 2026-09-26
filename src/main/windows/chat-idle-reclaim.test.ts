import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  CHAT_IDLE_RECLAIM_MS,
  attachChatIdleReclaim,
  resolveChatIdleReclaimMs,
} from "./chat-idle-reclaim";

interface FakeChatWindow {
  destroyed: boolean;
  minimized: boolean;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  fire: (event: string) => void;
}

function makeFakeChatWindow(): FakeChatWindow {
  const listeners = new Map<string, Array<() => void>>();
  const win: FakeChatWindow = {
    destroyed: false,
    minimized: false,
    destroy: vi.fn(() => {
      win.destroyed = true;
      for (const cb of listeners.get("closed") ?? []) cb();
    }),
    on: vi.fn((event: string, listener: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    }),
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    fire: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
  return win;
}

function attach(win: FakeChatWindow, delayMs: number): () => void {
  return attachChatIdleReclaim(win as unknown as BrowserWindow, delayMs);
}

describe("resolveChatIdleReclaimMs", () => {
  it("默认 15 分钟；环境变量合法时覆盖", () => {
    expect(resolveChatIdleReclaimMs({} as NodeJS.ProcessEnv)).toBe(CHAT_IDLE_RECLAIM_MS);
    expect(CHAT_IDLE_RECLAIM_MS).toBe(15 * 60_000);
    expect(resolveChatIdleReclaimMs({ CYRENE_CHAT_IDLE_RECLAIM_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
    // 非法/过小值回落默认
    expect(resolveChatIdleReclaimMs({ CYRENE_CHAT_IDLE_RECLAIM_MS: "abc" } as NodeJS.ProcessEnv)).toBe(CHAT_IDLE_RECLAIM_MS);
    expect(resolveChatIdleReclaimMs({ CYRENE_CHAT_IDLE_RECLAIM_MS: "10" } as NodeJS.ProcessEnv)).toBe(CHAT_IDLE_RECLAIM_MS);
  });
});

describe("attachChatIdleReclaim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("最小化达到时长后销毁窗口", () => {
    const win = makeFakeChatWindow();
    attach(win, 60_000);
    win.minimized = true;
    win.fire("minimize");

    vi.advanceTimersByTime(59_999);
    expect(win.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("恢复/聚焦会取消回收", () => {
    const win = makeFakeChatWindow();
    attach(win, 60_000);
    win.minimized = true;
    win.fire("minimize");
    vi.advanceTimersByTime(30_000);
    win.minimized = false;
    win.fire("restore");
    vi.advanceTimersByTime(120_000);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("到点时已恢复（isMinimized=false）不销毁，重新最小化重新计时", () => {
    const win = makeFakeChatWindow();
    attach(win, 60_000);
    win.minimized = true;
    win.fire("minimize");
    win.minimized = false; // 状态恢复但没派发 restore 事件
    vi.advanceTimersByTime(60_000);
    expect(win.destroy).not.toHaveBeenCalled();

    win.minimized = true;
    win.fire("minimize");
    vi.advanceTimersByTime(60_000);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("已销毁窗口到点安全返回，不重复销毁", () => {
    const win = makeFakeChatWindow();
    attach(win, 60_000);
    win.minimized = true;
    win.fire("minimize");
    win.destroyed = true;
    vi.advanceTimersByTime(60_000);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("返回值可手动取消（拆卸）", () => {
    const win = makeFakeChatWindow();
    const detach = attach(win, 60_000);
    win.minimized = true;
    win.fire("minimize");
    detach();
    vi.advanceTimersByTime(120_000);
    expect(win.destroy).not.toHaveBeenCalled();
  });
});
