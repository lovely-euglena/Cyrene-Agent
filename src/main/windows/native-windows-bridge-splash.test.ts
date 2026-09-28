import { beforeEach, describe, expect, it, vi } from "vitest";

// 用假客户端替换 native-windows-host 的单例获取，验证「关闭早于 spawn 落地」
// 的冷启动竞态：reveal 发出的 win.close 打空后，spawn 落地必须补关 splash，
// 否则启动屏会常驻桌面。
const h = vi.hoisted(() => {
  const fake = {
    spawnWindow: vi.fn(async () => {}),
    showWindow: vi.fn(async () => {}),
    closeWindow: vi.fn(async () => {}),
    pushRuntimeState: vi.fn(async () => {}),
    pushModelConfig: vi.fn(async () => {}),
    pushTasks: vi.fn(async () => {}),
    pushPlugins: vi.fn(async () => {}),
    pushSettings: vi.fn(async () => {}),
    pushSettingsNotice: vi.fn(async () => {}),
    pushLayout: vi.fn(async () => {}),
    disposeSync: vi.fn(),
  };
  return { fake };
});

vi.mock("./native-windows-host", () => ({
  getNativeWindowsClient: () => h.fake,
  NativeWindowsClient: class {},
}));

import {
  initNativeWindowsBridge,
  closeNativeWindow,
  spawnNativeWindow,
  disposeNativeWindowsBridge,
} from "./native-windows-bridge";

function init(): void {
  initNativeWindowsBridge({
    openSettings: vi.fn(),
    openChatWindow: vi.fn(),
    openCallWindow: vi.fn(),
    toggleSidebarPin: vi.fn(),
    onSplashShown: vi.fn(),
  });
}

describe("native-windows-bridge · splash 冷启动竞态", () => {
  beforeEach(() => {
    disposeNativeWindowsBridge("test-reset");
    for (const fn of Object.values(h.fake)) fn.mockClear();
  });

  it("关闭请求早于 spawn 落地时，spawn 后补关 splash", async () => {
    init();
    // reveal 先到：此刻 native 进程/win.spawn 尚未落地 → 这次关闭打空
    await closeNativeWindow("splash");
    h.fake.closeWindow.mockClear();

    // 之后 native 侧才完成 spawn + show
    await spawnNativeWindow("splash");

    expect(h.fake.spawnWindow).toHaveBeenCalledWith("splash", undefined);
    expect(h.fake.showWindow).toHaveBeenCalledWith("splash");
    expect(h.fake.closeWindow).toHaveBeenCalledWith("splash");
  });

  it("正常次序（spawn → show → close）只关一次且无补关", async () => {
    init();
    await spawnNativeWindow("splash");
    h.fake.closeWindow.mockClear();
    await closeNativeWindow("splash");
    expect(h.fake.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.fake.closeWindow).toHaveBeenCalledWith("splash");
  });

  it("非 splash 窗口不受该标志影响", async () => {
    init();
    await spawnNativeWindow("tasks");
    h.fake.closeWindow.mockClear();
    await closeNativeWindow("tasks");
    expect(h.fake.closeWindow).toHaveBeenCalledTimes(1);
  });
});
