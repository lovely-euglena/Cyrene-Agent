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

import * as fs from "node:fs";
import * as nodeNet from "net";
import type { NativeImage, Tray } from "electron";
import type { WindowActivationRequest } from "./application/window-activation";

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
  /** 当前桌宠拖动模式状态（连接建立时同步一次勾选；缺省按 false）。 */
  getPetDragMode?(): boolean;
  quit(): void;
}

const PIPE_NAME = "cyrene-tray";
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;

/** Electron → 托盘的状态帧：拖动模式勾选以宿主实际状态为准。 */
type TrayDragModeStateFrame = { op: "tray.drag-mode-state"; checked: boolean };

/**
 * 连接建立时发送的握手帧（导出供测试锁定协议）：
 *   tray.ready 后同步一次拖动模式勾选——TrayHost 常驻、Electron 可独立退出
 *   重启，托盘菜单勾选可能停留在上一次 Electron 会话（拖动模式不持久化）。
 */
export function buildConnectFrames(input: Pick<DetachedTrayInput, "getPetDragMode">): Array<Record<string, unknown>> {
  return [
    { op: "tray.ready" },
    { op: "tray.drag-mode-state", checked: input.getPetDragMode?.() ?? false },
  ];
}

interface TrayCommand {
  op: "cmd";
  action: string;
  /**
   * 拖动模式目标状态（TrayHost 菜单勾选透传）。旧版托盘不发该字段，
   * 缺省按 true 兼容（旧行为：drag-mode 恒开启）。
   */
  checked?: boolean;
}

/**
 * 托盘进程可用性探测：pipe 不存在（托盘未运行）→ 直接回退内置 Tray，
 * 避免返回一个无图标的「死托盘」。
 *
 * 实现注意：不能用 fs.existsSync(PIPE_PATH)——对 .NET
 * NamedPipeServerStream 创建的实例返回 false（stat/open 报 EBUSY/失败），
 * 会误判成「托盘未运行」。用管道命名空间枚举（readdir）判断名字存在，
 * 实测对 .NET 管道可靠；非 Windows 恒 false（分离托盘为 Windows 专属）。
 */
export function isDetachedTrayPipeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return fs.readdirSync("\\\\.\\pipe\\").includes(PIPE_NAME);
  } catch {
    return false;
  }
}

export function connectDetachedTray(input: DetachedTrayInput): TrayLike | null {
  if (!isDetachedTrayPipeAvailable()) return null;
  let socket: nodeNet.Socket | null = null;
  let destroyed = false;
  let lineBuffer = "";

  // 快探测：托盘在 Electron 启动前应已就位（托盘拉起 Electron 的正常流）。
  // 托盘未跑（pipe 不存在）→ 返回 null，调用方回退内置 Tray。
  try {
    socket = nodeNet.connect(PIPE_PATH);
    socket.on("error", () => { /* pipe 断开：托盘先走，静默 */ });
    socket.on("connect", () => {
      for (const frame of buildConnectFrames(input)) send(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      for (;;) {
        const idx = lineBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        dispatchLine(line, input, send);
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
    displayBalloon: (options: { title: string; content: string }) =>
      send({ op: "tray.notify", title: options.title, content: options.content }),
  };
}

/**
 * 托盘命令分发（导出供测试锁定协议；生产路径由 socket 数据回调调用）。
 * notify 为状态回执通道：拖动模式命令执行后回执宿主实际结果。
 */
export function dispatchLine(
  line: string,
  input: DetachedTrayInput,
  notify?: (frame: TrayDragModeStateFrame) => void,
): void {
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
    case "drag-mode": {
      // 勾选状态随命令透传（修复「只能开不能关」）；旧版托盘无 checked → true 兼容
      const target = typeof msg.checked === "boolean" ? msg.checked : true;
      const applied = input.setPetDragMode?.(target) ?? false;
      // 结果回执：TrayHost 按实际应用结果对齐勾选（setPetDragMode 拒绝时
      // 不再停留在点击时的保守翻转，分离托盘从单向管道变为有回执）。
      notify?.({ op: "tray.drag-mode-state", checked: applied });
      break;
    }
    case "quit":
      input.quit();
      break;
    default:
      break;
  }
}
