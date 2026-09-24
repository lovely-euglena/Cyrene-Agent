/**
 * 分离托盘 pipe 探针测试。
 *
 * 回归背景：fs.existsSync 对 .NET NamedPipeServerStream 创建的 pipe 返回
 * false（stat/open 报 EBUSY），会把「托盘在跑」误判为「未运行」而永远
 * 回退内置托盘、分离托盘永不生效。现实现改为枚举管道命名空间
 * （fs.readdirSync('\\\\.\\pipe\\')），本文件锁定该行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn() };
});

import * as fs from "node:fs";
import { isDetachedTrayPipeAvailable } from "./tray-detached";

const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const originalPlatform = process.platform;

function stubPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("isDetachedTrayPipeAvailable（分离托盘 pipe 探针）", () => {
  beforeEach(() => {
    stubPlatform("win32");
    readdirMock.mockReset();
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  it("管道命名空间包含 cyrene-tray → true", () => {
    readdirMock.mockReturnValue(["lsass", "cyrene-tray"]);
    expect(isDetachedTrayPipeAvailable()).toBe(true);
    expect(readdirMock).toHaveBeenCalledWith("\\\\.\\pipe\\");
  });

  it("不包含 cyrene-tray → false", () => {
    readdirMock.mockReturnValue(["lsass", "eventlog"]);
    expect(isDetachedTrayPipeAvailable()).toBe(false);
  });

  it("枚举抛错 → false（不冒泡）", () => {
    readdirMock.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(isDetachedTrayPipeAvailable()).toBe(false);
  });

  it("非 Windows 恒 false（分离托盘 Windows 专属）", () => {
    stubPlatform("linux");
    readdirMock.mockReturnValue(["cyrene-tray"]);
    expect(isDetachedTrayPipeAvailable()).toBe(false);
  });
});