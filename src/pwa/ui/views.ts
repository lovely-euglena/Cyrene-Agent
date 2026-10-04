/**
 * 云端昔涟 PWA · 最小聊天页视图（IKJK2L）。
 *
 * - mountLogin：配对登录（build 一次，busy/error 用句柄更新，输入不因重渲染丢失）；
 * - renderSessions：会话列表（每次刷新整体重建，无输入态）；
 * - mountChat：聊天页（消息区可增量更新；输入框持久，轮询刷新不打断输入/焦点）。
 * 文本一律 textContent（无 innerHTML），防注入。
 */
import type { SessionSummary, Turn } from "../core/materializer";
import { el, formatTime, setHidden } from "./dom";

// ── 登录 ──

export interface LoginHandle {
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
  focus(): void;
}

export function mountLogin(root: HTMLElement, onSubmit: (code: string, name: string) => void): LoginHandle {
  const codeInput = el("input", {
    id: "pair-code",
    "data-testid": "pair-code",
    type: "text",
    inputmode: "text",
    autocomplete: "one-time-code",
    placeholder: "配对码",
    "aria-label": "配对码",
  });
  const nameInput = el("input", {
    id: "pair-name",
    "data-testid": "pair-name",
    type: "text",
    autocomplete: "off",
    placeholder: "设备名（默认：手机）",
    "aria-label": "设备名",
  });
  const submit = el("button", { id: "pair-submit", "data-testid": "pair-submit", type: "submit", class: "primary" }, "配对");
  const error = el("p", { "data-testid": "login-error", class: "error", hidden: "" });
  const form = el(
    "form",
    { class: "login-card" },
    el("h1", {}, "昔涟 · 云端"),
    el("p", { class: "hint" }, "输入服务端配对码（CLI pair-code 或已配对设备生成）"),
    codeInput,
    nameInput,
    submit,
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit(codeInput.value.trim(), nameInput.value.trim());
  });
  const view = el("div", { class: "login", "data-testid": "login" }, form);
  root.replaceChildren(view);
  return {
    setBusy(busy) {
      submit.disabled = busy;
      submit.textContent = busy ? "配对中…" : "配对";
    },
    setError(message) {
      error.textContent = message ?? "";
      setHidden(error, !message);
    },
    focus() {
      codeInput.focus();
    },
  };
}

// ── 会话列表 ──

export interface SessionsProps {
  summaries: readonly SessionSummary[];
  offline: boolean;
  status: string;
  onOpen(sessionId: string): void;
  onLogout(): void;
}

export function renderSessions(root: HTMLElement, props: SessionsProps): void {
  const banner = el("div", { class: "banner", "data-testid": "offline-banner", hidden: "" }, "离线：显示本地缓存（只读）");
  setHidden(banner, !props.offline);

  const list = el("div", { class: "session-list", "data-testid": "session-list" });
  if (props.summaries.length === 0) {
    list.append(el("p", { class: "empty", "data-testid": "sessions-empty" }, props.offline ? "离线且暂无缓存会话" : "暂无会话（先在桌面端同步）"));
  }
  for (const summary of props.summaries) {
    const item = el(
      "button",
      { class: "session-item", "data-testid": "session-item", "data-session-id": summary.sessionId, type: "button" },
      el("div", { class: "session-title" }, summary.title),
      el("div", { class: "session-preview" }, summary.preview || "（暂无消息）"),
      el("time", { class: "session-time" }, formatTime(summary.lastTs)),
    );
    item.addEventListener("click", () => props.onOpen(summary.sessionId));
    list.append(item);
  }

  const header = el(
    "header",
    { class: "app-header" },
    el("div", {}, el("h1", {}, "昔涟 · 云端"), el("span", { class: "status", "data-testid": "status" }, props.status)),
    el("button", { class: "ghost", "data-testid": "logout", type: "button" }, "退出"),
  );
  header.querySelector(".ghost")?.addEventListener("click", () => props.onLogout());

  root.replaceChildren(el("div", { class: "sessions", "data-testid": "sessions" }, header, banner, list));
}

// ── 聊天 ──

export interface ChatHandle {
  update(turns: readonly Turn[], offline: boolean, status: string): void;
  setError(message: string | null): void;
  setSending(sending: boolean): void;
}

export interface ChatProps {
  summary: SessionSummary | null;
  onBack(): void;
  onSend(text: string): void;
}

export function mountChat(root: HTMLElement, props: ChatProps): ChatHandle {
  const title = el("div", { class: "chat-title" }, props.summary?.title ?? "会话");
  const status = el("span", { class: "status", "data-testid": "status" }, "");
  const back = el("button", { class: "back", "data-testid": "back", type: "button", "aria-label": "返回" }, "←");
  back.addEventListener("click", () => props.onBack());

  const banner = el("div", { class: "banner", "data-testid": "offline-banner", hidden: "" }, "离线：显示本地缓存（只读）");
  const messages = el("div", { class: "messages", "data-testid": "messages" });
  const error = el("p", { class: "error", "data-testid": "send-error", hidden: "" });
  const input = el("input", {
    "data-testid": "chat-input",
    type: "text",
    autocomplete: "off",
    enterkeyhint: "send",
    placeholder: "发消息…",
    "aria-label": "消息输入",
  });
  const send = el("button", { "data-testid": "send", type: "submit", class: "primary" }, "发送");
  const form = el("form", { class: "composer" }, input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    props.onSend(text);
  });

  const header = el("header", { class: "chat-header" }, back, el("div", { class: "chat-heading" }, title, status));
  root.replaceChildren(el("div", { class: "chat", "data-testid": "chat" }, header, banner, messages, error, form));

  const nearBottom = (): boolean =>
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;

  const renderMessages = (turns: readonly Turn[]): void => {
    const stick = nearBottom();
    messages.replaceChildren();
    for (const turn of turns) {
      messages.append(el("div", { class: "msg msg-user", "data-testid": "message" }, el("div", { class: "bubble" }, turn.user.text)));
      for (const assistant of turn.assistants) {
        messages.append(el("div", { class: "msg msg-assistant", "data-testid": "message" }, el("div", { class: "bubble" }, assistant.text)));
      }
    }
    const last = turns[turns.length - 1];
    if (last && last.assistants.length === 0) {
      messages.append(el("div", { class: "msg msg-assistant pending", "data-testid": "pending" }, el("div", { class: "bubble" }, "……")));
    }
    if (stick) messages.scrollTop = messages.scrollHeight;
  };

  return {
    update(turns, offline, statusText) {
      setHidden(banner, !offline);
      status.textContent = statusText;
      renderMessages(turns);
    },
    setError(message) {
      error.textContent = message ?? "";
      setHidden(error, !message);
    },
    setSending(sending) {
      send.disabled = sending;
      send.textContent = sending ? "发送中…" : "发送";
    },
  };
}
