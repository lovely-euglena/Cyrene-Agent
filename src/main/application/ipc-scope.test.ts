import { describe, expect, it, vi } from "vitest";
import { createIpcScope, type IpcScopeMainLike } from "./ipc-scope";

function createFakeIpcMain(): IpcScopeMainLike & {
  handlers: Map<string, (...args: any[]) => unknown>;
  listeners: Array<[string, (...args: any[]) => void]>;
} {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      listeners.push([channel, listener]);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      const index = listeners.findIndex(([ch, l]) => ch === channel && l === listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
  };
}

describe("createIpcScope", () => {
  it("removes every handler and listener registered through the scope", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    const listener = vi.fn();
    scope.handle("a", listener);
    scope.on("b", listener);
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledWith("a");
    // on 监听器经同步异常兜底包装后注册，注销以包装后的引用为准
    expect(main.removeListener).toHaveBeenCalledWith("b", expect.any(Function));
    expect(main.handlers.size).toBe(0);
    expect(main.listeners).toHaveLength(0);
  });

  it("rejects duplicate registration inside one scope", () => {
    const scope = createIpcScope(createFakeIpcMain());
    scope.handle("a", vi.fn());
    expect(() => scope.handle("a", vi.fn())).toThrow("IPC channel already registered: a");
  });

  it("supports dynamic handler removal without removing it again on dispose", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    scope.handle("plugin:demo:ping", vi.fn());
    scope.removeHandler("plugin:demo:ping");
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledTimes(1);
    expect(main.handlers.has("plugin:demo:ping")).toBe(false);
  });

  it("dispose is idempotent", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    scope.handle("a", vi.fn());
    scope.dispose();
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledTimes(1);
  });

  it("forwards registrations to the underlying ipc main", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    const handler = vi.fn();
    const listener = vi.fn();
    scope.handle("ch1", handler);
    scope.on("ch2", listener);
    expect(main.handle).toHaveBeenCalledWith("ch1", handler);
    expect(main.on).toHaveBeenCalledWith("ch2", expect.any(Function));
    // 包装不得改变转发语义：派发到注册的监听器仍命中原始回调
    main.listeners.find(([ch]) => ch === "ch2")?.[1]("payload");
    expect(listener).toHaveBeenCalledWith("payload");
  });

  it("P1-1：同步监听器抛错被捕获（不冒泡主进程未捕获异常）且 console.warn 可观察", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    scope.on("settings:pet", () => {
      throw new Error("E_SECRETS_HOST_LOST: 宿主不可用");
    });
    const guarded = main.listeners.find(([ch]) => ch === "settings:pet")?.[1];
    expect(guarded).toBeDefined();
    expect(() => guarded!()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("settings:pet");
    expect(String(warn.mock.calls[0][1])).toContain("E_SECRETS_HOST_LOST");
    warn.mockRestore();
  });
});
