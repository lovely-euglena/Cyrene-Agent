/**
 * window-manager 双轨接线测试（#257 T5，dotnet 轨）。
 *
 * 门面（PetSidecarBackend）与客户端全桩：验证 window-manager 的桌宠控制面
 * 在 LIVE2D_ENGINE=dotnet 时路由到 sidecar、加载失败一次性回退 web 轨。
 * web 轨回归见 window-manager.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeBackend {
    deps: Record<string, unknown>;
    ready = true;
    visible = false;
    disposed = false;
    ensureReadyResult = true;
    ensureReadyShow: boolean | null = null;
    show = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    setAlwaysOnTop = vi.fn();
    setInteractive = vi.fn();
    setDragging = vi.fn();
    finishDragging = vi.fn();
    setZoom = vi.fn();
    moveRelative = vi.fn();
    moveTo = vi.fn();
    captureFrame = vi.fn(async () => "data:image/png;base64,QUJD");
    sendChannel = vi.fn();
    constructor(deps: Record<string, unknown>) {
      this.deps = deps;
      mocks.backendInstances.push(this);
    }
    isReady(): boolean { return this.ready && !this.disposed; }
    isVisible(): boolean { return this.visible; }
    async ensureReady(showOnReady: boolean): Promise<boolean> {
      this.ensureReadyShow = showOnReady;
      this.ensureReadyResult = mocks.ensureReadyResult;
      if (this.ensureReadyResult) this.visible = showOnReady;
      return this.ensureReadyResult;
    }
    async dispose(): Promise<void> { this.disposed = true; }
  }
  const mocks = {
    engine: "dotnet" as "dotnet" | "web",
    ensureReadyResult: true,
    createPetWindow: vi.fn(),
    resolvePetWindowPosition: vi.fn(() => ({ x: 10, y: 20 })),
    createFromDataURL: vi.fn((url: string) => ({ dataUrl: url })),
    backendInstances: [] as FakeBackend[],
    FakeBackend,
  };
  return mocks;
});

vi.mock("electron", () => ({
  app: { once: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayMatching: vi.fn(() => ({ scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
  nativeImage: { createFromDataURL: mocks.createFromDataURL },
}));
vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: mocks.createPetWindow,
  resolvePetWindowPosition: mocks.resolvePetWindowPosition,
  PET_WINDOW_BASE_HEIGHT: 500,
  PET_WINDOW_BASE_WIDTH: 400,
}));
vi.mock("../dotnet-backend/config", () => ({
  resolveDotnetConfig: () => ({ live2dEngine: mocks.engine }),
}));
vi.mock("../live2d/live2d-host-client", () => ({
  activeLive2DClient: () => ({ fakeClient: true }),
}));
vi.mock("../live2d/pet-sidecar-backend", () => ({
  PetSidecarBackend: mocks.FakeBackend,
  resolveLive2DModelPath: () => "C:\\models\\Cyrene.model3.json",
}));
vi.mock("./create-aux-windows", () => ({
  createCallWindow: vi.fn(), createReactChatWindowShell: vi.fn(), createStickerManagerWindow: vi.fn(),
  createLazyReactChatWindowHandle: vi.fn(), createSettingsWindow: vi.fn(), createSidebarWindow: vi.fn(), createTasksWindow: vi.fn(),
  loadReactChatWindowPage: vi.fn(), loadOnboardingWindowPage: vi.fn(), createOnboardingBrowserWindow: vi.fn(),
  showReactChatWindow: vi.fn(),
}));
vi.mock("./startup-window-load", () => ({ CHAT_READY_TIMEOUT_MS: 1, loadWindowForStartup: vi.fn() }));
vi.mock("./broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../pet-window-movement", () => ({ PetWindowMoveController: class { dispose() {} finishDragging() {} moveRelative() {} queueAbsolute() {} } }));
vi.mock("../../shared/disclaimer", () => ({ CURRENT_DISCLAIMER_VERSION: "current" }));

import { createWindowManager, type WindowManager } from "./window-manager";
import { IPC } from "../../shared/ipc-channels";

function createFakeWindow() {
  return {
    on: vi.fn(),
    once: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setSize: vi.fn(),
    getPosition: vi.fn(() => [0, 0]),
    webContents: { send: vi.fn() },
  };
}

function makeManager(): WindowManager {
  return createWindowManager({
    getCurrentAppIconPath: () => "icon",
    isDev: false,
    loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: "current", petAlwaysOnTop: true }),
    persistPetWindowPosition: vi.fn(),
  });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engine = "dotnet";
  mocks.ensureReadyResult = true;
  mocks.backendInstances = [];
  mocks.createPetWindow.mockImplementation(() => createFakeWindow());
});

describe("dotnet 轨：桌宠控制面路由到 sidecar", () => {
  it("createPetWindow 返回 null，门面装配注入完整依赖", async () => {
    const manager = makeManager();
    expect(manager.createPetWindow(true)).toBeNull();
    await flush();
    expect(mocks.backendInstances).toHaveLength(1);
    const backend = mocks.backendInstances[0];
    expect(backend.ensureReadyShow).toBe(true);
    expect(backend.deps.client).toEqual({ fakeClient: true });
    expect(backend.deps.resolveModelPath).toBeTypeOf("function");
    expect(backend.deps.resolveInitialPosition).toBe(mocks.resolvePetWindowPosition);
    expect(mocks.createPetWindow).not.toHaveBeenCalled();
  });

  it("显隐/切换/最小化路由", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    const backend = mocks.backendInstances[0];

    manager.hidePetWindow();
    expect(backend.hide).toHaveBeenCalledTimes(1);
    manager.showPetWindow();
    expect(backend.show).toHaveBeenCalledTimes(1);
    manager.togglePetWindow(); // visible → hide
    expect(backend.hide).toHaveBeenCalledTimes(2);
    manager.togglePetWindow(); // hidden → show
    expect(backend.show).toHaveBeenCalledTimes(2);
    manager.minimizePetWindow();
    expect(backend.hide).toHaveBeenCalledTimes(3);
  });

  it("置顶/交互/拖拽/拖动模式路由", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    const backend = mocks.backendInstances[0];

    manager.setPetWindowAlwaysOnTop(false);
    expect(backend.setAlwaysOnTop).toHaveBeenCalledWith(false);
    manager.setPetWindowInteractive(true);
    expect(backend.setInteractive).toHaveBeenCalledWith(true);
    manager.setPetWindowDragging(true);
    expect(backend.setDragging).toHaveBeenCalledWith(true);
    manager.setPetWindowDragging(false);
    expect(backend.finishDragging).toHaveBeenCalledTimes(1);

    expect(manager.setPetDragMode(true)).toBe(true);
    expect(backend.setInteractive).toHaveBeenLastCalledWith(true);
    expect(manager.getPetDragMode()).toBe(true);
    expect(manager.setPetDragMode(false)).toBe(false);
    expect(manager.getPetDragMode()).toBe(false);
  });

  it("缩放/移动路由", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    const backend = mocks.backendInstances[0];

    manager.applyPetWindowZoom(1.5);
    expect(backend.setZoom).toHaveBeenCalledWith(1.5);
    manager.movePetWindowRelative(10, -5);
    expect(backend.moveRelative).toHaveBeenCalledWith(10, -5);
    manager.movePetWindowTo(100, 200);
    expect(backend.moveTo).toHaveBeenCalledWith(100, 200);
  });

  it("sendToPetWindow → 门面行为通道", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    const backend = mocks.backendInstances[0];
    manager.sendToPetWindow(IPC.LIVE2D_MOUTH_START, { durationMs: 999 });
    expect(backend.sendChannel).toHaveBeenCalledWith(IPC.LIVE2D_MOUTH_START, { durationMs: 999 });
  });

  it("截图：captureFrame dataURL / NativeImage 转换", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    await expect(manager.capturePetWindowFrame()).resolves.toBe("data:image/png;base64,QUJD");
    const image = await manager.capturePetWindow();
    expect(mocks.createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,QUJD");
    expect(image).toEqual({ dataUrl: "data:image/png;base64,QUJD" });
  });

  it("dispose 清理门面", async () => {
    const manager = makeManager();
    manager.createPetWindow(true);
    await flush();
    const backend = mocks.backendInstances[0];
    manager.dispose();
    await flush();
    expect(backend.disposed).toBe(true);
  });
});

describe("dotnet 轨：加载失败一次性回退 web", () => {
  it("ensureReady false → 建 BrowserWindow + 清理门面；后续不再尝试 sidecar", async () => {
    mocks.ensureReadyResult = false;
    const manager = makeManager();

    expect(manager.createPetWindow(true)).toBeNull();
    await flush();
    const failed = mocks.backendInstances[0];
    expect(failed.disposed).toBe(true);
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(1); // 回退建窗

    // 回退后再次 createPetWindow 复用已建 web 窗（不再新建门面）
    const win2 = manager.createPetWindow(true);
    await flush();
    expect(win2).not.toBeNull();
    expect(mocks.backendInstances).toHaveLength(1);
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(1);
  });
});

describe("web 轨不受影响", () => {
  it("LIVE2D_ENGINE=web：createPetWindow 返回 BrowserWindow，不建门面", async () => {
    mocks.engine = "web";
    const manager = makeManager();
    const win = manager.createPetWindow(true);
    await flush();
    expect(win).not.toBeNull();
    expect(mocks.backendInstances).toHaveLength(0);
    expect(mocks.createPetWindow).toHaveBeenCalledTimes(1);
  });
});
