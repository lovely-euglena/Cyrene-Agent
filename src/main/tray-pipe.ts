/**
 * cyrene-tray 命名管道共享链路（IKJK51）。
 *
 * 托盘管道同一时刻只接受一个连接（TrayHost 单连接语义），因此托盘 UI 客户端
 * （tray-detached）与调度宿主客户端（scheduler/host-client）共用同一条 socket：
 *   - 唯一 socket 所有者：懒连接；连接建立后自动发 tray.ready；断线自动重连
 *     （退避 1s → 10s，仅在成功连接过一次后启用——首次连接失败由调用方决定重试）
 *   - JSON 行分帧（\n），onLine 多订阅；解析与业务分发归订阅者
 *   - send：未连接时静默丢弃（调用方自行 ensure/重试）
 *
 * 探测沿用既有 readdir 方案：不能用 fs.existsSync——对 .NET
 * NamedPipeServerStream 创建的实例返回 false（stat/open 报 EBUSY/失败），
 * 会误判成「托盘未运行」。非 Windows 恒 false（分离托盘为 Windows 专属）。
 */

import * as fs from "node:fs";
import * as nodeNet from "net";

export const TRAY_PIPE_NAME = "cyrene-tray";
export const TRAY_PIPE_PATH = `\\\\.\\pipe\\${TRAY_PIPE_NAME}`;

export function isTrayPipeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return fs.readdirSync("\\\\.\\pipe\\").includes(TRAY_PIPE_NAME);
  } catch {
    return false;
  }
}

/** 行分帧（纯函数）：从累积缓冲切出完整行；空行跳过。 */
export function drainTrayLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const text = buffer + chunk;
  const lines: string[] = [];
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n");
    if (idx < 0) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}

export interface TrayPipeLink {
  isConnected(): boolean;
  /** 建立连接（若未连接）；已连接立即 true；管道缺失/超时返回 false。 */
  connect(): Promise<boolean>;
  send(frame: Record<string, unknown>): void;
  onLine(listener: (line: string) => void): () => void;
  onConnectionChange(listener: (connected: boolean) => void): () => void;
  dispose(): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const CONNECT_TIMEOUT_MS = 3_000;

class TrayPipeLinkImpl implements TrayPipeLink {
  private socket: nodeNet.Socket | null = null;
  private connected = false;
  private everConnected = false;
  private connecting: Promise<boolean> | null = null;
  private disposed = false;
  private lineBuffer = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly connListeners = new Set<(connected: boolean) => void>();

  isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.connected) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    if (!isTrayPipeAvailable()) return Promise.resolve(false);
    const attempt = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      let sock: nodeNet.Socket;
      try {
        sock = nodeNet.connect(TRAY_PIPE_PATH);
      } catch {
        done(false);
        return;
      }
      this.socket = sock;
      sock.setEncoding("utf8");
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { /* ignore */ }
        done(false);
      }, CONNECT_TIMEOUT_MS);
      sock.on("connect", () => {
        clearTimeout(timer);
        this.connected = true;
        this.everConnected = true;
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.emitConnection(true);
        this.send({ op: "tray.ready" });
        done(true);
      });
      sock.on("data", (chunk: string) => {
        const { lines, rest } = drainTrayLines(this.lineBuffer, chunk);
        this.lineBuffer = rest;
        for (const line of lines) {
          for (const listener of [...this.lineListeners]) {
            try { listener(line); } catch { /* 订阅者异常不阻断其他订阅 */ }
          }
        }
      });
      sock.on("error", () => { /* close 事件统一收尾 */ });
      sock.on("close", () => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.lineBuffer = "";
        if (wasConnected) this.emitConnection(false);
        done(false);
        this.scheduleReconnect();
      });
    });
    this.connecting = attempt;
    void attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    });
    return attempt;
  }

  send(frame: Record<string, unknown>): void {
    if (this.disposed || !this.socket || !this.connected) return;
    try {
      this.socket.write(`${JSON.stringify(frame)}\n`);
    } catch { /* ignore */ }
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
    this.connected = false;
    this.lineListeners.clear();
    this.connListeners.clear();
  }

  private emitConnection(connected: boolean): void {
    for (const listener of [...this.connListeners]) {
      try { listener(connected); } catch { /* ignore */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.everConnected) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.connected) return;
      void this.connect().then((ok) => {
        if (!ok && !this.connected) this.scheduleReconnect();
      });
    }, delay);
  }
}

let sharedLink: TrayPipeLinkImpl | null = null;
let testLinkOverride: TrayPipeLink | null = null;

/** 获取共享链路（单例，懒建；自动重连在链路层）。 */
export function acquireTrayPipeLink(): TrayPipeLink {
  if (testLinkOverride) return testLinkOverride;
  if (!sharedLink) sharedLink = new TrayPipeLinkImpl();
  return sharedLink;
}

/** 测试后门：注入替身链路（host-client 等单测用）。 */
export function __setTrayPipeLinkForTests(link: TrayPipeLink | null): void {
  testLinkOverride = link;
}

/** 测试后门：重置共享链路。 */
export function __resetTrayPipeLinkForTests(): void {
  testLinkOverride = null;
  sharedLink?.dispose();
  sharedLink = null;
}
