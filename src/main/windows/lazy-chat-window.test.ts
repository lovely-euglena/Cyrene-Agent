import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLazyReactChatWindowHandle } from "./create-aux-windows";
import { setReactChatWindow, reactChatSession } from "./window-state";

// create-aux-windows 顶部 import electron（app/screen/BrowserWindow），
// 单测环境用 electron-mock 注入（项目已有 vitest 约定）。这里仅测
// handle 状态机：物化、重建、onMaterialized 回调、load/show 分发。

const calls: string[] = [];

// 可销毁窗口注册表：模拟「用户关闭聊天窗 → 渲染进程销毁 → 再打开」
const liveWindows: Array<{ destroy(): void; isDestroyed(): boolean }> = [];

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", isPackaged: false },
  BrowserWindow: class {
    destroyed = false;
    webContents = { on: () => undefined, send: () => undefined, isDestroyed: () => false };
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    show() { calls.push("show"); }
    focus() { calls.push("focus"); }
    on() { /* no-op */ }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    constructor() {
      liveWindows.push(this as unknown as { destroy(): void; isDestroyed(): boolean });
    }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}));

describe("createLazyReactChatWindowHandle", () => {
  beforeEach(() => {
    calls.length = 0;
    liveWindows.length = 0;
    // 模块级窗口单例跨测试残留：旧实例会让 createReactChatWindowShell
    // 走「已有窗口复用」分支，后续测试的 mock constructor 不再执行
    setReactChatWindow(null);
    reactChatSession.reset();
  });

  it("does not materialize until window/load/show is accessed", () => {
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    expect(handle.isLazy).toBe(true);
    expect(handle.isMaterialized()).toBe(false);
    expect(ensureLoaded).not.toHaveBeenCalled();

    // window getter 触发物化
    const win = handle.window;
    expect(win).toBeDefined();
    expect(handle.isMaterialized()).toBe(true);
    expect(ensureLoaded).not.toHaveBeenCalled(); // getter 只创建不加载
  });

  it("load() materializes + loads once (cached promise semantics)", async () => {
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    await handle.load();
    await handle.load(); // 重复 load 复用
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
    expect(handle.isMaterialized()).toBe(true);
  });

  it("show() materializes, shows and focuses; sessionId dispatch queued", () => {
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    handle.show("session-1");
    expect(calls).toContain("show");
    expect(calls).toContain("focus");
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  it("onMaterialized fires on first materialization and immediately for already-materialized", () => {
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    const seen: number[] = [];
    handle.onMaterialized((w) => seen.push(1));
    expect(seen).toHaveLength(0);

    const win = handle.window; // 物化
    expect(seen).toHaveLength(1);

    // 已物化时注册 → 立即回调
    handle.onMaterialized(() => seen.push(2));
    expect(seen).toHaveLength(2);
    void win;
  });

  it("window getter returns live window and re-creates after destroy", () => {
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    const first = handle.window;
    const second = handle.window;
    expect(first).toBe(second); // 未销毁 → 同一实例

    // 模拟用户关闭：窗口销毁后 getter 重建新实例
    liveWindows[0].destroy();
    const third = handle.window;
    expect(third).not.toBe(first);
    expect(handle.isMaterialized()).toBe(true);
  });

  it("P0 regression: reload after close-and-reopen (no blank window)", async () => {
    // 复现路径：窗口关闭后 handle 物化新窗口 → load 必须重新走
    // ensureLoaded（否则新窗口从未 loadFile → 白屏）
    const loadedWindows: unknown[] = [];
    const ensureLoaded = vi.fn(async (win: unknown) => {
      loadedWindows.push(win);
    });
    const handle = createLazyReactChatWindowHandle(ensureLoaded);

    await handle.load();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
    const firstWin = handle.window;

    // 用户关闭 → 再打开（经 openReactChatWindow：load + show）
    liveWindows[0].destroy();
    await handle.load();
    handle.show();

    expect(ensureLoaded).toHaveBeenCalledTimes(2); // 关键断言：重新加载
    expect(loadedWindows[1]).not.toBe(firstWin);   // 加载的是新窗口
    expect(calls).toContain("show");
  });

  it("P0 regression: materialized handlers re-fire on rebuilt window", () => {
    // session-end 紧急落盘绑定必须在窗口重建后重新挂载
    const ensureLoaded = vi.fn(async () => undefined);
    const handle = createLazyReactChatWindowHandle(ensureLoaded);
    const boundTo: unknown[] = [];
    handle.onMaterialized((win) => boundTo.push(win));

    const first = handle.window;
    expect(boundTo).toHaveLength(1);

    liveWindows[0].destroy();
    const rebuilt = handle.window;
    expect(boundTo).toHaveLength(2);       // 重建窗口也挂载
    expect(boundTo[1]).not.toBe(first);
    expect(boundTo[1]).toBe(rebuilt);
  });
});
