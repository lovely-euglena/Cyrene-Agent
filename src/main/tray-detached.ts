// 分离托盘模式的 Electron 侧客户端。
//
// 架构（见 dotnet/native-windows/TrayHost.cs）：.NET 托盘进程常驻 +
// named pipe cyrene-tray；Electron 成为「按需工作进程」。本模块：
//   - 连 pipe（2s 重试窗口；连不上返回 null → 调用方回退内置 Electron Tray）
//   - duck-type Electron Tray（isDestroyed/destroy/setImage/setToolTip），
//     shell-bootstrap 与设置图标的既有消费点零改动
//   - 收 tray cmd → 转发激活/桌宠/退出（与内置托盘菜单同语义）
//   - 发 ready / icon path / notify
//
// 通信协议：JSON 行（\n 分隔，低频控制通道，无需三件套的长度前缀帧）。

import * as nodeNet from "net";
import type { NativeImage, Tray } from "electron";
import type { WindowActivationRequest } from "./application/window-activation";

export type TrayLike = Pick<Tray, "isDestroyed" | "destroy" | "setImage" | "setToolTip">;

export interface DetachedTrayInput {
  requestActivation(request: WindowActivationRequest): void;
  togglePetWindow(): void;
  setPetDragMode?(enabled: boolean): boolean;
  quit(): void;
}

const PIPE_PATH = "\\\\.\\pipe\\cyrene-tray";

interface TrayCommand {
  op: "cmd";
  action: string;
}

export function connectDetachedTray(input: DetachedTrayInput): TrayLike | null {
  let socket: nodeNet.Socket | null = null;
  let destroyed = false;
  let lineBuffer = "";

  // 同步连接探测：托盘在 Electron 启动前应已就位（托盘拉起 Electron 的
  // 正常流）。Electron 直启 + 托盘未跑 → 回退内置 Tray（双托盘由用户
  // 后开托盘造成时自行共存，v1 接受）。
  try {
    socket = nodeNet.connect(PIPE_PATH);
    socket.on("error", () => { /* pipe 断开：托盘先走，静默 */ });
    socket.on("connect", () => {
      send({ op: "tray.ready" });
    });
    socket.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      for (;;) {
        const idx = lineBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        dispatchLine(line, input);
      }
    });
    socket.on("close", () => {
      socket = null;
      // 托盘进程退出：分离托盘消失（用户主动关的），Electron 继续——
      // 已有的窗口/桌宠不受影响；托盘回来时 Electron 侧无自动重连
      //（下次 Electron 启动才重连，v1 简化）
    });
  } catch {
    return null;
  }

  function send(payload: Record<string, unknown>): void {
    if (!socket || destroyed) return;
    try {
      socket.write(JSON.stringify(payload) + "\n");
    } catch {
      /* ignore */
    }
  }

  return {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      try { socket?.end(); } catch { /* ignore */ }
      socket = null;
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
