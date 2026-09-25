// native 窗口 cmd 动作 → 宿主回调的接线测试。
//
// 回归背景（本轮核对发现）：native 设置窗的「在旧版设置中打开」「打开渠道配置」
// 「打开插件管理」三类按钮发送的动作（open-legacy / openChannels / plugins open）
// 在宿主 switch 中从未有 case → 点击无反应（死按钮）。本测试把 C# 动作名
// 与宿主分发接线锁死：mock native-windows-host 捕获 host.onCommand，注入 cmd 帧。

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Frame {
  op?: string;
  name?: string;
  kind?: string;
  action?: string;
  section?: string;
  [key: string]: unknown;
}

let capturedHost: { onCommand(frame: Frame): void } | null = null;

vi.mock("./native-windows-host", () => ({
  getNativeWindowsClient: (host: { onCommand(frame: Frame): void }) => {
    capturedHost = host;
    return { disposeSync: vi.fn() } as never;
  },
  NativeWindowsClient: class {},
}));

import { disposeNativeWindowsBridge, initNativeWindowsBridge } from "./native-windows-bridge";

function initBridge() {
  capturedHost = null;
  const actions = {
    openSettings: vi.fn(),
    openChatWindow: vi.fn(),
    openCallWindow: vi.fn(),
    toggleSidebarPin: vi.fn(),
    cycleModelProvider: vi.fn(),
    onSplashShown: vi.fn(),
    setSetting: vi.fn(),
    setUserProfile: vi.fn(),
    pickAvatar: vi.fn(),
    openLegacySettings: vi.fn(),
    openPluginManager: vi.fn(),
    openChannelsWindow: vi.fn(),
    pluginAction: vi.fn(),
    apiAction: vi.fn(),
    memoryAction: vi.fn(),
    schedulerAction: vi.fn(),
  };
  const client = initNativeWindowsBridge(actions as never);
  expect(client).not.toBeNull();
  expect(capturedHost).not.toBeNull();
  return actions;
}

function dispatch(frame: Frame): void {
  capturedHost!.onCommand({ op: "event", name: "cmd", ...frame });
}

describe("native-windows-bridge · cmd 动作分发", () => {
  beforeEach(() => {
    disposeNativeWindowsBridge("test-reset");
  });

  it("open-legacy 带 section → Electron 旧版设置页回调（含 section 透传）", () => {
    const actions = initBridge();
    dispatch({ kind: "settings", action: "open-legacy", section: "api" });
    expect(actions.openLegacySettings).toHaveBeenCalledTimes(1);
    expect(actions.openLegacySettings).toHaveBeenCalledWith("api");

    // 通用/外观等 section 同样透传
    dispatch({ kind: "settings", action: "open-legacy", section: "general" });
    expect(actions.openLegacySettings).toHaveBeenLastCalledWith("general");
  });

  it("openChannels → 渠道独立窗回调", () => {
    const actions = initBridge();
    dispatch({ kind: "settings", action: "openChannels" });
    expect(actions.openChannelsWindow).toHaveBeenCalledTimes(1);
  });

  it("plugins open → 插件管理窗回调；非 plugins kind 的同名动作不触发", () => {
    const actions = initBridge();
    dispatch({ kind: "plugins", action: "open" });
    expect(actions.openPluginManager).toHaveBeenCalledTimes(1);

    dispatch({ kind: "settings", action: "open" });
    expect(actions.openPluginManager).toHaveBeenCalledTimes(1);
  });

  it("plugins openWindow → 打开插件自有窗口（带 id）；open 仍归管理窗入口", () => {
    const actions = initBridge();
    dispatch({ kind: "plugins", action: "openWindow", id: "my-plugin" });
    expect(actions.pluginAction).toHaveBeenCalledWith("openWindow", "my-plugin");
    expect(actions.openPluginManager).not.toHaveBeenCalled();
  });

  it("settings set / set-user-profile / pick-avatar → 对应回调", () => {
    const actions = initBridge();
    dispatch({ kind: "settings", action: "set", key: "petVisible", value: false });
    expect(actions.setSetting).toHaveBeenCalledWith("petVisible", false);

    dispatch({ kind: "settings", action: "set-user-profile", profile: { nickname: "昔" } });
    expect(actions.setUserProfile).toHaveBeenCalledWith({ nickname: "昔" });

    dispatch({ kind: "settings", action: "pick-avatar" });
    expect(actions.pickAvatar).toHaveBeenCalledTimes(1);
  });

  it("api/memory/scheduler 命名空间动作 → verb + payload 透传", () => {
    const actions = initBridge();

    dispatch({ kind: "settings", action: "api", verb: "save", payload: { config: { model: "m" } } });
    expect(actions.apiAction).toHaveBeenCalledWith("save", { config: { model: "m" } });

    dispatch({ kind: "settings", action: "memory", verb: "vault-sync" });
    expect(actions.memoryAction).toHaveBeenCalledWith("vault-sync", {});

    dispatch({ kind: "settings", action: "scheduler", verb: "toggle", payload: { id: "t1", enabled: true } });
    expect(actions.schedulerAction).toHaveBeenCalledWith("toggle", { id: "t1", enabled: true });

    // 非法 payload → 空对象；缺失 verb → 空串（由宿主 switch 落入 warn）
    dispatch({ kind: "settings", action: "api", verb: 42, payload: "bad" });
    expect(actions.apiAction).toHaveBeenLastCalledWith("", {});
  });

  it("未知动作不触发任何回调（仅告警）", () => {
    const actions = initBridge();
    dispatch({ kind: "settings", action: "no-such-action" });
    for (const fn of Object.values(actions)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});