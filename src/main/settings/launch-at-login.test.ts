import { describe, expect, it, vi } from "vitest";
import {
  applyInstallerLaunchAtLoginSelection,
  buildTrayLoginItemArgs,
  consumeInstallerLaunchAtLoginSelection,
  syncLaunchAtLogin,
} from "./launch-at-login";

describe("syncLaunchAtLogin", () => {
  it("enables Windows login launch when the setting is enabled", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(true, { setLoginItemSettings });

    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it("removes Windows login launch when the setting is disabled", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(false, { setLoginItemSettings });

    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it("IKJK51：调度常驻时登录项指向 cyrene-native --tray", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(true, { setLoginItemSettings }, {
      trayPath: "C:\\app\\cyrene-native.exe",
      trayArgs: ["--tray", "--data-dir", "C:\\ud"],
    });

    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "C:\\app\\cyrene-native.exe",
      args: ["--tray", "--data-dir", "C:\\ud"],
    });
  });

  it("IKJK51：关闭时同时清 Electron 与托盘登录项（防切换指向后残留）", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(false, { setLoginItemSettings }, {
      trayPath: "C:\\app\\cyrene-native.exe",
      trayArgs: ["--tray"],
    });

    expect(setLoginItemSettings).toHaveBeenNthCalledWith(1, { openAtLogin: false });
    expect(setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false, path: "C:\\app\\cyrene-native.exe" });
  });

  it("IKJK51 复审 P1-3：含空格/中文路径 --data-dir 必须引号包裹", () => {
    expect(buildTrayLoginItemArgs("C:\\Users\\John Doe\\AppData\\Roaming\\昔涟 Cyrene")).toEqual([
      "--tray",
      "--scheduler",
      "--data-dir",
      "\"C:\\Users\\John Doe\\AppData\\Roaming\\昔涟 Cyrene\"",
    ]);
  });

  it("IKJK51 复审 P1-3：syncLaunchAtLogin 原样透传引号参数", () => {
    const setLoginItemSettings = vi.fn();
    syncLaunchAtLogin(true, { setLoginItemSettings }, {
      trayPath: "C:\\app\\cyrene-native.exe",
      trayArgs: ["--tray", "--scheduler", "--data-dir", "\"C:\\Users\\John Doe\\Cyrene\""],
    });
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "C:\\app\\cyrene-native.exe",
      args: ["--tray", "--scheduler", "--data-dir", "\"C:\\Users\\John Doe\\Cyrene\""],
    });
  });
});

describe("consumeInstallerLaunchAtLoginSelection", () => {
  it("uses the checked installer option on the first app launch", () => {
    const readFileSync = vi.fn(() => '{"launchAtLogin":true}');
    const unlinkSync = vi.fn();

    expect(consumeInstallerLaunchAtLoginSelection("installer-options.json", { readFileSync, unlinkSync })).toBe(true);
    expect(unlinkSync).toHaveBeenCalledWith("installer-options.json");
  });

  it("does not force a preference when the installer did not leave a selection", () => {
    const readFileSync = vi.fn(() => "not json");
    const unlinkSync = vi.fn();

    expect(consumeInstallerLaunchAtLoginSelection("installer-options.json", { readFileSync, unlinkSync })).toBeNull();
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});

describe("applyInstallerLaunchAtLoginSelection", () => {
  it("persists the one-shot installer selection into the normal settings payload", () => {
    expect(applyInstallerLaunchAtLoginSelection(
      { launchAtLogin: false, language: "zh-CN" },
      true,
    )).toEqual({ launchAtLogin: true, language: "zh-CN" });
  });
});
