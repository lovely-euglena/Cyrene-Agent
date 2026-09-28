import { afterEach, describe, expect, it, vi } from "vitest";

// 子进程集中回收：验证登记表、win32 整树杀命令、reaper 幂等与触发。
const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

import {
  trackPid,
  untrackChildProcess,
  listTrackedProcesses,
  killTrackedChildrenSync,
  installChildProcessReaper,
  resetChildProcessReaperForTest,
} from "./child-processes";

describe("child-processes · 退出兜底回收", () => {
  afterEach(() => {
    resetChildProcessReaperForTest();
    mocks.spawnSync.mockClear();
  });

  it("登记与移除 PID", () => {
    trackPid(1234, "native");
    expect(listTrackedProcesses().map((p) => p.pid)).toEqual([1234]);
    untrackChildProcess(1234);
    expect(listTrackedProcesses()).toEqual([]);
  });

  it("win32 下用 taskkill /F /T 杀整棵进程树，并清空登记", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      trackPid(4321, "cyrene-native serve");
      const count = killTrackedChildrenSync("test");
      expect(count).toBe(1);
      expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
      const [command, args] = mocks.spawnSync.mock.calls[0] as unknown as [string, string[]];
      expect(command).toBe("taskkill");
      expect(args).toEqual(["/F", "/T", "/PID", "4321"]);
      expect(listTrackedProcesses()).toEqual([]);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("无登记时不执行任何 kill 命令", () => {
    expect(killTrackedChildrenSync("test")).toBe(0);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("reaper 安装幂等，will-quit 触发清理", () => {
    const listeners: Array<() => void> = [];
    installChildProcessReaper((listener) => listeners.push(listener));
    installChildProcessReaper((listener) => listeners.push(listener));
    expect(listeners).toHaveLength(1);

    trackPid(999, "sidecar");
    listeners[0]();
    expect(listTrackedProcesses()).toEqual([]);
  });
});
