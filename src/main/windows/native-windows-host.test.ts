/**
 * NativeWindowsClient 帧协议测试（mock 子进程——不真 spawn）。
 *
 * 回归背景：.NET 侧 prefix/body 是两次 Write，Windows 管道上分块到达。
 * 旧实现 `take(4)` 消费前缀后若帧体未到便直接 return，长度状态丢失，
 * 下一块数据（{"id...）被当成新前缀 → bad frame length → 全窗口 spawn
 * 失败。本文件锁定「前缀与帧体分块到达仍能正确解析」的行为。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", () => {
  const spawn = vi.fn();
  return { spawn };
});

import { spawn as mockSpawn } from "node:child_process";
import { NativeWindowsClient } from "./native-windows-host";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4321;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
  });
  return child;
}

function frame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  return Buffer.concat([prefix, json]);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("NativeWindowsClient 帧协议（分块容错）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ready 逐字节到达也能完成握手", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake);
    const client = new NativeWindowsClient("C:/fake/cyrene-native.exe", {
      onCommand: vi.fn(),
    });

    const started = client.ensureStarted();
    for (const byte of frame({ id: 0, op: "ready" })) {
      fake.stdout.write(Buffer.from([byte]));
      await tick();
    }
    await expect(started).resolves.toBeUndefined();
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("应答帧前缀与帧体分块到达仍能路由回调用方", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake);
    const client = new NativeWindowsClient("C:/fake/cyrene-native.exe", {
      onCommand: vi.fn(),
    });

    const started = client.ensureStarted();
    fake.stdout.write(frame({ id: 0, op: "ready" }));
    await started;

    const pending = client.pushRuntimeState({ demo: 1 });
    await tick();

    // 关键：前缀（4B）与帧体分两次到达——旧实现会在此错位
    const reply = frame({ id: 1, ok: true });
    fake.stdout.write(reply.subarray(0, 4));
    await tick();
    fake.stdout.write(reply.subarray(4));

    await expect(pending).resolves.toBeUndefined();
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("坏帧长度（无前缀的 JSON 流）仍触发回收并拒绝在途请求", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake);
    const client = new NativeWindowsClient("C:/fake/cyrene-native.exe", {
      onCommand: vi.fn(),
    });

    const started = client.ensureStarted();
    fake.stdout.write(frame({ id: 0, op: "ready" }));
    await started;

    const pending = client.pushRuntimeState({ demo: 2 });
    await tick();
    // 模拟历史故障流：裸 JSON 帧体（错误当长度读）
    fake.stdout.write(Buffer.from('{"id', "utf8"));

    await expect(pending).rejects.toThrow(/protocol failure/);
    expect(fake.kill).toHaveBeenCalled();
  });
});