// 聊天记录导出：把组合后的 ChatSession 渲染为自包含 HTML / Markdown 并落盘。
//
// 由插件 chat-export 移植进主程序（原插件直读 sessions/<id>.json 的 messages，
// 在 v2 轨迹存储下已取不到消息）；这里输入的是 ConversationSessionMigration
// 组合出的完整会话，字段口径与聊天界面一致。
//
// 本模块不依赖 electron，便于单测：头像路径、导出目录、时间戳都由调用方注入。

import * as fs from "fs";
import * as path from "path";
import type { ChatMessage, ChatSession } from "../../shared/chat-types";
import type {
  ChatExportError,
  ChatExportFile,
  ChatExportFormat,
} from "../../shared/chat-export";

// 导出文件中双方的显示名
const ASSISTANT_NAME = "昔涟";
const USER_NAME = "用户";

// 会话模式 → 中文标签
const MODE_LABELS: Record<string, string> = { chat: "聊天", work: "工作", code: "编程", learn: "学习" };
// 渠道来源 → 中文标签
const CHANNEL_LABELS: Record<string, string> = { wechat: "微信", feishu: "飞书", qq: "QQ", qqbot: "QQ 机器人" };
// 工具执行状态 → 中文标签
const TOOL_STATUS_LABELS: Record<string, string> = { running: "进行中", success: "成功", error: "失败" };

// 单次工具结果在折叠块里最多展示的字符数
const TOOL_RESULT_LIMIT = 2000;
// 思考过程合并展示的字符上限（防止超长推理撑爆导出文件）
const REASONING_LIMIT = 10000;
// 导出文件名中标题部分的最大长度
const FILE_TITLE_LIMIT = 60;

/** 导出时共用的双方头像 data URI。 */
export interface ChatExportAvatarSet {
  assistant: string;
  user: string;
}

// ---------------------------------------------------------------------------
// 基础工具函数
// ---------------------------------------------------------------------------

/** HTML 转义，防止聊天正文里的尖括号破坏页面结构。 */
export function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 毫秒时间戳 → 本地时间字符串（YYYY-MM-DD HH:mm）。 */
export function formatDateTime(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 毫秒时间戳 → 文件名用的紧凑日期（YYYYMMDD）。 */
export function formatDateCompact(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 清洗字符串使其可安全用作 Windows 文件名；空标题回退为默认名。 */
export function sanitizeFileName(name: unknown): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FILE_TITLE_LIMIT);
  return cleaned || "未命名会话";
}

/** 在目标目录里找一个不冲突的文件名（重名自动加 -2、-3 序号）。 */
export function uniqueFileName(dir: string, base: string, ext: string): string {
  let name = `${base}${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}-${i}${ext}`;
    i += 1;
  }
  return name;
}

/** 根据扩展名猜测图片 MIME 类型（存档缺失 mime 时的兜底）。 */
export function guessImageMime(filePath: string): string {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

/** 读取图片文件并转为 data URI；文件不存在或读取失败返回 null。 */
function readImageAsDataUri(filePath: string | null | undefined): string | null {
  try {
    if (!filePath || !fs.statSync(filePath).isFile()) return null;
    const data = fs.readFileSync(filePath).toString("base64");
    return `data:${guessImageMime(filePath)};base64,${data}`;
  } catch {
    return null;
  }
}

/**
 * 程序绘制的默认头像（SVG data URI）：圆底渐变 + 人形剪影。
 * tone 为 "user"（蓝紫）或 "assistant"（粉），区分两侧身份。
 */
export function defaultAvatarDataUri(tone: "user" | "assistant"): string {
  const colors = tone === "user"
    ? { top: "#9db4dd", bottom: "#7d92c6" }
    : { top: "#f2a9c3", bottom: "#e07ba3" };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${colors.top}"/><stop offset="1" stop-color="${colors.bottom}"/>`
    + `</linearGradient></defs>`
    + `<circle cx="32" cy="32" r="32" fill="url(#g)"/>`
    + `<circle cx="32" cy="24" r="10" fill="#ffffff" fill-opacity="0.92"/>`
    + `<path d="M14 54c2.5-11 9-16 18-16s15.5 5 18 16z" fill="#ffffff" fill-opacity="0.92"/>`
    + `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * 收集双方头像 data URI：用户头像与昔涟头像由调用方给路径（userData 内），
 * 文件缺失时用程序绘制的默认头像兜底。
 */
export function collectChatExportAvatars(input: {
  userAvatarPath?: string | null;
  assistantAvatarPath?: string | null;
}): ChatExportAvatarSet {
  const assistant = readImageAsDataUri(input.assistantAvatarPath) ?? defaultAvatarDataUri("assistant");
  const user = readImageAsDataUri(input.userAvatarPath) ?? defaultAvatarDataUri("user");
  return { assistant, user };
}

// ---------------------------------------------------------------------------
// 轻量 Markdown → HTML 渲染（仅覆盖聊天正文常见语法，无外部依赖）
// ---------------------------------------------------------------------------

/** 行内元素：行内代码、粗体、斜体、链接。 */
function renderInlineMarkdown(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

/** 块级渲染：代码块、标题、无序列表、普通段落。 */
function renderMarkdownToHtml(text: string): string {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${renderInlineMarkdown(listItem[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") {
      out.push("");
    } else {
      out.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 消息字段提取
// ---------------------------------------------------------------------------

/** 合并推理块为一段文本；老数据没有分块时回退用整段 reasoning 字段。 */
function collectReasoningText(message: ChatMessage): string {
  const parts: string[] = [];
  if (Array.isArray(message.reasoningBlocks)) {
    for (const block of message.reasoningBlocks) {
      if (block && block.content) parts.push(String(block.content));
    }
  } else if (message.reasoning) {
    parts.push(String(message.reasoning));
  }
  return parts.join("\n\n").slice(0, REASONING_LIMIT);
}

/** 提取模型的过程说明（工具轮次中给用户的解释性文本）。 */
function collectProcessTexts(message: ChatMessage): string[] {
  if (!Array.isArray(message.processMessages)) return [];
  return message.processMessages
    .filter((p) => p && p.content)
    .map((p) => String(p.content).slice(0, REASONING_LIMIT));
}

/** 截断超长文本并标注省略信息。 */
function clipText(text: unknown, limit: number): string {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n…（已截断，原文共 ${s.length} 字符）`;
}

/** 工具展示名：优先注册表中文名，历史记录缺失时回退原始 ID。 */
function toolLabel(tool: NonNullable<ChatMessage["toolExecutions"]>[number]): string {
  return tool.displayName || tool.name || "未命名工具";
}

/** 工具结果：正式 result 缺失时回退运行中的终端输出尾窗。 */
function toolResultText(tool: NonNullable<ChatMessage["toolExecutions"]>[number]): string {
  if (tool.result) return tool.result;
  if (tool.terminalOutput) return tool.terminalOutput;
  return "";
}

// ---------------------------------------------------------------------------
// 导出内容渲染：HTML
// ---------------------------------------------------------------------------

/** 渲染单个附件：图片存在则内嵌 base64，缺失则显示占位说明。 */
function renderAttachmentHtml(attachment: NonNullable<ChatMessage["attachments"]>[number]): string {
  if (attachment.kind === "image") {
    const filePath = attachment.filePath || "";
    const mime = attachment.mime || guessImageMime(filePath);
    try {
      if (filePath && fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath).toString("base64");
        return `<div class="attachment-image"><img src="data:${mime};base64,${data}" alt="${escapeHtml(attachment.name || "图片")}"></div>`;
      }
    } catch {
      // 读取失败按缺失处理
    }
    return `<div class="attachment-missing">[图片未能内嵌：${escapeHtml(attachment.name || filePath)}]</div>`;
  }
  return `<div class="attachment-missing">[文档附件：${escapeHtml(attachment.name || "未命名文档")}]</div>`;
}

/** 折叠块的骨架。 */
function renderFoldHtml(summary: string, innerHtml: string): string {
  return `<details class="fold"><summary>${escapeHtml(summary)}</summary><div class="fold-body">${innerHtml}</div></details>`;
}

/** 渲染一条消息里的思考过程与工具调用折叠块（模型消息专属）。 */
function renderMessageFoldsHtml(message: ChatMessage): string {
  const folds: string[] = [];

  const reasoning = collectReasoningText(message);
  const processTexts = collectProcessTexts(message);
  if (reasoning || processTexts.length > 0) {
    let inner = "";
    if (reasoning) inner += renderMarkdownToHtml(reasoning);
    for (const text of processTexts) {
      inner += `<p class="process-note">${renderInlineMarkdown(text)}</p>`;
    }
    folds.push(renderFoldHtml("思考过程", inner));
  }

  if (Array.isArray(message.toolExecutions) && message.toolExecutions.length > 0) {
    const toolsHtml = message.toolExecutions
      .map((tool) => {
        const status = TOOL_STATUS_LABELS[tool.status] || String(tool.status ?? "");
        const result = toolResultText(tool) ? clipText(toolResultText(tool), TOOL_RESULT_LIMIT) : "";
        return [
          `<div class="tool-item">`,
          `<div class="tool-head"><span class="tool-name">${escapeHtml(toolLabel(tool))}</span><span class="tool-status st-${escapeHtml(tool.status || "unknown")}">${escapeHtml(status)}</span></div>`,
          tool.argsText ? `<pre class="tool-args">${escapeHtml(clipText(tool.argsText, TOOL_RESULT_LIMIT))}</pre>` : "",
          result ? `<pre class="tool-result">${escapeHtml(result)}</pre>` : "",
          `</div>`,
        ].join("");
      })
      .join("");
    folds.push(renderFoldHtml(`工具调用（${message.toolExecutions.length} 次）`, toolsHtml));
  }

  return folds.join("");
}

/** 渲染单条聊天气泡；头像通过页面级 CSS 类（avatar-user / avatar-assistant）引用。 */
function renderMessageHtml(message: ChatMessage): string {
  const isUser = message.role === "user";
  const name = isUser ? USER_NAME : ASSISTANT_NAME;
  const at = formatDateTime(message.at);

  // 渠道来源（微信/飞书等镜像消息）与表情包、附件标注
  const sourceBits: string[] = [];
  if (message.channelSource && message.channelSource.channel) {
    const label = CHANNEL_LABELS[message.channelSource.channel] || message.channelSource.channel;
    const sender = message.channelSource.senderName ? ` · ${message.channelSource.senderName}` : "";
    sourceBits.push(`来自 ${label}${sender}`);
  }
  if (message.sticker) {
    sourceBits.push(`表情包：${message.sticker}`);
  }
  const metaTail = sourceBits.length > 0 ? ` · ${sourceBits.join(" · ")}` : "";

  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(renderAttachmentHtml).join("")
    : "";

  const folds = isUser ? "" : renderMessageFoldsHtml(message);
  const contentHtml = renderMarkdownToHtml(message.content || "");

  return [
    `<div class="msg ${isUser ? "msg-user" : "msg-assistant"}">`,
    `<div class="avatar ${isUser ? "avatar-user" : "avatar-assistant"}" role="img" aria-label="${escapeHtml(name)}"></div>`,
    `<div class="msg-body">`,
    `<div class="bubble">`,
    folds,
    `<div class="content">${contentHtml}</div>`,
    attachments,
    `</div>`,
    `<div class="meta">${escapeHtml(name)} · ${escapeHtml(at)}${escapeHtml(metaTail)}</div>`,
    `</div>`,
    `</div>`,
  ].join("");
}

/** 生成会话的完整自包含 HTML 页面；avatars 为双方头像 data URI。 */
export function renderSessionHtml(session: ChatSession, exportedAt: number, avatars?: ChatExportAvatarSet): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const first = messages.length > 0 ? formatDateTime(messages[0].at) : "";
  const last = messages.length > 0 ? formatDateTime(messages[messages.length - 1].at) : "";
  const modeLabel = MODE_LABELS[session.mode ?? ""] || session.mode || "聊天";

  // 头像 data URI 只注入页面 CSS 一次，所有消息共用，避免逐条重复内嵌
  const avatarUser = avatars?.user || defaultAvatarDataUri("user");
  const avatarAssistant = avatars?.assistant || defaultAvatarDataUri("assistant");

  const headerRows: Array<[string, string]> = [
    ["模式", modeLabel],
    ["消息数", `${messages.length} 条`],
    ["时间范围", first || last ? `${first} ~ ${last}` : ""],
    ["工作区", session.workspaceBinding ? session.workspaceBinding.displayName : ""],
  ];

  const headerHtml = headerRows
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `<span class="head-item"><span class="head-key">${escapeHtml(k)}</span>${escapeHtml(v)}</span>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(session.title || "聊天记录")}</title>
<style>
  :root {
    --bg: #f6f4f7; --card: #ffffff;
    --ink: #2d2a31; --ink-soft: #8a8592;
    --user-bubble: #e3f2fd; --user-edge: #bbdefb;
    --ai-bubble: #fff0f4; --ai-edge: #ffd6e2;
    --fold-bg: #faf9fb; --fold-edge: #e8e4ec;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.7 "Segoe UI", "Microsoft YaHei", sans-serif; padding: 24px 16px 48px; }
  .doc { max-width: 760px; margin: 0 auto; }
  .head { background: var(--card); border-radius: 14px; padding: 20px 24px; margin-bottom: 20px; }
  .head h1 { font-size: 19px; margin-bottom: 10px; word-break: break-all; }
  .head-items { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .head-item { font-size: 13px; color: var(--ink-soft); }
  .head-key { margin-right: 5px; }
  .head-key::after { content: "："; }
  .msg { display: flex; gap: 10px; margin-bottom: 18px; align-items: flex-start; }
  .msg-user { flex-direction: row-reverse; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; background-size: cover; background-position: center; }
  .avatar-user { background-image: url("${avatarUser}"); }
  .avatar-assistant { background-image: url("${avatarAssistant}"); }
  .msg-body { display: flex; flex-direction: column; max-width: calc(78% - 48px); min-width: 0; }
  .msg-user .msg-body { align-items: flex-end; }
  .msg-assistant .msg-body { align-items: flex-start; }
  .bubble { background: var(--card); border-radius: 14px; padding: 10px 14px; border: 1px solid var(--fold-edge); }
  .msg-user .bubble { background: var(--user-bubble); border-color: var(--user-edge); border-bottom-right-radius: 4px; }
  .msg-assistant .bubble { background: var(--ai-bubble); border-color: var(--ai-edge); border-bottom-left-radius: 4px; }
  .meta { font-size: 12px; color: var(--ink-soft); margin-top: 5px; padding: 0 4px; }
  .content p { margin: 0 0 8px; }
  .content p:last-child { margin-bottom: 0; }
  .content h1, .content h2, .content h3, .content h4 { margin: 10px 0 6px; font-size: 1.05em; }
  .content ul { margin: 4px 0 8px; padding-left: 20px; }
  .content pre { background: #f0eef3; border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 6px 0; font-size: 13px; }
  .content code { background: #f0eef3; border-radius: 4px; padding: 1px 5px; font-size: 13px; }
  .content pre code { background: none; padding: 0; }
  .content a { color: #c2587e; }
  .fold { background: var(--fold-bg); border: 1px solid var(--fold-edge); border-radius: 9px; margin-bottom: 8px; font-size: 13px; }
  .fold summary { cursor: pointer; padding: 6px 12px; color: var(--ink-soft); user-select: none; }
  .fold-body { padding: 0 12px 10px; color: #5d5966; }
  .fold-body pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0; padding: 8px 10px; background: #f0eef3; border-radius: 6px; font-size: 12px; }
  .tool-item { border-top: 1px dashed var(--fold-edge); padding: 6px 0; }
  .tool-item:first-child { border-top: none; }
  .tool-head { display: flex; align-items: center; gap: 8px; }
  .tool-name { font-weight: 600; }
  .tool-status { font-size: 12px; padding: 0 8px; border-radius: 999px; }
  .st-success { background: #e3f5e8; color: #2e7d46; }
  .st-error { background: #fdeaea; color: #c0564f; }
  .st-running, .st-unknown { background: #eee8f2; color: #6d6879; }
  .tool-args { margin: 5px 0 0; }
  .process-note { margin: 6px 0; }
  .attachment-image img { display: block; max-width: 300px; max-height: 300px; border-radius: 10px; margin-top: 8px; }
  .attachment-missing { margin-top: 8px; font-size: 12px; color: var(--ink-soft); background: var(--fold-bg); border: 1px dashed var(--fold-edge); border-radius: 8px; padding: 6px 10px; }
  .footer { text-align: center; font-size: 12px; color: var(--ink-soft); margin-top: 28px; }
</style>
</head>
<body>
<div class="doc">
  <header class="head">
    <h1>${escapeHtml(session.title || "未命名会话")}</h1>
    <div class="head-items">${headerHtml}</div>
  </header>
  <main>
    ${messages.map((m) => renderMessageHtml(m)).join("\n") || '<p style="color:#8a8592;text-align:center;">（该会话没有消息）</p>'}
  </main>
  <footer class="footer">由 Cyrene 导出 · ${escapeHtml(formatDateTime(exportedAt))}</footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 导出内容渲染：Markdown
// ---------------------------------------------------------------------------

/** 图片附件在 Markdown 导出中只保留文件名标注（不内嵌 base64，保持文本干净）。 */
function renderAttachmentMarkdown(attachment: NonNullable<ChatMessage["attachments"]>[number]): string {
  if (attachment.kind === "image") {
    return `> 图片附件：${attachment.name || attachment.filePath || "未命名图片"}\n`;
  }
  return `> 文档附件：${attachment.name || "未命名文档"}\n`;
}

/** 渲染单条消息的 Markdown 片段。 */
function renderMessageMarkdown(message: ChatMessage): string {
  const isUser = message.role === "user";
  const name = isUser ? USER_NAME : ASSISTANT_NAME;
  const at = formatDateTime(message.at);
  const parts = [`## ${name} · ${at}`];

  if (message.channelSource && message.channelSource.channel) {
    const label = CHANNEL_LABELS[message.channelSource.channel] || message.channelSource.channel;
    const sender = message.channelSource.senderName ? `（${message.channelSource.senderName}）` : "";
    parts.push(`*来自 ${label}${sender}*`);
  }

  const reasoning = collectReasoningText(message);
  const processTexts = collectProcessTexts(message);
  if (reasoning || processTexts.length > 0) {
    const foldParts: string[] = [];
    if (reasoning) foldParts.push(clipText(reasoning, REASONING_LIMIT));
    for (const text of processTexts) foldParts.push(text);
    parts.push(`<details><summary>思考过程</summary>\n\n\`\`\`\n${foldParts.join("\n\n")}\n\`\`\`\n\n</details>`);
  }

  if (Array.isArray(message.toolExecutions) && message.toolExecutions.length > 0) {
    const toolLines = message.toolExecutions
      .map((tool) => {
        const status = TOOL_STATUS_LABELS[tool.status] || String(tool.status ?? "");
        const result = toolResultText(tool) ? clipText(toolResultText(tool), TOOL_RESULT_LIMIT) : "（无结果记录）";
        return `### ${toolLabel(tool)} · ${status}\n\n\`\`\`\n${result}\n\`\`\``;
      })
      .join("\n\n");
    parts.push(`<details><summary>工具调用（${message.toolExecutions.length} 次）</summary>\n\n${toolLines}\n\n</details>`);
  }

  if (message.content) {
    parts.push(String(message.content));
  }

  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      parts.push(renderAttachmentMarkdown(attachment));
    }
  }

  if (message.sticker) {
    parts.push(`*（表情包：${message.sticker}）*`);
  }

  parts.push("---");
  return parts.filter(Boolean).join("\n\n");
}

/** 生成会话的完整 Markdown 文档。 */
export function renderSessionMarkdown(session: ChatSession, exportedAt: number): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const first = messages.length > 0 ? formatDateTime(messages[0].at) : "";
  const last = messages.length > 0 ? formatDateTime(messages[messages.length - 1].at) : "";
  const modeLabel = MODE_LABELS[session.mode ?? ""] || session.mode || "聊天";

  const head = [
    `# ${session.title || "未命名会话"}`,
    "",
    `- 模式：${modeLabel}`,
    `- 消息数：${messages.length} 条`,
    ...(first || last ? [`- 时间范围：${first} ~ ${last}`] : []),
    ...(session.workspaceBinding ? [`- 工作区：${session.workspaceBinding.displayName}`] : []),
    `- 导出时间：${formatDateTime(exportedAt)}`,
    "",
    "---",
    "",
  ].join("\n");

  const body = messages.map(renderMessageMarkdown).join("\n\n") || "（该会话没有消息）\n";
  return `${head}${body}\n`;
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export interface ExportSessionsOptions {
  sessions: ChatSession[];
  formats: ChatExportFormat[];
  targetDir: string;
  avatars?: ChatExportAvatarSet;
  /** 注入时间戳便于测试；缺省取当前时间。 */
  exportedAt?: number;
}

export interface ExportSessionsOutcome {
  files: ChatExportFile[];
  errors: ChatExportError[];
}

/**
 * 把多个会话写入目标目录：
 * - HTML 直接放 targetDir；Markdown 放 targetDir/markdown（与插件行为一致）；
 * - 文件名清洗 Windows 非法字符，重名自动编号；
 * - 单个会话失败只记入 errors，不中断其它会话。
 */
export function exportSessionsToDirectory(options: ExportSessionsOptions): ExportSessionsOutcome {
  const exportedAt = options.exportedAt ?? Date.now();
  const files: ChatExportFile[] = [];
  const errors: ChatExportError[] = [];
  const formats = options.formats.filter((f): f is ChatExportFormat => f === "html" || f === "markdown");
  if (formats.length === 0 || options.sessions.length === 0) return { files, errors };

  const targetDir = options.targetDir;
  const markdownDir = path.join(targetDir, "markdown");
  fs.mkdirSync(targetDir, { recursive: true });
  if (formats.includes("markdown")) fs.mkdirSync(markdownDir, { recursive: true });

  for (const session of options.sessions) {
    const base = `${sanitizeFileName(session.title)}-${formatDateCompact(session.updatedAt || exportedAt)}`;
    try {
      if (formats.includes("html")) {
        const name = uniqueFileName(targetDir, base, ".html");
        const filePath = path.join(targetDir, name);
        fs.writeFileSync(filePath, renderSessionHtml(session, exportedAt, options.avatars), "utf8");
        files.push({ name, path: filePath, sessionId: session.id });
      }
      if (formats.includes("markdown")) {
        const name = uniqueFileName(markdownDir, base, ".md");
        const filePath = path.join(markdownDir, name);
        fs.writeFileSync(filePath, renderSessionMarkdown(session, exportedAt), "utf8");
        files.push({ name, path: filePath, sessionId: session.id });
      }
    } catch (err) {
      errors.push({
        sessionId: session.id,
        title: session.title || session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { files, errors };
}
