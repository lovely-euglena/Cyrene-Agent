import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import { type WindowActivationRequest } from "./application/window-activation";
import { getCurrentAppIconPath } from "./windows/window-state";

export interface CreateTrayDependencies {
  /** 托盘窗口类菜单统一走激活请求；是否立即打开由 activation broker 决定。 */
  requestActivation(request: WindowActivationRequest): void;
  /** 桌宠开关保持立即执行：桌宠不接收通用主窗口激活请求。 */
  togglePetWindow(): void;
  /**
   * 桌宠拖动模式兜底开关（Windows 透明窗 forward 竞态的保险）：
   * 开启后桌宠窗口整体进入交互态（关穿透），鼠标任意位置可拖动。
   * 返回切换后的新状态（菜单项 label 复选框用）。
   */
  setPetDragMode?(enabled: boolean): boolean;
  quit(): void;
}

export function buildTrayMenuTemplate(deps: CreateTrayDependencies): MenuItemConstructorOptions[] {
  return [
    {
      label: "打开聊天窗口",
      click: () => { deps.requestActivation({ kind: "chat" }); },
    },
    {
      label: "打开状态面板",
      click: () => { deps.requestActivation({ kind: "sidebar" }); },
    },
    {
      label: "设置",
      click: () => { deps.requestActivation({ kind: "settings" }); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => { deps.togglePetWindow(); },
    },
    {
      label: "桌宠拖动模式",
      type: "checkbox",
      checked: false,
      click: (menuItem) => {
        const next = deps.setPetDragMode?.(menuItem.checked) ?? menuItem.checked;
        // 同步复选框状态（setPetDragMode 可能拒绝该状态）
        menuItem.checked = next;
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { deps.quit(); },
    },
  ];
}

export function createTray(deps: CreateTrayDependencies): Tray {
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate(deps));

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);

  return tray;
}
