// 设置窗路由测试：默认 WPF（带 section 定位）、Electron 例外、native 失败回退。

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnNativeWindow: vi.fn(async () => true),
  createSettingsWindow: vi.fn(),
}));

vi.mock("./native-windows-bridge", () => ({
  spawnNativeWindow: mocks.spawnNativeWindow,
}));
vi.mock("./create-aux-windows", () => ({
  createSettingsWindow: mocks.createSettingsWindow,
}));

import { openSettingsWindow } from "./settings-router";

/** 冲掉 spawnNativeWindow(...).then(...) 的微任务 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("openSettingsWindow · 路由", () => {
  beforeEach(() => {
    mocks.spawnNativeWindow.mockClear();
    mocks.createSettingsWindow.mockClear();
    mocks.spawnNativeWindow.mockResolvedValue(true);
  });

  it("无 section（通用入口）→ WPF，不带 layout", async () => {
    openSettingsWindow();
    expect(mocks.spawnNativeWindow).toHaveBeenCalledWith("settings", undefined);
    await flush();
    expect(mocks.createSettingsWindow).not.toHaveBeenCalled();
  });

  it("WPF 认识的 section → WPF + section 定位", async () => {
    openSettingsWindow("appearance");
    expect(mocks.spawnNativeWindow).toHaveBeenCalledWith("settings", { section: "appearance" });
    await flush();
    expect(mocks.createSettingsWindow).not.toHaveBeenCalled();
  });

  it("channels / tts / asr → Electron，不触碰 native", async () => {
    for (const section of ["channels", "tts", "asr"]) {
      openSettingsWindow(section);
      expect(mocks.createSettingsWindow).toHaveBeenCalledWith(section);
    }
    await flush();
    expect(mocks.spawnNativeWindow).not.toHaveBeenCalled();
  });

  it("preferences 迁入 WPF → native + section 定位", async () => {
    openSettingsWindow("preferences");
    expect(mocks.spawnNativeWindow).toHaveBeenCalledWith("settings", { section: "preferences" });
    await flush();
    expect(mocks.createSettingsWindow).not.toHaveBeenCalled();
  });

  it("cyrene 迁入 WPF → native + section 定位", async () => {
    openSettingsWindow("cyrene");
    expect(mocks.spawnNativeWindow).toHaveBeenCalledWith("settings", { section: "cyrene" });
    await flush();
    expect(mocks.createSettingsWindow).not.toHaveBeenCalled();
  });

  it("未知 section → Electron（防落错页）", async () => {
    openSettingsWindow("unknown-section");
    expect(mocks.createSettingsWindow).toHaveBeenCalledWith("unknown-section");
    await flush();
    expect(mocks.spawnNativeWindow).not.toHaveBeenCalled();
  });

  it("native spawn 失败 → 回退 Electron（同 section）", async () => {
    mocks.spawnNativeWindow.mockResolvedValue(false);
    openSettingsWindow("api");
    await flush();
    expect(mocks.createSettingsWindow).toHaveBeenCalledWith("api");
  });

  it("about 回退 Electron 时归一到默认页（Electron 无 about hash）", async () => {
    mocks.spawnNativeWindow.mockResolvedValue(false);
    openSettingsWindow("about");
    await flush();
    expect(mocks.createSettingsWindow).toHaveBeenCalledWith(undefined);
  });
});