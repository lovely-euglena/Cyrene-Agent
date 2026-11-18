/**
 * PetSidecarBackend 门面测试（#257 T5）。
 *
 * 覆盖：ensureReady 装配序列/失败回退（不留孤儿）/显隐+停帧/缩放几何/
 * 拖拽事件→DIP 落位→持久化/行为通道路由/captureFrame/dispose。
 * 客户端全桩注入，无进程、无 electron 依赖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  electron: {
    app: {
      isPackaged: false,
      getAppPath: vi.fn(() => "C:\\fake\\app"),
    },
  },
}));

vi.mock("electron", () => mocks.electron);

import { IPC } from "../../shared/ipc-channels";
import type { Live2DHostClient } from "./live2d-host-client";
import { PetSidecarBackend, resolveLive2DModelPathFrom, type PetSidecarDeps } from "./pet-sidecar-backend";

function makeClient() {
  const listeners: Array<(frame: Record<string, unknown>) => void> = [];
  const stub = {
    enabled: vi.fn(() => true),
    ensureStarted: vi.fn(async () => true),
    isAlive: vi.fn(() => true),
    load: vi.fn(async () => ({})),
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => ({})),
    setBounds: vi.fn(async () => ({})),
    setZoom: vi.fn(async () => ({ zoom: 1 })),
    setAlwaysOnTop: vi.fn(async () => ({})),
    setInteractive: vi.fn(async () => ({})),
    setDragging: vi.fn(async () => ({})),
    pause: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    play: vi.fn(async () => ({ played: true })),
    speechPrepare: vi.fn(async () => ({})),
    mouthStart: vi.fn(async () => ({})),
    mouthStop: vi.fn(async () => ({})),
    captureFrame: vi.fn(async () => ({ width: 400, height: 500, png: "QUJD" })),
    getDiagnostics: vi.fn(async () => ({ loaded: true })),
    shutdown: vi.fn(async () => {}),
    addEventListener: vi.fn((l: (frame: Record<string, unknown>) => void) => { listeners.push(l); }),
    removeEventListener: vi.fn((l: (frame: Record<string, unknown>) => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    }),
    emit: (frame: Record<string, unknown>) => { for (const l of [...listeners]) l(frame); },
  };
  return stub;
}

type ClientStub = ReturnType<typeof makeClient>;

function ev(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { op: "event", name, payload };
}

function makeDeps(client: ClientStub, overrides: Partial<PetSidecarDeps> = {}): PetSidecarDeps {
  return {
    client: client as unknown as Live2DHostClient,
    resolveModelPath: () => "C:\\models\\cyrene\\Cyrene.model3.json",
    loadSettings: () => ({ petWindowX: 100, petWindowY: 200, petZoom: 1, petAlwaysOnTop: true }),
    persistPosition: vi.fn(),
    resolveInitialPosition: (settings, _w, _h) => ({ x: settings.petWindowX ?? 0, y: settings.petWindowY ?? 0 }),
    getDisplayScaleFactor: () => 1,
    log: vi.fn(),
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pet-sidecar-test-"));
  mocks.electron.app.isPackaged = false;
  mocks.electron.app.getAppPath.mockReturnValue(tmpRoot);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureReady 装配与回退", () => {
  it("成功序列：load → 几何/缩放/置顶 → show+resume", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client, {
      loadSettings: () => ({ petWindowX: 100, petWindowY: 200, petZoom: 1.5, petAlwaysOnTop: true }),
    }));
    await expect(backend.ensureReady(true)).resolves.toBe(true);
    expect(client.load).toHaveBeenCalledWith("C:\\models\\cyrene\\Cyrene.model3.json");
    expect(client.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 600, height: 750 });
    expect(client.setZoom).toHaveBeenCalledWith(1.5);
    expect(client.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(client.show).toHaveBeenCalledTimes(1);
    expect(client.resume).toHaveBeenCalledTimes(1);
    expect(client.pause).not.toHaveBeenCalled();
    expect(backend.isReady()).toBe(true);
    expect(backend.isVisible()).toBe(true);
    expect(backend.getPosition()).toEqual({ x: 100, y: 200 });
    await backend.dispose();
  });

  it("showOnReady=false：pause 不 show（启动闪屏场景）", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await expect(backend.ensureReady(false)).resolves.toBe(true);
    expect(client.pause).toHaveBeenCalledTimes(1);
    expect(client.show).not.toHaveBeenCalled();
    expect(backend.isVisible()).toBe(false);
    await backend.dispose();
  });

  it("开关关闭 / exe 缺失 / 模型缺失 / load 失败：均回退 false，失败不留孤儿", async () => {
    // 开关关闭：不 spawn
    const c1 = makeClient();
    c1.enabled.mockReturnValue(false);
    const b1 = new PetSidecarBackend(makeDeps(c1));
    await expect(b1.ensureReady(true)).resolves.toBe(false);
    expect(c1.ensureStarted).not.toHaveBeenCalled();

    // exe 缺失
    const c2 = makeClient();
    c2.ensureStarted.mockResolvedValue(false);
    const b2 = new PetSidecarBackend(makeDeps(c2));
    await expect(b2.ensureReady(true)).resolves.toBe(false);
    expect(c2.load).not.toHaveBeenCalled();

    // 模型缺失：已 spawn → 必须 shutdown
    const c3 = makeClient();
    const b3 = new PetSidecarBackend(makeDeps(c3, { resolveModelPath: () => null }));
    await expect(b3.ensureReady(true)).resolves.toBe(false);
    expect(c3.shutdown).toHaveBeenCalledTimes(1);

    // load 失败（Core 缺失等）：shutdown + 错误日志
    const c4 = makeClient();
    c4.load.mockRejectedValue(Object.assign(new Error("Core 缺失"), { errorCode: "E_CORE_MISSING" }));
    const log = vi.fn();
    const b4 = new PetSidecarBackend(makeDeps(c4, { log }));
    await expect(b4.ensureReady(true)).resolves.toBe(false);
    expect(c4.shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    expect(b4.isReady()).toBe(false);
  });

  it("E_CORE_CONSENT 许可闸门：同意→带 consent 重试成功；拒绝/未注入→回退（#257 审计发现 2）", async () => {
    const consentError = () => Object.assign(new Error("须同意 Live2D 许可"), { errorCode: "E_CORE_CONSENT" });

    // 同意：首次 load 拒绝 → 弹窗 true → 带 coreDownloadConsent 重试 → 就绪
    const c1 = makeClient();
    c1.load.mockRejectedValueOnce(consentError()).mockResolvedValueOnce({});
    const confirm1 = vi.fn(async () => true);
    const b1 = new PetSidecarBackend(makeDeps(c1, { confirmCoreDownload: confirm1 }));
    await expect(b1.ensureReady(true)).resolves.toBe(true);
    expect(confirm1).toHaveBeenCalledTimes(1);
    expect(c1.load).toHaveBeenCalledTimes(2);
    expect(c1.load).toHaveBeenNthCalledWith(2, "C:\\models\\cyrene\\Cyrene.model3.json", { coreDownloadConsent: true });
    expect(c1.shutdown).not.toHaveBeenCalled();
    expect(b1.isReady()).toBe(true);
    await b1.dispose();

    // 拒绝：回退 web 轨 + shutdown，不重试
    const c2 = makeClient();
    c2.load.mockRejectedValue(consentError());
    const b2 = new PetSidecarBackend(makeDeps(c2, { confirmCoreDownload: async () => false }));
    await expect(b2.ensureReady(true)).resolves.toBe(false);
    expect(c2.load).toHaveBeenCalledTimes(1);
    expect(c2.shutdown).toHaveBeenCalledTimes(1);

    // 未注入弹窗（无头/测试）：视同拒绝
    const c3 = makeClient();
    c3.load.mockRejectedValue(consentError());
    const b3 = new PetSidecarBackend(makeDeps(c3));
    await expect(b3.ensureReady(true)).resolves.toBe(false);
    expect(c3.shutdown).toHaveBeenCalledTimes(1);

    // 同意但下载/重试仍失败：回退 + shutdown
    const c4 = makeClient();
    c4.load.mockRejectedValueOnce(consentError())
      .mockRejectedValueOnce(Object.assign(new Error("下载失败"), { errorCode: "E_CORE_DOWNLOAD" }));
    const b4 = new PetSidecarBackend(makeDeps(c4, { confirmCoreDownload: async () => true }));
    await expect(b4.ensureReady(true)).resolves.toBe(false);
    expect(c4.load).toHaveBeenCalledTimes(2);
    expect(c4.shutdown).toHaveBeenCalledTimes(1);
  });

  it("finishReady 阶段异常（setBounds/show reject）→ 回退 false 不外抛（#1416 P1-2）", async () => {
    // setBounds reject：window-manager 只挂 then 不挂 catch 时不得变 unhandled rejection
    const c1 = makeClient();
    c1.setBounds.mockRejectedValue(new Error("E_WINDOW"));
    const b1 = new PetSidecarBackend(makeDeps(c1));
    await expect(b1.ensureReady(true)).resolves.toBe(false);
    expect(c1.shutdown).toHaveBeenCalledTimes(1);
    expect(b1.isReady()).toBe(false);

    // show reject（ready 已置位后失败）：同样内收回退
    const c2 = makeClient();
    c2.show.mockRejectedValue(new Error("show 超时"));
    const b2 = new PetSidecarBackend(makeDeps(c2));
    await expect(b2.ensureReady(true)).resolves.toBe(false);
    expect(c2.shutdown).toHaveBeenCalledTimes(1);
  });

  it("confirmCoreDownload 弹窗自身异常 → 回退 false（#1416 P1-2）", async () => {
    const client = makeClient();
    client.load.mockRejectedValueOnce(Object.assign(new Error("须同意 Live2D 许可"), { errorCode: "E_CORE_CONSENT" }));
    const backend = new PetSidecarBackend(makeDeps(client, {
      confirmCoreDownload: () => Promise.reject(new Error("dialog 失败")),
    }));
    await expect(backend.ensureReady(true)).resolves.toBe(false);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it("启动加载期 hide 不丢：desiredVisible 记录，finishReady 落 hide+pause（#1416 P2-2）", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    backend.hide(); // isReady()=false → 仅记录意图
    expect(client.hide).not.toHaveBeenCalled();
    await expect(backend.ensureReady(true)).resolves.toBe(true);
    expect(client.show).not.toHaveBeenCalled();
    expect(client.hide).toHaveBeenCalledTimes(1);
    expect(client.pause).toHaveBeenCalledTimes(1);
    expect(backend.isVisible()).toBe(false);
    await backend.dispose();
  });

  it("load 成功后 dispose 并发：finishReady 开头守卫不再发 show/resume（#1416 P2-2）", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    client.load.mockImplementation(async () => { await backend.dispose(); return {}; });
    await expect(backend.ensureReady(true)).resolves.toBe(false);
    expect(client.show).not.toHaveBeenCalled();
    expect(client.resume).not.toHaveBeenCalled();
  });

  it("重复 ensureReady 复用就绪状态；进程死亡后 isReady false", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    await backend.ensureReady(true);
    expect(client.load).toHaveBeenCalledTimes(1);
    client.isAlive.mockReturnValue(false);
    expect(backend.isReady()).toBe(false);
    await backend.dispose();
  });
});

describe("窗口控制面", () => {
  it("显隐 = show/hide + resume/pause（web 停帧语义）", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    client.show.mockClear();
    client.resume.mockClear();

    backend.hide();
    expect(client.hide).toHaveBeenCalledTimes(1);
    expect(client.pause).toHaveBeenCalledTimes(1);
    expect(backend.isVisible()).toBe(false);

    backend.show();
    expect(client.show).toHaveBeenCalledTimes(1);
    expect(client.resume).toHaveBeenCalledTimes(1);
    expect(backend.isVisible()).toBe(true);
    await backend.dispose();
  });

  it("setZoom：窗口尺寸 round(基准×zoom) + setZoom；越界 clamp 0.5–2", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    client.setBounds.mockClear();

    backend.setZoom(1.5);
    expect(client.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 600, height: 750 });
    expect(client.setZoom).toHaveBeenLastCalledWith(1.5);

    backend.setZoom(5);
    expect(client.setZoom).toHaveBeenLastCalledWith(2);
    backend.setZoom(0.1);
    expect(client.setZoom).toHaveBeenLastCalledWith(0.5);
    await backend.dispose();
  });

  it("moveRelative：DIP 落位直达侧车 setBounds + onMoved", async () => {
    const client = makeClient();
    const onMoved = vi.fn();
    const backend = new PetSidecarBackend(makeDeps(client, { onMoved }));
    await backend.ensureReady(true);
    client.setBounds.mockClear();

    backend.moveRelative(10, -5);
    expect(client.setBounds).toHaveBeenCalledWith({ x: 110, y: 195, width: 400, height: 500 });
    expect(onMoved).toHaveBeenCalledWith({ x: 110, y: 195 });
    await backend.dispose();
  });

  it("置顶/交互/拖拽状态转发", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    backend.setAlwaysOnTop(false);
    backend.setInteractive(true);
    backend.setDragging(true);
    expect(client.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(client.setInteractive).toHaveBeenCalledWith(true);
    expect(client.setDragging).toHaveBeenCalledWith(true);
    await backend.dispose();
  });
});

describe("拖拽事件 → DIP 落位 → 持久化", () => {
  it("dragStart/dragMove/dragEnd：物理像素按显示器缩放换算，16ms 节流", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const persistPosition = vi.fn();
    const backend = new PetSidecarBackend(makeDeps(client, {
      persistPosition,
      getDisplayScaleFactor: () => 2,
    }));
    await backend.ensureReady(true);
    client.setBounds.mockClear();

    client.emit(ev("dragStart", { screenX: 1000, screenY: 1000 }));
    client.emit(ev("dragMove", { screenX: 1020, screenY: 1040 }));
    // 节流窗口内不落位
    expect(client.setBounds).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    // DIP 位移 = (20,40)/2 = (10,20)
    expect(client.setBounds).toHaveBeenCalledWith({ x: 110, y: 220, width: 400, height: 500 });

    client.emit(ev("dragEnd", {}));
    expect(persistPosition).toHaveBeenCalledWith({ x: 110, y: 220 });
    await backend.dispose();
  });

  it("dragMove 无 dragStart 前导：忽略（不跳变）", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    client.setBounds.mockClear();
    client.emit(ev("dragMove", { screenX: 9999, screenY: 9999 }));
    await vi.advanceTimersByTimeAsync(16);
    expect(client.setBounds).not.toHaveBeenCalled();
    await backend.dispose();
  });
});

describe("行为通道路由（sendChannel）", () => {
  it("live2d:* 通道直达侧车 op", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);

    backend.sendChannel(IPC.LIVE2D_SPEECH_PREPARE);
    expect(client.speechPrepare).toHaveBeenCalledTimes(1);

    backend.sendChannel(IPC.LIVE2D_MOUTH_START, { durationMs: 1234 });
    expect(client.mouthStart).toHaveBeenCalledWith(1234);

    backend.sendChannel(IPC.LIVE2D_MOUTH_STOP);
    expect(client.mouthStop).toHaveBeenCalledTimes(1);

    const target = { kind: "expression", name: "墨镜" };
    backend.sendChannel(IPC.LIVE2D_PLAY_ACTION, target);
    expect(client.play).toHaveBeenCalledWith(target);

    // 未知通道忽略（面向渲染进程的通道无等价 op）
    backend.sendChannel("pet:some-renderer-channel", {});
    await backend.dispose();
  });

  it("PET_VISIBILITY_CHANGED / PET_ZOOM 等价窗口语义", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);

    backend.sendChannel(IPC.PET_VISIBILITY_CHANGED, false);
    expect(client.pause).toHaveBeenCalled();
    expect(backend.isVisible()).toBe(false);
    backend.sendChannel(IPC.PET_VISIBILITY_CHANGED, true);
    expect(client.resume).toHaveBeenCalled();
    expect(backend.isVisible()).toBe(true);

    backend.sendChannel(IPC.PET_ZOOM, 1.5);
    expect(client.setZoom).toHaveBeenLastCalledWith(1.5);
    await backend.dispose();
  });
});

describe("诊断与清理", () => {
  it("captureFrame：PNG dataURL；失败 null", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    await expect(backend.captureFrame()).resolves.toBe("data:image/png;base64,QUJD");
    client.captureFrame.mockRejectedValue(new Error("E_RENDER"));
    await expect(backend.captureFrame()).resolves.toBeNull();
    await backend.dispose();
  });

  it("dispose：摘订阅 + shutdown；之后 op 不再下发", async () => {
    const client = makeClient();
    const backend = new PetSidecarBackend(makeDeps(client));
    await backend.ensureReady(true);
    await backend.dispose();
    expect(client.removeEventListener).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(backend.isReady()).toBe(false);
    client.show.mockClear();
    backend.show();
    expect(client.show).not.toHaveBeenCalled();
    // dispose 幂等
    await backend.dispose();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("resolveLive2DModelPathFrom（纯函数，app 切片注入）", () => {
  it("开发态：src/renderer/public 优先；打包态：dist/renderer", () => {
    const app = { isPackaged: false, getAppPath: () => tmpRoot };
    const devModel = path.join(tmpRoot, "src", "renderer", "public", "models", "cyrene", "Cyrene.model3.json");
    fs.mkdirSync(path.dirname(devModel), { recursive: true });
    fs.writeFileSync(devModel, "{}");
    expect(resolveLive2DModelPathFrom(app)).toBe(devModel);

    const packaged = { isPackaged: true, getAppPath: () => tmpRoot };
    expect(resolveLive2DModelPathFrom(packaged)).toBeNull(); // 打包态不看 public
    const prodModel = path.join(tmpRoot, "dist", "renderer", "models", "cyrene", "Cyrene.model3.json");
    fs.mkdirSync(path.dirname(prodModel), { recursive: true });
    fs.writeFileSync(prodModel, "{}");
    expect(resolveLive2DModelPathFrom(packaged)).toBe(prodModel);
  });

  it("模型缺失 / app 缺失：null（回退 web 轨依据）", () => {
    expect(resolveLive2DModelPathFrom({ isPackaged: false, getAppPath: () => tmpRoot })).toBeNull();
    expect(resolveLive2DModelPathFrom(undefined)).toBeNull();
  });
});
