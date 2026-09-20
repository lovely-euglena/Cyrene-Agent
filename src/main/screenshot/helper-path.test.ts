import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { resolveScreenshotHelperPath } from "./helper-path";

describe("resolveScreenshotHelperPath", () => {
  it("uses the development Rust release binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "C:\\repo",
      resourcesPath: "C:\\app\\resources",
      envOverride: undefined,
    })).toBe(path.win32.join("C:\\repo", "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot.exe"));
  });

  it("uses the packaged resources binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "C:\\app\\resources\\app.asar",
      resourcesPath: "C:\\app\\resources",
      envOverride: undefined,
    })).toBe(path.win32.join("C:\\app", "resources", "bin", "cyrene-screenshot.exe"));
  });

  it("allows an explicit helper path override", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "C:\\app\\resources\\app.asar",
      resourcesPath: "C:\\app\\resources",
      envOverride: "D:\\debug\\cyrene-screenshot.exe",
    })).toBe(path.win32.join("D:\\debug", "cyrene-screenshot.exe"));
  });
});
