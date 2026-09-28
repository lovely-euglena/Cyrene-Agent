// ✉️ 邮件工具 —— SMTP 直发（send_email）+ IMAP 收信（email_list / email_read / email_mark）。
//
// 设计原则：
// - 复用 GeneralSettings 中 SMTP/IMAP 配置（认证共用 emailSmtpUser/emailSmtpPass）
// - SMTP 用 nodemailer、IMAP 用 imapflow + mailparser，每次执行新建连接（不缓存，配置即时生效）
// - 发信前用 requestUserChoice 弹确认卡片（runId 透传，渲染端 RunEventGate 按 run 过滤）
// - 配置通过 setEmailConfig 注入 getter（避免 import index.ts 循环依赖）
// - 错误以 [错误]/[工具名] 字符串返回，不抛异常（流回对话）

import * as fs from "fs";
import * as path from "path";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { requestUserChoice, type ChoiceOption } from "../../user-choice";
import { logger, LogTag } from "../../logger";

const LOG_PREFIX = "[EmailTools]";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** email_read 正文截断（字符；工具结果另有全局预算，这里先兜底防爆帧） */
const EMAIL_BODY_LIMIT = 4000;

// ══════════════════════════════════════════════════════════
// 配置注入
// ══════════════════════════════════════════════════════════

let emailEnabledGetter: (() => boolean) | null = null;
let smtpHostGetter: (() => string) | null = null;
let smtpPortGetter: (() => number) | null = null;
let smtpSecureGetter: (() => boolean) | null = null;
let smtpUserGetter: (() => string) | null = null;
let smtpPassGetter: (() => string) | null = null;
let fromNameGetter: (() => string) | null = null;
let imapHostGetter: (() => string) | null = null;
let imapPortGetter: (() => number) | null = null;
let imapSecureGetter: (() => boolean) | null = null;

/** index.ts 启动时注入 SMTP/IMAP 配置获取器（每次执行实时读 GeneralSettings）。 */
export function setEmailConfig(
  enabledGetter: () => boolean,
  hostGetter: () => string,
  portGetter: () => number,
  secureGetter: () => boolean,
  userGetter: () => string,
  passGetter: () => string,
  fromNameFn: () => string,
  imapHostFn: () => string,
  imapPortFn: () => number,
  imapSecureFn: () => boolean,
): void {
  emailEnabledGetter = enabledGetter;
  smtpHostGetter = hostGetter;
  smtpPortGetter = portGetter;
  smtpSecureGetter = secureGetter;
  smtpUserGetter = userGetter;
  smtpPassGetter = passGetter;
  fromNameGetter = fromNameFn;
  imapHostGetter = imapHostFn;
  imapPortGetter = imapPortFn;
  imapSecureGetter = imapSecureFn;
}

// ══════════════════════════════════════════════════════════
// 发信（SMTP）
// ══════════════════════════════════════════════════════════

async function executeSendEmail(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  // 1. 读配置 + 启用检查
  const enabled = emailEnabledGetter?.() ?? false;
  if (!enabled) {
    return "[错误] 邮件功能未启用，请在设置里开启";
  }
  const host = smtpHostGetter?.() ?? "";
  const user = smtpUserGetter?.() ?? "";
  const pass = smtpPassGetter?.() ?? "";
  if (!host || !user || !pass) {
    return "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码";
  }
  const port = smtpPortGetter?.() ?? 465;
  const secure = smtpSecureGetter?.() ?? (port === 465);
  const fromName = fromNameGetter?.() ?? "";

  // 2. 校验收件人
  const to = (args.to as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  if (to.length === 0) {
    return "[错误] 收件人列表为空";
  }
  const invalidTo = to.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidTo) {
    return `[错误] 收件人邮箱无效：${invalidTo}`;
  }
  const cc = (args.cc as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  const invalidCc = cc.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidCc) {
    return `[错误] 抄送邮箱无效：${invalidCc}`;
  }

  // 3. 正文
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  const html = args.html ? String(args.html) : undefined;
  if (!subject) {
    return "[错误] 邮件主题不能为空";
  }
  if (!body && !html) {
    return "[错误] 邮件正文不能为空";
  }

  // 4. 【前置校验】附件存在性
  const attachments = (args.attachments as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  for (const p of attachments) {
    if (!fs.existsSync(p)) {
      return `[错误] 附件不存在：${p}`;
    }
  }

  // 5. 确认卡片（实现注意点 12.4：摘要只取 body 纯文本，不截取 html）
  const bodyPreview = body.length > 100 ? body.slice(0, 100) + "…" : body;
  const attachNames = attachments.length > 0
    ? attachments.map(p => path.basename(p)).join(", ")
    : "（无）";
  const question = [
    "确认发送邮件？",
    `收件人：${to.join(", ")}`,
    cc.length > 0 ? `抄送：${cc.join(", ")}` : null,
    `主题：${subject}`,
    `正文摘要：${bodyPreview}`,
    `附件：${attachNames}`,
  ].filter(Boolean).join("\n");
  const options: ChoiceOption[] = [
    { label: "发送", value: "send" },
    { label: "取消", value: "cancel" },
  ];
  // runId 透传给选择卡：渲染端 RunEventGate 按 runId 过滤（缺失时卡片不显示→超时取消）
  const choice = await requestUserChoice(question, options, "cancel", { runId: context?.runId });
  if (choice !== "send") {
    return "[send_email] 用户取消发送";
  }

  // 6. 发送（实现注意点 12.2：fromName 转义；12.3：cc 空数组传 undefined；12.5：每次新建 transport）
  try {
    // 实现注意点 12.5：每次 execute 新建 transport，不缓存模块级实例
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    // 实现注意点 12.2：fromName 双引号转义（RFC 5322）
    const safeName = fromName.replace(/"/g, '\\"');
    const from = fromName ? `"${safeName}" <${user}>` : user;
    // 实现注意点 12.3：cc 为空数组时传 undefined，避免空 CC 头
    const ccField = cc.length > 0 ? cc.join(", ") : undefined;
    const info = await transport.sendMail({
      from,
      to: to.join(", "),
      cc: ccField,
      subject,
      text: body,
      html,
      attachments: attachments.map(p => ({ filename: path.basename(p), path: p })),
    });
    console.log(LOG_PREFIX, "已发送：", info.messageId);
    return `[send_email] 已发送：${to.join(", ")} 主题：${subject}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "发送失败：", msg);
    return `[错误] 发送失败：${msg}`;
  }
}

// ══════════════════════════════════════════════════════════
// 收信（IMAP）
// ══════════════════════════════════════════════════════════

interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** 读取并校验 IMAP 配置；未配置/缺凭据时返回可展示的错误字符串。 */
function readImapConfig(): ImapConfig | string {
  const enabled = emailEnabledGetter?.() ?? false;
  if (!enabled) return "[错误] 邮件功能未启用，请在设置里开启";
  const host = imapHostGetter?.() ?? "";
  const user = smtpUserGetter?.() ?? "";
  const pass = smtpPassGetter?.() ?? "";
  if (!host) {
    return "[错误] IMAP 未配置：请在设置 → 插件 → 邮件 填写 IMAP 服务器（收信与发信共用邮箱与授权码）";
  }
  if (!user || !pass) {
    return "[错误] IMAP 配置不完整：缺少发件邮箱/授权码（收信与发信共用）";
  }
  const port = imapPortGetter?.() ?? 993;
  const secure = imapSecureGetter?.() ?? (port === 993);
  return { host, port, secure, user, pass };
}

/** 建连 → 执行 → 断开；连接/操作失败都转成可展示的错误字符串（不抛异常）。 */
async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T | string> {
  const cfg = readImapConfig();
  if (typeof cfg === "string") return cfg;
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "IMAP 连接失败：", msg);
    try { await client.close(); } catch { /* 已断开 */ }
    return `[错误] 连接邮箱失败：${msg}`;
  }
  try {
    return await fn(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "IMAP 操作失败：", msg);
    return `[错误] 邮箱操作失败：${msg}`;
  } finally {
    try { await client.logout(); } catch { /* 已断开 */ }
  }
}

function readMailbox(args: Record<string, unknown>): string {
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  return folder.length > 0 ? folder : "INBOX";
}

function readUid(args: Record<string, unknown>): number | null {
  const uid = Number(args.uid);
  return Number.isFinite(uid) && uid > 0 ? Math.round(uid) : null;
}

function formatAddress(address: { name?: string; address?: string } | undefined): string {
  if (!address) return "(未知发件人)";
  return address.name ? `${address.name} <${address.address ?? ""}>` : (address.address ?? "(未知发件人)");
}

/** 收件箱/文件夹列表：默认最近 10 封，可只看未读、可关键词过滤主题/发件人。 */
async function executeEmailList(args: Record<string, unknown>): Promise<string> {
  const folder = readMailbox(args);
  const rawLimit = Number(args.limit ?? 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? Math.round(rawLimit) : 10));
  const unreadOnly = args.unreadOnly === true;
  const search = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";

  const result = await withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true }) as number[];
      const recent = uids.slice(-limit).reverse();
      if (recent.length === 0) {
        return unreadOnly ? `[email_list] ${folder} 没有未读邮件` : `[email_list] ${folder} 为空`;
      }
      const lines: string[] = [];
      for await (const message of client.fetch(recent, { uid: true, envelope: true, flags: true }, { uid: true })) {
        const from = formatAddress(message.envelope?.from?.[0]);
        const subject = message.envelope?.subject || "(无主题)";
        if (search && !`${subject} ${from}`.toLowerCase().includes(search)) continue;
        const date = message.envelope?.date ? new Date(message.envelope.date).toLocaleString() : "";
        const seen = message.flags?.has("\\Seen") ? "已读" : "未读";
        lines.push(`- uid=${message.uid} · ${seen} · ${date} · 发件人：${from}\n  主题：${subject}`);
      }
      if (lines.length === 0) {
        return `[email_list] 最近 ${recent.length} 封中没有匹配「${search}」的邮件`;
      }
      const scope = unreadOnly ? "未读" : "共";
      return `[email_list] ${folder} ${scope} ${uids.length} 封；最近 ${lines.length} 封：\n${lines.join("\n")}`;
    } finally {
      lock.release();
    }
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** 读单封邮件：主题/收发件人/时间/附件名 + 纯文本正文（截断）；默认标记已读。 */
async function executeEmailRead(args: Record<string, unknown>): Promise<string> {
  const uid = readUid(args);
  if (uid === null) return "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）";
  const folder = readMailbox(args);
  const markSeen = args.markSeen !== false;

  const result = await withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const message = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!message || !message.source) {
        return `[错误] 未找到 uid=${uid} 的邮件（folder=${folder}）`;
      }
      const parsed = await simpleParser(message.source);
      const toText = Array.isArray(parsed.to)
        ? parsed.to.map(item => item.text).join(", ")
        : (parsed.to?.text ?? "");
      const text = (parsed.text ?? "").trim();
      const bodyText = text.length > EMAIL_BODY_LIMIT
        ? text.slice(0, EMAIL_BODY_LIMIT) + "\n…（正文已截断）"
        : text;
      const attachmentNames = parsed.attachments && parsed.attachments.length > 0
        ? parsed.attachments
            .map(item => `${item.filename ?? "(未命名)"}${item.size ? ` (${Math.round(item.size / 1024)}KB)` : ""}`)
            .join("、")
        : "（无）";
      if (markSeen) {
        try { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch { /* 标记失败不影响阅读 */ }
      }
      return [
        `[email_read] uid=${uid}（folder=${folder}）`,
        `主题：${parsed.subject ?? "(无主题)"}`,
        `发件人：${parsed.from?.text ?? "(未知)"}`,
        `收件人：${toText || "(未知)"}`,
        `时间：${parsed.date ? parsed.date.toLocaleString() : "(未知)"}`,
        `附件：${attachmentNames}`,
        "",
        bodyText || "（无纯文本正文；如需 HTML 原文请告知）",
      ].join("\n");
    } finally {
      lock.release();
    }
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** 标记已读/未读。 */
async function executeEmailMark(args: Record<string, unknown>): Promise<string> {
  const uid = readUid(args);
  if (uid === null) return "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）";
  const folder = readMailbox(args);
  const seen = args.seen !== false;

  const result = await withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      if (seen) {
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      }
      return `[email_mark] uid=${uid} 已标记为${seen ? "已读" : "未读"}（folder=${folder}）`;
    } finally {
      lock.release();
    }
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

// ══════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════

/** 注册邮件工具。index.ts startup 调一次。 */
export function registerEmailTools(): void {
  toolRegistry.register({
    id: "send_email",
    name: "发送邮件",
    description:
      "通过 SMTP 发送邮件给指定收件人，支持附件、抄送。\n\n" +
      "何时用：\n" +
      "- 用户要求发邮件给某人（如「把这份报告发给 xxx@xxx.com」）\n" +
      "- 配合 write_word/excel/pdf 工具，把生成的文件作为附件发送\n" +
      "- 发送正式邮件、周报、通知等\n\n" +
      "不要用于：\n" +
      "- 群发营销邮件（每次只能发少量收件人）\n" +
      "- 不带任何正文内容的空邮件\n" +
      "- 未在设置里配置 SMTP 的情况（会返回配置缺失错误提示）\n\n" +
      "参数：to（收件人数组）、subject（主题）、body（纯文本正文）、" +
      "html（可选 HTML 正文，提供则覆盖 body）、cc（可选抄送）、" +
      "attachments（可选附件绝对路径数组）。",
    enabled: true,
    risk: "network",
    modes: ["work"],
    effectKind: "external_side_effect" as const,
    inputSchema: {
      type: "object",
      properties: {
        to:          { type: "array", items: { type: "string" }, description: "收件人邮箱地址数组" },
        cc:          { type: "array", items: { type: "string" }, description: "抄送（可选）" },
        subject:     { type: "string", description: "邮件主题" },
        body:        { type: "string", description: "邮件正文（纯文本）" },
        html:        { type: "string", description: "HTML 正文（可选，提供则覆盖 body）" },
        attachments: { type: "array", items: { type: "string" }, description: "附件绝对路径数组（agent 生成文件或本地文件路径）" },
      },
      required: ["to", "subject", "body"],
    },
    execute: executeSendEmail,
  });

  toolRegistry.register({
    id: "email_list",
    name: "收邮件（列表）",
    description:
      "通过 IMAP 查看邮箱最近邮件（默认收件箱最近 10 封），返回 uid、已读/未读、时间、发件人与主题。\n\n" +
      "何时用：\n" +
      "- 用户问「有没有新邮件 / 看看我收到了什么 / 谁发的邮件」\n" +
      "- 需要先列出邮件拿到 uid，再用 email_read 读正文\n\n" +
      "参数：folder（可选，默认 INBOX）、limit（可选，1~50，默认 10）、" +
      "unreadOnly（可选，只看未读）、search（可选，按主题/发件人关键词过滤）。",
    enabled: true,
    risk: "network",
    modes: ["work"],
    effectKind: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        folder:     { type: "string", description: "邮箱文件夹（可选，默认 INBOX）" },
        limit:      { type: "number", description: "返回条数（1~50，默认 10）" },
        unreadOnly: { type: "boolean", description: "只看未读邮件" },
        search:     { type: "string", description: "按主题/发件人关键词过滤（可选）" },
      },
    },
    execute: executeEmailList,
  });

  toolRegistry.register({
    id: "email_read",
    name: "读邮件",
    description:
      "读取指定 uid 的邮件详情（主题/收发件人/时间/附件名/纯文本正文，正文超长会截断）。\n\n" +
      "何时用：\n" +
      "- 用户要求查看某封邮件的内容（先用 email_list 拿 uid）\n" +
      "- 需要根据邮件内容做摘要或回复\n\n" +
      "参数：uid（必填，来自 email_list）、folder（可选，默认 INBOX）、" +
      "markSeen（可选，默认 true 标记为已读；传 false 只读不改状态）。",
    enabled: true,
    risk: "network",
    modes: ["work"],
    effectKind: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        uid:      { type: "number", description: "邮件 uid（来自 email_list）" },
        folder:   { type: "string", description: "邮箱文件夹（可选，默认 INBOX）" },
        markSeen: { type: "boolean", description: "是否标记为已读（默认 true）" },
      },
      required: ["uid"],
    },
    execute: executeEmailRead,
  });

  toolRegistry.register({
    id: "email_mark",
    name: "标记邮件已读/未读",
    description:
      "把指定 uid 的邮件标记为已读或未读。\n\n" +
      "何时用：\n" +
      "- 用户要求「标记为已读 / 标为未读 / 已处理完这批邮件」\n\n" +
      "参数：uid（必填）、folder（可选，默认 INBOX）、seen（可选，默认 true=已读，false=未读）。",
    enabled: true,
    risk: "network",
    modes: ["work"],
    effectKind: "mutation" as const,
    inputSchema: {
      type: "object",
      properties: {
        uid:    { type: "number", description: "邮件 uid（来自 email_list）" },
        folder: { type: "string", description: "邮箱文件夹（可选，默认 INBOX）" },
        seen:   { type: "boolean", description: "true=已读（默认），false=未读" },
      },
      required: ["uid"],
    },
    execute: executeEmailMark,
  });

  logger.info(LogTag.EmailTools, "registered: send_email, email_list, email_read, email_mark");
}
