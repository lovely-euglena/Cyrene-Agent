import { beforeEach, describe, expect, it, vi } from "vitest";

// 插件管理窗（native WPF）刷新策略回归：
//   1) 进入（spawn）时宿主必推一次完整快照（含各插件实际占用）；
//   2) 快照构建器与「插件操作后重推」「窗内刷新按钮」共用（default-dependencies
//      侧已注释锁定，此处只保证进入必推）；
//   3) 无定时轮询——不主动周期性推送。
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
  spawnNativeWindow,
  disposeNativeWindowsBridge,
  bindNativeDataProviders,
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

describe("native-windows-bridge · 插件管理窗进入即刷新", () => {
  beforeEach(() => {
    disposeNativeWindowsBridge("test-reset");
    for (const fn of Object.values(h.fake)) fn.mockClear();
  });

  it("spawn 插件窗时推送一次完整快照（含占用）", async () => {
    init();
    const snapshot = {
      plugins: [{ id: "demo", storageBytes: 123, memoryBytes: null }],
      limits: { storageQuotaMb: 64, memoryLimitMb: 2048 },
    };
    const getPluginsSnapshot = vi.fn(async () => snapshot);
    bindNativeDataProviders({
      getRuntimeState: vi.fn(),
      getModelConfig: vi.fn(),
      getTasks: vi.fn(async () => []),
      getPluginsSnapshot,
    });

    await spawnNativeWindow("plugins");
    await vi.waitFor(() => {
      expect(h.fake.pushPlugins).toHaveBeenCalledWith(snapshot);
    });
    expect(getPluginsSnapshot).toHaveBeenCalledTimes(1);
    // 进入只推一次：无轮询（本次 spawn 之后不再有推送）
    expect(h.fake.pushPlugins).toHaveBeenCalledTimes(1);
  });

  it("再次进入（重复 spawn）会重新推送，保证回家即刷新", async () => {
    init();
    const getPluginsSnapshot = vi.fn(async () => ({ plugins: [] }));
    bindNativeDataProviders({
      getRuntimeState: vi.fn(),
      getModelConfig: vi.fn(),
      getTasks: vi.fn(async () => []),
      getPluginsSnapshot,
    });

    await spawnNativeWindow("plugins");
    await vi.waitFor(() => expect(h.fake.pushPlugins).toHaveBeenCalledTimes(1));
    await spawnNativeWindow("plugins");
    await vi.waitFor(() => expect(h.fake.pushPlugins).toHaveBeenCalledTimes(2));
    expect(getPluginsSnapshot).toHaveBeenCalledTimes(2);
  });
});
