// 分离托盘模式的 Electron 侧客户端。
//
// 架构（见 dotnet/native-windows/TrayHost.cs）：.NET 托盘进程常驻 +
// named pipe cyrene-tray；Electron 成为「按需工作进程」。本模块：
//   - pipe 探测（托盘未运行 → 返回 null，调用方回退内置 Electron Tray）
//   - duck-type Electron Tray（isDestroyed/destroy/setImage/setToolTip），
//     shell-bootstrap 与设置图标的既有消费点零改动
//   - 收 tray cmd → 转发激活/桌宠/退出（与内置托盘菜单同语义）
//   - 发 ready / icon path / notify
//
// 通信协议：JSON 行（\n 分隔，低频控制通道，无需三件套的长度前缀帧）。

import type { NativeImage, Tray } from "electron";
import type { WindowActivationRequest } from "./application/window-activation";
import { acquireTrayPipeLink, isTrayPipeAvailable } from "./tray-pipe";

export type TrayLike = Pick<Tray, "isDestroyed" | "destroy" | "setImage" | "setToolTip"> & {
  /** Windows 托盘气泡（内置 Tray 与分离托盘同名，宿主通知统一走这里） */
  displayBalloon?(options: { title: string; content: string }): void;
};

/** 系统级托盘气泡参数（Electron DisplayBalloonOptions 的最小投影）。 */
export interface TrayBalloonOptions {
  title: string;
  content: string;
}

/**
 * 系统级托盘气泡统一入口：内置 Electron Tray 与分离托盘 duck-type 都支持
 * `displayBalloon`；环境不支持时返回 false（静默忽略，不影响业务）。
 */
export function showTrayBalloon(tray: Tray | TrayLike | null | undefined, options: TrayBalloonOptions): boolean {
  if (!tray) return false;
  const fn = (tray as { displayBalloon?: (o: TrayBalloonOptions) => void }).displayBalloon;
  if (typeof fn !== "function") return false;
  try {
    fn.call(tray, options);
    return true;
  } catch {
    return false;
  }
}

export interface DetachedTrayInput {
  requestActivation(request: WindowActivationRequest): void;
  togglePetWindow(): void;
  setPetDragMode?(enabled: boolean): boolean;
  /** IKJK51：托盘「隐藏窗口」——隐藏全部应用窗口（调度继续常驻）。 */
  hideWindows?(): void;
  quit(): void;
}

interface TrayCommand {
  op: "cmd";
  action: string;
}

/**
 * 托盘进程可用性探测：pipe 不存在（托盘未运行）→ 直接回退内置 Tray，
 * 避免返回一个无图标的「死托盘」。实现见 tray-pipe（readdir 枚举；
 * 不能用 fs.existsSync——对 .NET 管道实例会误判 EBUSY）。
 */
export function isDetachedTrayPipeAvailable(): boolean {
  return isTrayPipeAvailable();
}

export function connectDetachedTray(input: DetachedTrayInput): TrayLike | null {
  if (!isDetachedTrayPipeAvailable()) return null;
  // 快探测：托盘在 Electron 启动前应已就位（托盘拉起 Electron 的正常流）。
  // 托盘未跑（pipe 不存在）→ 返回 null，调用方回退内置 Tray。
  //
  // IKJK51：socket 由 tray-pipe 共享链路持有（调度宿主客户端共用同一连接，
  // 托盘单连接语义），断线自动重连在链路层；本模块只保留 TrayLike 语义。
  const link = acquireTrayPipeLink();
  let destroyed = false;
  void link.connect();
  const unsubscribe = link.onLine((line) => {
    if (!destroyed) dispatchLine(line, input);
  });

  function send(payload: Record<string, unknown>): void {
    if (destroyed) return;
    link.send(payload);
  }

  return {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      unsubscribe();
      // 共享链路不在此销毁：调度宿主客户端可能仍在使用；应用退出随进程回收。
    },
    setImage: (image: NativeImage) => {
      // 跨进程无法直接传 NativeImage：落盘 temp 后发路径。
      // 托盘侧收到后重载图标（见 TrayHost.HandleElectronMessage）。
      try {
        const png = image.toPNG();
        const path = require("path").join(
          require("electron").app.getPath("temp"),
          `cyrene-tray-icon-${Date.now()}.png`,
        );
        require("fs").writeFileSync(path, png);
        send({ op: "tray.icon", path });
      } catch {
        /* 图标更新失败不致命 */
      }
    },
    setToolTip: (text: string) => send({ op: "tray.tooltip", text }),
    displayBalloon: (options: { title: string; content: string }) =>
      send({ op: "tray.notify", title: options.title, content: options.content }),
  };
}

function dispatchLine(line: string, input: DetachedTrayInput): void {
  let msg: TrayCommand;
  try {
    msg = JSON.parse(line) as TrayCommand;
  } catch {
    return;
  }
  if (msg.op !== "cmd") return;
  switch (msg.action) {
    case "chat":
      input.requestActivation({ kind: "chat" });
      break;
    case "sidebar":
      input.requestActivation({ kind: "sidebar" });
      break;
    case "settings":
      input.requestActivation({ kind: "settings" });
      break;
    case "toggle-pet":
      input.togglePetWindow();
      break;
    case "hide-windows":
      input.hideWindows?.();
      break;
    case "drag-mode":
      input.setPetDragMode?.(true);
      break;
    case "quit":
      input.quit();
      break;
    default:
      break;
  }
}
