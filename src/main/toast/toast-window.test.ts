// toast 窗口控制器测试：高度协议、定位、按需创建与空闲回收。
// 回归背景：
//   - updateHeight 曾只记账不应用 bounds，渲染端 offsetHeight 被窗口当前
//     高度 clamp，两者叠加形成"窗口 1px → 测不准 → 永远 1px"的死锁。
//   - 按需创建（默认）后，首个 toast 的 push/音效必须不因页面未就绪而丢：
//     send 在 did-finish-load 前入队、就绪后按序补投。

import { afterEach, describe, expect, it, vi } from "vitest";
import { createToastWindowController } from "./toast-window";
import { TOAST_IDLE_TEARDOWN_MS, TOAST_WINDOW_WIDTH } from "./types";

/** 工作区：1920x1080 屏幕，底部任务栏占 48px（workArea 不含任务栏） */
const WORKAREA = { x: 0, y: 0, width: 1920, height: 1080 - 48 };

interface WindowStub {
  setBounds: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
  /** 模拟渲染页加载完成（did-finish-load） */
  fireDidFinishLoad: () => void;
}

function createWindowStub(id = 42): WindowStub {
  let visible = false;
  let destroyed = false;
  const loadListeners: Array<() => void> = [];
  return {
    setBounds: vi.fn(),
    showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    destroy: vi.fn(() => { destroyed = true; visible = false; }),
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    webContents: {
      id,
      send: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "did-finish-load") loadListeners.push(listener);
      }),
    },
    fireDidFinishLoad: () => {
      for (const listener of loadListeners.splice(0, loadListeners.length)) listener();
    },
  };
}

function setup(options?: { idleTeardownMs?: number | null }) {
  const created: WindowStub[] = [];
  let nextId = 42;
  const controller = createToastWindowController({
    createWindow: () => {
      const win = createWindowStub(nextId++);
      created.push(win);
      return win as never;
    },
    getChatWindow: () => null,
    getDisplayMatching: () => ({ workArea: WORKAREA }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    ...(options?.idleTeardownMs === undefined ? {} : { idleTeardownMs: options.idleTeardownMs }),
  });
  return {
    controller,
    created,
    get win() {
      return created[created.length - 1];
    },
  };
}

/** 取最近一次 setBounds 的参数 */
function lastBounds(win: WindowStub) {
  const calls = win.setBounds.mock.calls;
  return calls[calls.length - 1][0] as { x: number; y: number; width: number; height: number };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createToastWindowController · 高度协议", () => {
  it("updateHeight 收到新高度立即应用 bounds，不等下一次显示", () => {
    const h = setup();
    h.controller.preload();
    h.controller.updateHeight(94);
    expect(h.win.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ width: TOAST_WINDOW_WIDTH, height: 94 }),
    );
  });

  it("重复上报相同高度不重复 setBounds（渲染端之外的防抖兜底）", () => {
    const h = setup();
    h.controller.preload();
    h.controller.updateHeight(94);
    const calls = h.win.setBounds.mock.calls.length;
    h.controller.updateHeight(94);
    expect(h.win.setBounds.mock.calls.length).toBe(calls);
  });

  it("高度上报驱动窗口逐级放大：模拟 1px 起步的解锁过程", () => {
    const h = setup();
    h.controller.preload();
    // 初始（渲染页空容器上报，scrollHeight = padding 24）
    h.controller.updateHeight(24);
    expect(lastBounds(h.win).height).toBe(24);
    // 卡片渲染后上报真实内容高度（scrollHeight 不受窗口 clamp）
    h.controller.updateHeight(118);
    expect(lastBounds(h.win).height).toBe(118);
  });

  it("无效高度被忽略：非有限值与 0/负数不更新也不应用", () => {
    const h = setup();
    h.controller.preload();
    h.win.setBounds.mockClear();
    h.controller.updateHeight(0);
    h.controller.updateHeight(-5);
    h.controller.updateHeight(Number.NaN);
    expect(h.win.setBounds).not.toHaveBeenCalled();
  });
});

describe("createToastWindowController · 定位与显隐", () => {
  it("窗口贴工作区右下角：底边对齐任务栏上缘，不越界", () => {
    const h = setup();
    h.controller.preload();
    h.controller.updateHeight(100);
    h.controller.syncVisibility(true);
    const b = lastBounds(h.win);
    expect(b.x).toBe(WORKAREA.x + WORKAREA.width - TOAST_WINDOW_WIDTH);
    expect(b.y + b.height).toBe(WORKAREA.y + WORKAREA.height);
    expect(h.win.showInactive).toHaveBeenCalled();
  });

  it("高度超过工作区 60% 上限时被 clamp，窗口仍不出工作区", () => {
    const h = setup();
    h.controller.preload();
    h.controller.updateHeight(5000);
    h.controller.syncVisibility(true);
    const b = lastBounds(h.win);
    expect(b.height).toBe(Math.floor(WORKAREA.height * 0.6));
    expect(b.y + b.height).toBeLessThanOrEqual(WORKAREA.y + WORKAREA.height);
  });

  it("队列清空整窗隐藏，再来新 toast 重新显示", () => {
    const h = setup();
    h.controller.preload();
    h.controller.updateHeight(100);
    h.controller.syncVisibility(true);
    expect(h.win.isVisible()).toBe(true);
    h.controller.syncVisibility(false);
    expect(h.win.isVisible()).toBe(false);
    h.controller.syncVisibility(true);
    expect(h.win.isVisible()).toBe(true);
  });
});

describe("createToastWindowController · 按需创建", () => {
  it("未 preload 时不建窗；首个 syncVisibility(true) 才物化", () => {
    const h = setup();
    expect(h.created).toHaveLength(0);
    expect(h.controller.isMaterialized()).toBe(false);

    h.controller.syncVisibility(true);
    expect(h.created).toHaveLength(1);
    expect(h.controller.isMaterialized()).toBe(true);
    expect(h.win.showInactive).toHaveBeenCalled();
  });

  it("页面就绪前 send 入队保序，did-finish-load 后补投（首个 toast 不丢音效）", () => {
    const h = setup();
    h.controller.syncVisibility(true);
    h.controller.send("toast:push", { id: "t1", sound: true });
    h.controller.send("toast:remove", "t1");
    expect(h.win.webContents.send).not.toHaveBeenCalled();

    h.win.fireDidFinishLoad();
    expect(h.win.webContents.send.mock.calls.map((c) => c[0])).toEqual(["toast:push", "toast:remove"]);
    expect(h.win.webContents.send).toHaveBeenNthCalledWith(1, "toast:push", { id: "t1", sound: true });
  });

  it("页面已就绪后 send 直投，不入队", () => {
    const h = setup();
    h.controller.preload();
    h.win.fireDidFinishLoad();
    h.controller.send("toast:push", { id: "t2" });
    expect(h.win.webContents.send).toHaveBeenCalledWith("toast:push", { id: "t2" });
  });

  it("队列空超过 idleTeardownMs 回收窗口；再来新 toast 重建新窗口", () => {
    vi.useFakeTimers();
    const h = setup();
    h.controller.syncVisibility(true);
    expect(h.controller.isMaterialized()).toBe(true);
    const first = h.win;

    h.controller.syncVisibility(false);
    vi.advanceTimersByTime(TOAST_IDLE_TEARDOWN_MS - 1);
    expect(first.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(h.controller.isMaterialized()).toBe(false);

    h.controller.syncVisibility(true);
    expect(h.created).toHaveLength(2);
    expect(h.created[1]).not.toBe(first);
    expect(h.controller.isMaterialized()).toBe(true);
  });

  it("回收延迟内新 toast 复用同一窗口（撤销销毁，不重建）", () => {
    vi.useFakeTimers();
    const h = setup();
    h.controller.syncVisibility(true);
    const first = h.win;
    h.controller.syncVisibility(false);

    vi.advanceTimersByTime(10_000);
    h.controller.syncVisibility(true); // 新 toast 撤销销毁
    vi.advanceTimersByTime(TOAST_IDLE_TEARDOWN_MS * 2);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(h.created).toHaveLength(1);
  });

  it("idleTeardownMs=null（急切模式）：队列空只隐藏不销毁", () => {
    vi.useFakeTimers();
    const h = setup({ idleTeardownMs: null });
    h.controller.preload();
    h.controller.syncVisibility(true);
    h.controller.syncVisibility(false);
    vi.advanceTimersByTime(TOAST_IDLE_TEARDOWN_MS * 3);
    expect(h.win.destroy).not.toHaveBeenCalled();
    expect(h.controller.isMaterialized()).toBe(true);
  });

  it("回收后新窗口不沿用旧内容高度（contentHeight 归零，等新渲染页上报）", () => {
    vi.useFakeTimers();
    const h = setup();
    h.controller.syncVisibility(true);
    h.controller.updateHeight(150);
    h.controller.syncVisibility(false);
    vi.advanceTimersByTime(TOAST_IDLE_TEARDOWN_MS);

    h.controller.syncVisibility(true);
    const fresh = h.win;
    // 新窗口显示时先按 1px 起步（真实高度等渲染页 TOAST_RESIZE），
    // 不能沿用上一个窗口上报过的 150
    expect(lastBounds(fresh).height).toBe(1);
    h.controller.send("toast:push", { id: "t3" });
    h.controller.updateHeight(90);
    expect(lastBounds(fresh).height).toBe(90);
  });

  it("dispose 清理销毁定时器与窗口", () => {
    vi.useFakeTimers();
    const h = setup();
    h.controller.syncVisibility(true);
    const first = h.win;
    h.controller.syncVisibility(false);
    h.controller.dispose();
    vi.advanceTimersByTime(TOAST_IDLE_TEARDOWN_MS * 3);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(h.controller.isMaterialized()).toBe(false);
  });
});