import { describe, expect, it, vi } from "vitest";

// tray.ts 顶层 import electron（Tray/Menu/nativeImage），统一 mock 掉
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  Tray: class {
    setContextMenu = vi.fn();
    setToolTip = vi.fn();
  },
  app: { quit: vi.fn() },
}));

import { buildTrayMenuTemplate, createTray, type CreateTrayDependencies } from "./tray";
import type { WindowActivationRequest } from "./application/window-activation";

function makeDeps(): { deps: CreateTrayDependencies; requests: WindowActivationRequest[] } {
  const requests: WindowActivationRequest[] = [];
  return {
    requests,
    deps: {
      requestActivation: (request) => { requests.push(request); },
      togglePetWindow: vi.fn(),
      quit: vi.fn(),
    },
  };
}

function clickByLabel(template: ReturnType<typeof buildTrayMenuTemplate>): Map<string, () => void> {
  return new Map(template.map((item) => [item.label, item.click as () => void]));
}

describe("buildTrayMenuTemplate", () => {
  it("drag-mode toggle routes through setPetDragMode with checkbox sync", () => {
    const { deps } = makeDeps();
    const setPetDragMode = vi.fn((enabled: boolean) => enabled);
    deps.setPetDragMode = setPetDragMode;
    const template = buildTrayMenuTemplate(deps);
    const dragItem = template.find((item) => item.label === "桌宠拖动模式");
    expect(dragItem).toBeDefined();
    expect(dragItem?.type).toBe("checkbox");

    // menuItem.checked 读写由 electron 维护——用桩模拟
    const state = { checked: true };
    dragItem?.click?.({ checked: state.checked, ...state } as Electron.MenuItem, null as never, null as never);
    expect(setPetDragMode).toHaveBeenCalledWith(true);
  });

  it("maps window menu items to activation requests", () => {
    const { deps, requests } = makeDeps();
    const clicks = clickByLabel(buildTrayMenuTemplate(deps));

    clicks.get("打开聊天窗口")!();
    clicks.get("打开状态面板")!();
    clicks.get("设置")!();

    expect(requests).toEqual([
      { kind: "chat" },
      { kind: "sidebar" },
      { kind: "settings" },
    ]);
  });

  it("keeps pet toggle and quit immediate instead of activation requests", () => {
    const { deps, requests } = makeDeps();
    const clicks = clickByLabel(buildTrayMenuTemplate(deps));

    clicks.get("显示/隐藏桌宠")!();
    clicks.get("退出")!();

    expect(deps.togglePetWindow).toHaveBeenCalledOnce();
    expect(deps.quit).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });
});

describe("createTray", () => {
  it("builds the tray with the request-driven menu", async () => {
    const { deps } = makeDeps();
    const electron = await import("electron");
    const tray = createTray(deps);

    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(tray.setContextMenu).toHaveBeenCalledOnce();
    expect(tray.setToolTip).toHaveBeenCalledWith("Cyrene");
  });
});
