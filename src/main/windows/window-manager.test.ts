// 桌宠窗口生命周期：隐藏 = 销毁窗口（连带渲染进程），显示 = 按需重建。
// 历史行为是 hide()（窗口与 Live2D 渲染进程常驻，内存大头）；本测试把
// 「隐藏杀进程、显示重建并恢复置顶/缩放」锁死。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const { createPetWindowMock } = vi.hoisted(() => ({
  createPetWindowMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
  nativeImage: {},
}));

vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: (...args: unknown[]) => createPetWindowMock(...args),
  PET_WINDOW_BASE_WIDTH: 400,
  PET_WINDOW_BASE_HEIGHT: 500,
}));

vi.mock("./create-aux-windows", () => ({
  createCallWindow: vi.fn(),
  createReactChatWindowShell: vi.fn(),
  createLazyReactChatWindowHandle: vi.fn(),
  createSettingsWindow: vi.fn(),
  createSidebarWindow: vi.fn(),
  createStickerManagerWindow: vi.fn(),
  createTasksWindow: vi.fn(),
  loadReactChatWindowPage: vi.fn(),
  showReactChatWindow: vi.fn(),
}));

vi.mock("./startup-window-load", () => ({
  CHAT_READY_TIMEOUT_MS: 1000,
  loadWindowForStartup: vi.fn(async () => undefined),
}));

vi.mock("./broadcast", () => ({ broadcastToAllWindows: vi.fn() }));

import { createWindowManager } from "./window-manager";
import { createLazyReactChatWindowHandle } from "./create-aux-windows";
import { reactChatSettingsSection } from "./window-state";

interface FakeWindow {
  destroyed: boolean;
  visible: boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getPosition: () => [number, number];
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setOpacity: ReturnType<typeof vi.fn>;
  minimize: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  fire: (event: string) => void;
}

function makeFakeWindow(): FakeWindow {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const win: FakeWindow = {
    destroyed: false,
    visible: true,
    webContents: { send: vi.fn() },
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    }),
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    show: vi.fn(() => { win.visible = true; }),
    hide: vi.fn(() => { win.visible = false; }),
    destroy: vi.fn(() => {
      win.destroyed = true;
      win.visible = false;
      for (const cb of listeners.get("closed") ?? []) cb();
    }),
    getPosition: () => [10, 20],
    setAlwaysOnTop: vi.fn(),
    setSize: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setOpacity: vi.fn(),
    minimize: vi.fn(),
    capturePage: vi.fn(async () => null),
    fire: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
  return win;
}

function makeManager() {
  return createWindowManager({
    getCurrentAppIconPath: () => "icon.png",
    isDev: false,
    loadPetWindowSettingsSlice: () => ({ petZoom: 1.2, petAlwaysOnTop: false, petWindowX: 10, petWindowY: 20 }),
    persistPetWindowPosition: vi.fn(),
  });
}

describe("window-manager · 桌宠隐藏回收", () => {
  beforeEach(() => {
    createPetWindowMock.mockReset();
  });

  it("hidePetWindow 销毁窗口（不是 hide）；showPetWindow 懒重建并恢复置顶/缩放", () => {
    const first = makeFakeWindow();
    const second = makeFakeWindow();
    createPetWindowMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = makeManager();

    manager.createPetWindow(true);
    expect(createPetWindowMock).toHaveBeenCalledTimes(1);
    // 创建时按设置恢复置顶（关闭档 = normal）
    expect(first.setAlwaysOnTop).toHaveBeenCalledWith(false, "normal");

    manager.hidePetWindow();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(first.hide).not.toHaveBeenCalled();
    // 已销毁后再次 hide 是 no-op
    manager.hidePetWindow();
    expect(first.destroy).toHaveBeenCalledTimes(1);

    // 显示：懒重建（不闪空窗 → showOnReady=true），恢复置顶并在 ready 后发缩放
    manager.showPetWindow();
    expect(createPetWindowMock).toHaveBeenCalledTimes(2);
    expect(createPetWindowMock.mock.calls[1][1]).toEqual({ showOnReady: true });
    expect(second.setAlwaysOnTop).toHaveBeenCalledWith(false, "normal");
    second.fire("ready-to-show");
    expect(second.webContents.send).toHaveBeenCalledWith(IPC.PET_ZOOM, 1.2);
  });

  it("togglePetWindow：可见时销毁，隐藏后再次切换重建", () => {
    const first = makeFakeWindow();
    const second = makeFakeWindow();
    createPetWindowMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = makeManager();

    manager.createPetWindow(true);
    manager.togglePetWindow();
    expect(first.destroy).toHaveBeenCalledTimes(1);

    manager.togglePetWindow();
    expect(createPetWindowMock).toHaveBeenCalledTimes(2);
    manager.hidePetWindow();
    expect(second.destroy).toHaveBeenCalledTimes(1);
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
    const fake = makeFakeWindow();
    vi.mocked(createLazyReactChatWindowHandle).mockReturnValue({
      window: fake,
      load: vi.fn(async () => undefined),
      show: vi.fn(),
      isMaterialized: () => true,
      isLazy: true,
      onMaterialized: vi.fn(),
    } as never);
    const manager = makeManager();

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
