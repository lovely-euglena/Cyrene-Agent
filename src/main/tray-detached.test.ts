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
import { buildConnectFrames, dispatchLine, isDetachedTrayPipeAvailable, showTrayBalloon } from "./tray-detached";

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

describe("showTrayBalloon（系统级托盘气泡入口）", () => {
  it("支持 displayBalloon：转发参数并返回 true", () => {
    const displayBalloon = vi.fn();
    const ok = showTrayBalloon({ displayBalloon } as never, { title: "标题", content: "正文" });
    expect(ok).toBe(true);
    expect(displayBalloon).toHaveBeenCalledWith({ title: "标题", content: "正文" });
  });

  it("缺失实现 / null / 内部抛错：返回 false 且不冒泡", () => {
    expect(showTrayBalloon({} as never, { title: "t", content: "c" })).toBe(false);
    expect(showTrayBalloon(null, { title: "t", content: "c" })).toBe(false);
    expect(showTrayBalloon(
      { displayBalloon: () => { throw new Error("boom"); } } as never,
      { title: "t", content: "c" },
    )).toBe(false);
  });
});

describe("dispatchLine（托盘命令路由）", () => {
  function makeInput() {
    return {
      requestActivation: vi.fn(),
      togglePetWindow: vi.fn(),
      setPetDragMode: vi.fn(() => true),
      quit: vi.fn(),
    };
  }

  it("drag-mode 透传勾选状态：checked=true → 开启", () => {
    const input = makeInput();
    dispatchLine(JSON.stringify({ op: "cmd", action: "drag-mode", checked: true }), input);
    expect(input.setPetDragMode).toHaveBeenCalledWith(true);
  });

  it("drag-mode 透传勾选状态：checked=false → 关闭（修复「只能开不能关」）", () => {
    const input = makeInput();
    dispatchLine(JSON.stringify({ op: "cmd", action: "drag-mode", checked: false }), input);
    expect(input.setPetDragMode).toHaveBeenCalledWith(false);
  });

  it("旧版托盘无 checked 字段 → 按 true 兼容（旧行为不变）", () => {
    const input = makeInput();
    dispatchLine(JSON.stringify({ op: "cmd", action: "drag-mode" }), input);
    expect(input.setPetDragMode).toHaveBeenCalledWith(true);
  });

  it("drag-mode 结果回执：应用成功 → 回执 checked=true", () => {
    const input = makeInput();
    const notify = vi.fn();
    dispatchLine(JSON.stringify({ op: "cmd", action: "drag-mode", checked: true }), input, notify);
    expect(notify).toHaveBeenCalledWith({ op: "tray.drag-mode-state", checked: true });
  });

  it("drag-mode 结果回执：宿主拒绝 → 回执 checked=false（勾选回退对齐）", () => {
    const input = makeInput();
    input.setPetDragMode.mockReturnValue(false);
    const notify = vi.fn();
    dispatchLine(JSON.stringify({ op: "cmd", action: "drag-mode", checked: true }), input, notify);
    expect(notify).toHaveBeenCalledWith({ op: "tray.drag-mode-state", checked: false });
  });

  it("非 drag-mode 命令不回执状态帧", () => {
    const input = makeInput();
    const notify = vi.fn();
    dispatchLine(JSON.stringify({ op: "cmd", action: "chat" }), input, notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it("基础动作路由：chat / toggle-pet / quit；坏帧与非 cmd 帧静默", () => {
    const input = makeInput();
    dispatchLine(JSON.stringify({ op: "cmd", action: "chat" }), input);
    dispatchLine(JSON.stringify({ op: "cmd", action: "toggle-pet" }), input);
    dispatchLine(JSON.stringify({ op: "cmd", action: "quit" }), input);
    expect(input.requestActivation).toHaveBeenCalledWith({ kind: "chat" });
    expect(input.togglePetWindow).toHaveBeenCalledTimes(1);
    expect(input.quit).toHaveBeenCalledTimes(1);

    expect(() => dispatchLine("{bad json", input)).not.toThrow();
    dispatchLine(JSON.stringify({ op: "tray.ready" }), input);
    expect(input.requestActivation).toHaveBeenCalledTimes(1);
  });
});

describe("buildConnectFrames（连接建立握手帧）", () => {
  it("tray.ready + 拖动模式勾选同步（缺省 false）", () => {
    expect(buildConnectFrames({})).toEqual([
      { op: "tray.ready" },
      { op: "tray.drag-mode-state", checked: false },
    ]);
  });

  it("getPetDragMode=true → 同步 checked=true", () => {
    expect(buildConnectFrames({ getPetDragMode: () => true })).toContainEqual({
      op: "tray.drag-mode-state",
      checked: true,
    });
  });
});