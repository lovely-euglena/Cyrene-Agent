/**
 * Live2DHostClient 测试（#257 T5）。
 *
 * 覆盖：双轨开关 / exe 解析纯函数（打包态 resources、开发态 publish 优先）/
 * 空 mode 启动参数 / event 信封路由 / 逐调用超时覆盖 / load 长超时 /
 * 错误帧 errorCode 解包。进程生命周期骨架复用 LineHostClient（已有专测）。
 *
 * 注：裸 require("electron") 在 vitest 下不可靠（会加载真实 electron 挂起，
 * 同 vault-save-fallback 先例）——exe 解析走纯函数注入，开关走 config mock，
 * 进程测试用 resolveExe 覆盖的测试子类。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  engine: "web" as "dotnet" | "web",
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../windows/native-windows-host", () => ({
  resolveNativeWindowsExe: vi.fn(() => null),
}));
vi.mock("../dotnet-backend/config", () => ({
  resolveDotnetConfig: () => ({ live2dEngine: mocks.engine }),
}));

import { __setSecretsDataDirForTests } from "../dotnet-backend/secrets-client";
import {
  LIVE2D_LOAD_TIMEOUT_MS,
  Live2DHostClient,
  resolveLive2DExe,
} from "./live2d-host-client";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout: PassThrough | null = new PassThrough();
  stderr = new PassThrough();
  stdin = { writable: true, write: vi.fn(() => true) };
  kill = vi.fn();
}

/** 测试子类：exe 解析注入（不经 require("electron")）。 */
class TestClient extends Live2DHostClient {
  constructor(private readonly exe: string | null) { super(); }
  protected resolveExe(): string | null { return this.exe; }
}

async function boot(client: Live2DHostClient, child: FakeChild): Promise<void> {
  const started = client.ensureStarted();
  child.emit("spawn");
  await expect(started).resolves.toBe(true);
}

let tmpRoot: string;

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.engine = "web";
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "live2d-client-test-"));
  __setSecretsDataDirForTests("C:\\fake\\userData");
});

afterEach(() => {
  vi.useRealTimers();
  __setSecretsDataDirForTests(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在开发态目录布局里放一个假 exe。 */
function placeDevExe(subdir: string[] = []): string {
  const dir = path.join(tmpRoot, "dotnet", "live2d", "CyreneLive2D", "bin", "Release", "net10.0-windows", ...subdir);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "cyrene-live2d.exe");
  fs.writeFileSync(exe, "fake");
  return exe;
}

describe("开关与 exe 解析", () => {
  it("enabled() 跟随 live2dEngine（默认 web）", () => {
    const client = new Live2DHostClient();
    expect(client.enabled()).toBe(false);
    mocks.engine = "dotnet";
    expect(client.enabled()).toBe(true);
  });

  it("开发态：publish 输出优先于普通构建输出", () => {
    const app = { isPackaged: false, getAppPath: () => tmpRoot };
    const devExe = placeDevExe();
    expect(resolveLive2DExe(app, undefined)).toBe(devExe);
    const publishExe = placeDevExe(["win-x64", "publish"]);
    expect(resolveLive2DExe(app, undefined)).toBe(publishExe);
  });

  it("开发态 exe 缺失 / app 缺失：null（门面据此回退 web 轨）", () => {
    const app = { isPackaged: false, getAppPath: () => tmpRoot };
    expect(resolveLive2DExe(app, undefined)).toBeNull();
    expect(resolveLive2DExe(undefined, undefined)).toBeNull();
  });

  it("打包态：resources/live2d/ 下找 exe；缺失 null", () => {
    const resources = path.join(tmpRoot, "resources");
    const app = { isPackaged: true, getAppPath: () => tmpRoot };
    expect(resolveLive2DExe(app, resources)).toBeNull();
    const dir = path.join(resources, "live2d");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, "cyrene-live2d.exe");
    fs.writeFileSync(exe, "fake");
    expect(resolveLive2DExe(app, resources)).toBe(exe);
    expect(resolveLive2DExe(app, undefined)).toBeNull();
  });

  it("exe 缺失：ensureStarted false，不 spawn", async () => {
    const client = new TestClient(null);
    await expect(client.ensureStarted()).resolves.toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("空 mode：argv 只有 --data-dir（无空字符串/mode 段）", async () => {
    const exe = placeDevExe();
    const client = new TestClient(exe);
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    await boot(client, child);
    expect(mocks.spawn.mock.calls[0][0]).toBe(exe);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["--data-dir", "C:\\fake\\userData"]);
  });
});

describe("帧路由", () => {
  it("event 信封 {op:event,name,payload} 派发给订阅者", async () => {
    vi.useFakeTimers();
    const client = new TestClient(placeDevExe());
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    await boot(client, child);

    const listener = vi.fn();
    client.addEventListener(listener);
    child.stdout!.write('{"op":"event","name":"hit","payload":{"areas":["表情回正花"],"x":10,"y":20}}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      op: "event",
      name: "hit",
      payload: { areas: ["表情回正花"], x: 10, y: 20 },
    });
    client.removeEventListener(listener);
  });

  it("错误帧 errorCode 挂到 Error（E_CORE_MISSING 可分类回退）", async () => {
    vi.useFakeTimers();
    const client = new TestClient(placeDevExe());
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    await boot(client, child);

    const pending = client.load("C:\\models\\cyrene\\Cyrene.model3.json").catch((e: Error & { errorCode?: string }) => e);
    const frame = JSON.parse(String(child.stdin.write.mock.calls[0][0])) as { op: string; callId: string; modelPath: string };
    expect(frame.op).toBe("load");
    expect(frame.modelPath).toBe("C:\\models\\cyrene\\Cyrene.model3.json");
    child.stdout!.write(`${JSON.stringify({ op: "result", callId: frame.callId, ok: false, error: "Core 缺失", errorCode: "E_CORE_MISSING" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err.errorCode).toBe("E_CORE_MISSING");
  });

  it("load 使用长超时（Core 下载）：默认 10s 到点不重置", async () => {
    vi.useFakeTimers();
    const client = new TestClient(placeDevExe());
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    await boot(client, child);

    const pending = client.load("C:\\models\\Cyrene.model3.json").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled(); // 默认超时到点不杀
    expect(client.isAlive()).toBe(true);

    await vi.advanceTimersByTimeAsync(LIVE2D_LOAD_TIMEOUT_MS - 10_000);
    const err = await pending;
    expect(String(err.message)).toContain("超时");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("逐调用超时覆盖：短超时 op 不受默认值影响", async () => {
    vi.useFakeTimers();
    const client = new TestClient(placeDevExe());
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    await boot(client, child);

    const pending = client.call("show", {}, 50).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(String((await pending).message)).toContain("50ms");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
