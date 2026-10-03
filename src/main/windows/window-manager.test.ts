import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { once: vi.fn() },
  createdWindows: [] as Array<ReturnType<typeof createFakeWindow>>,
  createPetWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
}));
vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: mocks.createPetWindow,
  PET_WINDOW_BASE_HEIGHT: 500,
  PET_WINDOW_BASE_WIDTH: 400,
}));
vi.mock("./create-aux-windows", () => ({
  createCallWindow: vi.fn(), createReactChatWindowShell: vi.fn(), createStickerManagerWindow: vi.fn(),
  createLazyReactChatWindowHandle: vi.fn(), createSettingsWindow: vi.fn(), createSidebarWindow: vi.fn(), createTasksWindow: vi.fn(),
  loadReactChatWindowPage: vi.fn(), loadOnboardingWindowPage: vi.fn(), createOnboardingBrowserWindow: vi.fn(),
  showReactChatWindow: vi.fn(),
}));
vi.mock("./startup-window-load", () => ({ CHAT_READY_TIMEOUT_MS: 1, loadWindowForStartup: vi.fn() }));
vi.mock("./create-music-player-window", () => ({ createMusicPlayerWindow: vi.fn() }));
vi.mock("./broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../pet-window-movement", () => ({ PetWindowMoveController: class { dispose() {} finishDragging() {} moveRelative() {} queueAbsolute() {} } }));
vi.mock("../../shared/disclaimer", () => ({ CURRENT_DISCLAIMER_VERSION: "current" }));

function createFakeWindow() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  let visible = false;
  let destroyed = false;
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const wrapped = (...args: any[]) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped));
        listener(...args);
      };
      listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
    }),
    emit(event: string) { for (const listener of [...(listeners.get(event) ?? [])]) listener(); },
    hide: vi.fn(() => { visible = false; for (const listener of [...(listeners.get("hide") ?? [])]) listener(); }),
    show: vi.fn(() => { visible = true; for (const listener of [...(listeners.get("show") ?? [])]) listener(); }),
    destroy: vi.fn(() => { destroyed = true; for (const listener of [...(listeners.get("closed") ?? [])]) listener(); }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    setAlwaysOnTop: vi.fn(),
    getPosition: vi.fn(() => [0, 0]),
    webContents: { send: vi.fn() },
  };
}

import { createWindowManager } from "./window-manager";
import { createLazyReactChatWindowHandle } from "./create-aux-windows";
import { reactChatSettingsSection } from "./window-state";
import { IPC } from "../../shared/ipc-channels";

describe("pet window resource release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createdWindows = [];
    mocks.createPetWindow.mockImplementation(() => {
      const window = createFakeWindow();
      mocks.createdWindows.push(window);
      return window;
    });
  });

  it("destroys a hidden pet window after 30 seconds and recreates it when shown", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: "current", petAlwaysOnTop: true }),
      persistPetWindowPosition: vi.fn(),
    });
    const firstWindow = manager.createPetWindow();

    manager.hidePetWindow();
    vi.advanceTimersByTime(29_999);
    expect(firstWindow.destroy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(firstWindow.destroy).toHaveBeenCalledOnce();

    manager.showPetWindow();
    expect(mocks.createdWindows).toHaveLength(2);
    expect(mocks.createdWindows[1].setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  it("cancels delayed destruction when shown again before the timeout", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: "current" }),
      persistPetWindowPosition: vi.fn(),
    });
    const window = manager.createPetWindow();

    manager.hidePetWindow();
    vi.advanceTimersByTime(20_000);
    manager.showPetWindow();
    vi.advanceTimersByTime(30_000);

    expect(window.destroy).not.toHaveBeenCalled();
    expect(mocks.createdWindows).toHaveLength(1);
    expect(window.show).toHaveBeenCalledOnce();
  });
});

// 设置入口冷启动定位：ready-to-show 早于 React 挂载 onSwitchSection 监听，
// 未 ready 时把 section 挂起，CHATS_REACT_READY（dispatcher.markReady）后由
// chat-ui-ipc 冲发；ready 后直发。丢帧现象 = 「点设置没反应」。
describe("window-manager · 设置入口冷启动定位", () => {
  beforeEach(() => {
    vi.mocked(createLazyReactChatWindowHandle).mockReset();
    reactChatSettingsSection.reset();
  });

  it("未 ready 时挂起 section，ready 后冲发；ready 时直发", async () => {
    const fake = createFakeWindow();
    vi.mocked(createLazyReactChatWindowHandle).mockReturnValue({
      window: fake,
      load: vi.fn(async () => undefined),
      show: vi.fn(),
      isMaterialized: () => true,
      isLazy: true,
      onMaterialized: vi.fn(),
    } as never);
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: "current" }),
      persistPetWindowPosition: vi.fn(),
    });

    // 模拟 React 未 ready（新窗/加载中）
    reactChatSettingsSection.markLoading();
    await manager.openSettings("api");
    expect(fake.webContents.send).not.toHaveBeenCalled();
    expect(reactChatSettingsSection.getPending()).toBe("api");

    // ready 帧到达：dispatcher 交出 pending（chat-ui-ipc 在此 send 给渲染端）
    expect(reactChatSettingsSection.markReady()).toBe("api");

    // ready 后直发
    await manager.openSettings("general");
    expect(fake.webContents.send).toHaveBeenCalledWith(IPC.SETTINGS_SWITCH_SECTION, "general");
  });

  it("窗口关闭/重建时清空挂起队列（防止下次启动回放旧 section）", () => {
    reactChatSettingsSection.markLoading();
    expect(reactChatSettingsSection.queueOrTake("appearance")).toBeNull();
    expect(reactChatSettingsSection.getPending()).toBe("appearance");
    reactChatSettingsSection.reset();
    expect(reactChatSettingsSection.getPending()).toBeNull();
    expect(reactChatSettingsSection.markReady()).toBeNull();
  });
});
