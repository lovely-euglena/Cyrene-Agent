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
});
