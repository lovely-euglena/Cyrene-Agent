/**
 * tray-pipe 共享链路重连/超时/发送门控测试（IKJK51 复审 P2-5）。
 * node:net / node:fs 以假 socket + 假管道命名空间替换（真实链路为 Windows 专属）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeSocketLike {
  written: string[];
  destroyed: boolean;
  emit(event: string, ...args: unknown[]): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}

const state = vi.hoisted(() => ({
  pipeAvailable: true,
  sockets: [] as unknown[],
  connectCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(() => (state.pipeAvailable ? ["lsass", "cyrene-tray"] : ["lsass"])),
  };
});

vi.mock("node:net", () => {
  class FakeSocket {
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly written: string[] = [];
    destroyed = false;

    setEncoding(): void { /* 假 socket 不关心编码 */ }

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
    }

    write(data: string): boolean {
      this.written.push(data);
      return true;
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("close");
    }
  }
  return {
    connect: vi.fn(() => {
      state.connectCalls += 1;
      const socket = new FakeSocket();
      state.sockets.push(socket);
      return socket;
    }),
  };
});

import {
  __resetTrayPipeLinkForTests,
  acquireTrayPipeLink,
} from "./tray-pipe";

function lastSocket(): FakeSocketLike {
  return state.sockets[state.sockets.length - 1] as FakeSocketLike;
}

describe("tray-pipe 重连/超时/门控（复审 P2-5）", () => {
  beforeEach(() => {
    state.pipeAvailable = true;
    state.sockets.length = 0;
    state.connectCalls = 0;
    __resetTrayPipeLinkForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetTrayPipeLinkForTests();
    vi.useRealTimers();
  });

  it("未连接时 send 静默门控（不抛、不写）", () => {
    const link = acquireTrayPipeLink();
    expect(() => link.send({ op: "tray.ready" })).not.toThrow();
    expect(state.sockets).toHaveLength(0);
  });

  it("连接超时：3s 内无 connect → false（socket 销毁）", async () => {
    const link = acquireTrayPipeLink();
    const pending = link.connect();
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(pending).resolves.toBe(false);
    expect(link.isConnected()).toBe(false);
    expect(lastSocket().destroyed).toBe(true);
  });

  it("连接成功后可写；断线 send 重新门控", async () => {
    const link = acquireTrayPipeLink();
    const pending = link.connect();
    lastSocket().emit("connect");
    await expect(pending).resolves.toBe(true);
    link.send({ op: "tray.ready" });
    expect(lastSocket().written.join("")).toContain('"op":"tray.ready"');

    lastSocket().emit("close");
    link.send({ op: "tray.tooltip" });
    expect(lastSocket().written.join("")).not.toContain("tray.tooltip");
  });

  it("断线后自动重连：退避 1s → 2s（首次成功后启用）", async () => {
    const link = acquireTrayPipeLink();
    const pending = link.connect();
    lastSocket().emit("connect");
    await pending;
    expect(state.connectCalls).toBe(1);

    lastSocket().emit("close");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.connectCalls).toBe(2);

    // 第二次连接超时（3s）→ close → 下次退避 2s
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.connectCalls).toBe(3);
  });

  it("首次连接失败不自动重连（everConnected 门禁）", async () => {
    const link = acquireTrayPipeLink();
    const pending = link.connect();
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.connectCalls).toBe(1);
  });

  it("管道缺失：connect 快速 false，不建 socket", async () => {
    state.pipeAvailable = false;
    const link = acquireTrayPipeLink();
    await expect(link.connect()).resolves.toBe(false);
    expect(state.sockets).toHaveLength(0);
  });
});
