import { describe, expect, it, vi, beforeEach } from "vitest";

// initNativeWindowsBridge 内部依赖 native-windows-host 的单例与 electron，
// 单测环境下（无 exe / 开关关闭）应全部安全 no-op——这正是灰度回退的
// 核心保证：开关关 = 行为与改造前逐位一致。

import {
  initNativeWindowsBridge,
  isNativeWindowActive,
  relayAuxBroadcast,
  spawnNativeWindow,
  spawnNativeSplash,
  notifyNativeSplashShown,
  closeNativeWindow,
  disposeNativeWindowsBridge,
  bindNativeDataProviders,
  pushSchedulerSnapshotToNative,
  markNativeWindowsStartupReady,
} from "./native-windows-bridge";

const IPC = {
  RUNTIME_STATE_CHANGED: "runtime-state:changed",
  MODEL_CONFIG_CHANGED: "model-config:changed",
  SCHEDULER_CHANGED: "scheduler:changed",
};

describe("native-windows-bridge（开关关闭：全 no-op 回退路径）", () => {
  beforeEach(() => {
    // 不设 CYRENE_NATIVE_WINDOWS → 未启用
    delete process.env.CYRENE_NATIVE_WINDOWS;
    disposeNativeWindowsBridge("test");
  });

  it("init is a no-op and isNativeWindowActive returns false", () => {
    const client = initNativeWindowsBridge({
      openSettings: vi.fn(),
      openChatWindow: vi.fn(),
      openCallWindow: vi.fn(),
      toggleSidebarPin: vi.fn(),
      cycleModelProvider: vi.fn(),
      onSplashShown: vi.fn(),
    });
    expect(client).toBeNull();
    expect(isNativeWindowActive("sidebar")).toBe(false);
    expect(isNativeWindowActive("splash")).toBe(false);
  });

  it("spawnNativeWindow returns false without side effects", async () => {
    await expect(spawnNativeWindow("sidebar", { x: 1, y: 2 })).resolves.toBe(false);
  });

  it("spawnNativeSplash returns false and onShown never fires", async () => {
    const onShown = vi.fn();
    await expect(spawnNativeSplash({ onShown })).resolves.toBe(false);
    notifyNativeSplashShown();
    expect(onShown).not.toHaveBeenCalled();
  });

  it("closeNativeWindow does not throw", async () => {
    await expect(closeNativeWindow("tasks")).resolves.toBeUndefined();
  });

  it("relayAuxBroadcast silently drops known channels", () => {
    expect(() => {
      relayAuxBroadcast(IPC.RUNTIME_STATE_CHANGED, { status: "陪伴中" });
      relayAuxBroadcast(IPC.MODEL_CONFIG_CHANGED, { shortName: "gpt" });
      relayAuxBroadcast(IPC.SCHEDULER_CHANGED, undefined);
      relayAuxBroadcast("unknown:channel", { whatever: 1 });
    }).not.toThrow();
  });

  it("dispose is idempotent", () => {
    expect(() => {
      disposeNativeWindowsBridge("a");
      disposeNativeWindowsBridge("b");
    }).not.toThrow();
  });

  it("pushSchedulerSnapshotToNative is a no-op without data providers or client", async () => {
    // 未绑定 providers：直接短路（不拉数据、不推送）
    expect(() => pushSchedulerSnapshotToNative()).not.toThrow();

    // 绑定 providers 但 native 未启用：getTasks 不应被调用（拉取有成本）
    const getTasks = vi.fn(async () => [{ name: "t" }]);
    bindNativeDataProviders({
      getRuntimeState: vi.fn(),
      getModelConfig: vi.fn(),
      getTasks,
    });
    pushSchedulerSnapshotToNative();
    await Promise.resolve();
    expect(getTasks).not.toHaveBeenCalled();
  });

  it("markNativeWindowsStartupReady is idempotent and safe without client", () => {
    expect(() => {
      markNativeWindowsStartupReady();
      markNativeWindowsStartupReady();
    }).not.toThrow();
  });

  it("spawnNativeWindow with settings kind is a safe no-op when disabled", async () => {
    await expect(spawnNativeWindow("settings")).resolves.toBe(false);
  });

  it("bindNativeDataProviders stores providers without side effects when disabled", () => {
    expect(() => {
      bindNativeDataProviders({
        getRuntimeState: () => ({ status: "陪伴中" }),
        getModelConfig: () => ({ shortName: "x" }),
        getTasks: async () => [],
      });
    }).not.toThrow();
    expect(isNativeWindowActive("tasks")).toBe(false);
  });
});
