/**
 * 云端昔涟 PWA · 控制器（IKJK2L）。
 *
 * 视图状态机：login → sessions ↔ chat；数据源 = 本地缓存事件流（规范序）+ /v1 增量拉取。
 * - 轮询：前台每 3s fetch 增量（document.hidden 暂停；可见性恢复立即拉一次）；
 * - 发送：构造 user 事件 → 乐观渲染 → push → 失败回滚并提示（Phase 1 离线只读，不支持离线发送）；
 * - 离线：fetch/push 失败显示「本地缓存（只读）」横幅，恢复后自动消失；
 * - 401：清缓存回登录页并提示重新配对。
 */
import {
  computeClock,
  createUserMessageEvent,
} from "../core/event-factory";
import { mergeEvents } from "../core/event-store";
import { defaultCapabilities, showPendingFor, type ServerCapabilities } from "../core/capabilities";
import { groupTurns, replaySession, summarizeSessions, type SessionSummary } from "../core/materializer";
import { SyncClient, SyncHttpError } from "../core/sync-client";
import { clearCache, emptyCache, loadCache, saveCache, type PwaCache } from "../core/cache";
import { mountChat, mountLogin, renderSessions, type ChatHandle, type LoginHandle } from "./views";

const POLL_INTERVAL_MS = 3000;

export function boot(root: HTMLElement): void {
  new PwaApp(root).start();
}

class PwaApp {
  private cache: PwaCache = emptyCache();
  private readonly client = new SyncClient();
  private view: "login" | "sessions" | "chat" = "login";
  private selectedSessionId: string | null = null;
  private pollTimer: number | null = null;
  private refreshing = false;
  private offline = false;
  private capabilities: ServerCapabilities = defaultCapabilities();
  private statusText = "未连接";
  private login: LoginHandle | null = null;
  private chat: ChatHandle | null = null;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    this.cache = loadCache();
    void this.loadCapabilities();
    if (this.cache.token && this.cache.deviceId) {
      this.showSessions();
      void this.refresh();
      this.startPolling();
    } else {
      this.showLogin();
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.cache.token) void this.refresh();
    });
  }

  // ── 视图 ──

  private showLogin(): void {
    this.view = "login";
    this.login = mountLogin(this.root, (code, name) => void this.pair(code, name));
    this.login.focus();
  }

  private showSessions(): void {
    this.view = "sessions";
    this.selectedSessionId = null;
    this.chat = null;
    this.renderSessions();
  }

  private renderSessions(): void {
    renderSessions(this.root, {
      summaries: summarizeSessions(this.cache.events),
      offline: this.offline,
      status: this.statusText,
      onOpen: (sessionId) => this.openChat(sessionId),
      onLogout: () => this.logout(),
    });
  }

  private openChat(sessionId: string): void {
    this.view = "chat";
    this.selectedSessionId = sessionId;
    this.chat = mountChat(this.root, {
      summary: this.sessionSummary(sessionId),
      onBack: () => this.showSessions(),
      onSend: (text) => void this.send(text),
    });
    this.updateChat();
  }

  private updateChat(): void {
    if (this.view !== "chat" || !this.selectedSessionId || !this.chat) return;
    const events = this.cache.events.filter((event) => event.sessionId === this.selectedSessionId);
    this.chat.update(groupTurns(replaySession(events)), this.offline, this.statusText, showPendingFor(this.capabilities));
  }

  private sessionSummary(sessionId: string): SessionSummary | null {
    return summarizeSessions(this.cache.events).find((item) => item.sessionId === sessionId) ?? null;
  }

  private rerenderCurrentView(): void {
    if (this.view === "sessions") this.renderSessions();
    else if (this.view === "chat") this.updateChat();
  }

  // ── 配对与登录态 ──

  private async pair(code: string, name: string): Promise<void> {
    if (!code) {
      this.login?.setError("请输入配对码");
      return;
    }
    this.login?.setError(null);
    this.login?.setBusy(true);
    try {
      const result = await this.client.pair(code, name || "手机");
      this.cache = { token: result.token, deviceId: result.deviceId, deviceName: result.name, cursor: 0, events: [] };
      saveCache(this.cache);
      void this.loadCapabilities();
      this.showSessions();
      await this.refresh();
      this.startPolling();
    } catch (error) {
      this.login?.setError(this.describeError(error, "配对失败"));
    } finally {
      this.login?.setBusy(false);
    }
  }

  private logout(message?: string): void {
    clearCache();
    this.cache = emptyCache();
    this.offline = false;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.showLogin();
    if (message) this.login?.setError(message);
  }

  // ── 同步 ──

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => {
      if (!document.hidden && this.cache.token) void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  /** 能力声明（公开只读）：失败/老服务端保持兼容默认（realtime / pwa=true）。 */
  private async loadCapabilities(): Promise<void> {
    try {
      this.capabilities = await this.client.capabilities();
      this.rerenderCurrentView();
    } catch {
      // 兼容默认已生效：不阻断主流程
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || !this.cache.token) return;
    this.refreshing = true;
    let changed = false;
    try {
      const result = await this.client.fetchAll(this.cache.token, this.cache.cursor);
      if (result.events.length > 0) {
        this.cache = saveCache({
          ...this.cache,
          cursor: result.cursor,
          events: mergeEvents(this.cache.events, result.events),
        });
        changed = true;
      }
      if (this.offline) {
        this.offline = false;
        changed = true;
      }
      this.statusText = "已连接";
      if (changed) this.rerenderCurrentView();
    } catch (error) {
      if (error instanceof SyncHttpError && error.status === 401) {
        this.logout("登录已失效，请重新配对");
        return;
      }
      if (!this.offline) {
        this.offline = true;
        this.statusText = "离线";
        this.rerenderCurrentView();
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async send(text: string): Promise<void> {
    const trimmed = text.trim();
    const sessionId = this.selectedSessionId;
    const token = this.cache.token;
    const deviceId = this.cache.deviceId;
    if (!trimmed || !sessionId || !token || !deviceId) return;
    const clock = computeClock(this.cache.events, deviceId);
    let event;
    try {
      event = createUserMessageEvent({
        sessionId,
        text: trimmed,
        deviceId,
        clock,
      });
    } catch (error) {
      this.chat?.setError(this.describeError(error, "消息构造失败"));
      return;
    }
    // 乐观渲染；push 失败则回滚（离线只读，不支持离线发送）
    this.cache = { ...this.cache, events: mergeEvents(this.cache.events, [event]) };
    this.updateChat();
    this.chat?.setSending(true);
    this.chat?.setError(null);
    try {
      await this.client.push(token, [event]);
      saveCache(this.cache);
      await this.refresh();
    } catch (error) {
      this.cache = { ...this.cache, events: this.cache.events.filter((item) => item.eventId !== event.eventId) };
      saveCache(this.cache);
      this.updateChat();
      this.chat?.setError(this.describeError(error, "发送失败"));
    } finally {
      this.chat?.setSending(false);
    }
  }

  private describeError(error: unknown, fallback: string): string {
    if (error instanceof SyncHttpError) {
      switch (error.code) {
        case "E_PAIR_CODE":
          return "配对码无效或已过期";
        case "E_UNAUTHORIZED":
          return "未授权（token 无效）";
        case "E_RATE_LIMITED":
          return "请求过于频繁，稍后再试";
        case "E_HOST_NOT_ALLOWED":
          return "Host 不在白名单";
        default:
          return `${fallback}（HTTP ${error.status}）`;
      }
    }
    return `${fallback}：${error instanceof Error ? error.message : String(error)}`;
  }
}
