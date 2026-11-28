// OpenCode 渠道适配器 —— A 形态（headless server + HTTP/SSE）骨架（#271）。
//
// 职责（与其他渠道适配器一致，见 adapters/base.ts）：
//   1) 启动：spawn `opencode serve`（或 attach 已有 server），解析端口，建立 SSE 订阅；
//   2) 入站：Cyrene 侧出站消息 → POST /session/{id}/message（会话投影维护映射）；
//   3) 事件：SSE message.part.updated 等事件 → 归一化 IncomingMessage 回调。
//
// 骨架范围：spawn/投影/SSE 转帧的接线层；权限联动（permission handler）与 MCP 反连留
// 后续批次（见 #271 接入层设计 4/5）。骨架不进 bootstrap 注册，走显式装配（测试/灰度）。
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelId,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
} from "../../types";
import type { OpencodeEvent, OpencodeMessageRequest, OpencodeServeConfig, OpencodeSessionInfo } from "./types";

const DEFAULT_PROVIDER = "mock";
const DEFAULT_MODEL = "mock";
const SERVE_READY_TIMEOUT_MS = 30_000;

export class OpencodeChannelAdapter extends EventEmitter implements ChannelAdapter {
  readonly id: ChannelId = "opencode" as ChannelId;
  readonly displayName = "OpenCode";
  readonly capability: ChannelCapability = {
    // 骨架期能力声明：纯文本双向；图片/语音按 opencode 端点演进后放开（#271 接入层 3）。
    text: true,
    image: false,
    audio: false,
    file: false,
    video: false,
    markdown: true,
    card: false,
    sticker: false,
    maxTextLength: 1_000_000,
  };

  onMessage: MessageHandler | null = null;

  private cfg: OpencodeServeConfig;
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private abort: AbortController | null = null;
  /** Cyrene 会话 → opencode sessionID 投影（#271 接入层 2）。 */
  private sessionMap = new Map<string, string>();
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "not started" };

  constructor(cfg: OpencodeServeConfig = {}) {
    super();
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    this.status = { enabled: false, phase: "starting", message: "resolving server" };
    if (this.cfg.attachUrl) {
      this.baseUrl = this.cfg.attachUrl.replace(/\/$/, "");
    } else {
      this.baseUrl = await this.spawnServe();
    }
    await this.probe();
    this.subscribeEvents();
    this.status = { enabled: true, phase: "running", message: `connected ${this.baseUrl}` };
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.baseUrl = null;
    this.status = { enabled: false, phase: "offline", message: "stopped" };
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  /**
   * 入站（Cyrene → opencode）：确保投影存在，然后把文本投给 opencode。
   * opencode 的回复经 SSE 事件归一化后从 onMessage 回调回流。
   */
  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.baseUrl) return { ok: false, error: "not started" };
    try {
      const sessionId = await this.ensureSession(msg.targetId);
      const text = msg.parts
        .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
        .map((p) => p.text)
        .join("\n");
      const body: OpencodeMessageRequest = {
        providerID: this.cfg.providerID ?? DEFAULT_PROVIDER,
        modelID: this.cfg.modelID ?? DEFAULT_MODEL,
        parts: [{ type: "text", text }],
      };
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, error: `message ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** 会话投影：首次懒建（POST /session，title 取 chatId 便于 opencode 侧识别）。 */
  private async ensureSession(chatId: string): Promise<string> {
    const hit = this.sessionMap.get(chatId);
    if (hit) return hit;
    if (!this.baseUrl) throw new Error("not started");
    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `cyrene:${chatId}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`session create ${res.status}`);
    const info = (await res.json()) as OpencodeSessionInfo;
    this.sessionMap.set(chatId, info.id);
    return info.id;
  }

  /** spawn `opencode serve`，从 stdout 解析 `listening on http://host:port`。 */
  private spawnServe(): Promise<string> {
    const bin = this.cfg.binPath ?? "opencode";
    const hostname = this.cfg.hostname ?? "127.0.0.1";
    const port = this.cfg.port ?? 0;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ["serve", "--hostname", hostname, "--port", String(port)], {
        env: {
          ...process.env,
          ...(this.cfg.serverPassword ? { OPENCODE_SERVER_PASSWORD: this.cfg.serverPassword } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("serve ready timeout"));
        }
      }, SERVE_READY_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        const m = /listening on (https?:\/\/[^\s]+)/.exec(String(chunk));
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => this.emit("log", String(chunk)));
      child.on("exit", (code) => {
        this.status = { enabled: false, phase: "offline", message: `serve exited ${code}` };
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`serve exited early (${code})`));
        }
      });
    });
  }

  private async probe(): Promise<void> {
    if (!this.baseUrl) throw new Error("no base url");
    const res = await fetch(`${this.baseUrl}/session`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`probe ${res.status}`);
  }

  /** SSE 订阅：GET /event（text/event-stream），归一化后走 onMessage 回调。 */
  private subscribeEvents(): void {
    if (!this.baseUrl) return;
    this.abort = new AbortController();
    void this.consumeEvents(this.abort.signal);
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.baseUrl) {
      try {
        const res = await fetch(`${this.baseUrl}/event`, { signal, headers: { accept: "text/event-stream" } });
        if (!res.body) return;
        await this.drainEventStream(res.body);
      } catch {
        // 断线退避后重连（attach 复连语义）
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async drainEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this.handleEventFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** SSE 帧 → 归一化 IncomingMessage（骨架：文本部分直通；增量聚合策略见 #271 接入层 3）。 */
  private handleEventFrame(frame: string): void {
    const dataLine = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!dataLine) return;
    let evt: OpencodeEvent;
    try {
      evt = JSON.parse(dataLine) as OpencodeEvent;
    } catch {
      return;
    }
    if (evt.type === "session.error") {
      this.emit("session-error", evt.properties);
      return;
    }
    if (evt.type !== "message.part.updated" || !evt.properties) return;
    const part = evt.properties.part as { type?: string; text?: string } | undefined;
    if (!part || part.type !== "text" || !part.text) return;
    const sessionID = (evt.properties as { sessionID?: string }).sessionID;
    if (!sessionID) return;
    const chatId = this.reverseSession(sessionID);
    if (!chatId || !this.onMessage) return;
    const incoming: IncomingMessage = {
      channel: this.id,
      messageId: `oc-${sessionID}-${Date.now()}`,
      senderId: sessionID,
      senderName: "opencode",
      chatId,
      text: part.text,
      at: new Date(),
    };
    void this.onMessage(incoming);
  }

  private reverseSession(sessionId: string): string | undefined {
    for (const [chatId, sid] of this.sessionMap) if (sid === sessionId) return chatId;
    return undefined;
  }
}
