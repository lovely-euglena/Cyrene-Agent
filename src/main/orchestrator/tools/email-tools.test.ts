import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted 保证 mock 变量在 vi.mock 工厂里可用（vi.mock 会被提升到文件顶部）
const {
  sendMailMock, createTransportMock, requestUserChoiceMock, existsSyncMock,
  imapCtorMock, imapConnectMock, imapLogoutMock, imapCloseMock,
  getMailboxLockMock, searchMock, fetchMock, fetchOneMock,
  flagsAddMock, flagsRemoveMock, simpleParserMock,
} = vi.hoisted(() => ({
  sendMailMock: vi.fn(),
  createTransportMock: vi.fn(() => ({ sendMail: sendMailMock })),
  requestUserChoiceMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
  imapCtorMock: vi.fn(),
  imapConnectMock: vi.fn(),
  imapLogoutMock: vi.fn(),
  imapCloseMock: vi.fn(),
  getMailboxLockMock: vi.fn(),
  searchMock: vi.fn(),
  fetchMock: vi.fn(),
  fetchOneMock: vi.fn(),
  flagsAddMock: vi.fn(),
  flagsRemoveMock: vi.fn(),
  simpleParserMock: vi.fn(),
}));

// mock nodemailer
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

// mock imapflow（收信）
vi.mock("imapflow", () => ({
  ImapFlow: class {
    connect(...a: unknown[]) { return imapConnectMock(...a); }
    logout(...a: unknown[]) { return imapLogoutMock(...a); }
    close(...a: unknown[]) { return imapCloseMock(...a); }
    getMailboxLock(...a: unknown[]) { return getMailboxLockMock(...a); }
    search(...a: unknown[]) { return searchMock(...a); }
    fetch(...a: unknown[]) { return fetchMock(...a); }
    fetchOne(...a: unknown[]) { return fetchOneMock(...a); }
    messageFlagsAdd(...a: unknown[]) { return flagsAddMock(...a); }
    messageFlagsRemove(...a: unknown[]) { return flagsRemoveMock(...a); }
    constructor(options: unknown) { imapCtorMock(options); }
  },
}));

// mock mailparser（MIME 解析）
vi.mock("mailparser", () => ({
  simpleParser: (...a: unknown[]) => simpleParserMock(...a),
}));

// mock requestUserChoice —— 默认返回 "send"
vi.mock("../../user-choice", () => ({
  requestUserChoice: (...a: unknown[]) => requestUserChoiceMock(...a),
}));

// mock fs.existsSync —— 默认 true（附件存在）
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: existsSyncMock };
});

import { setEmailConfig, registerEmailTools } from "./email-tools";
import { toolRegistry } from "./registry/tool-registry";

// 注入测试配置
function injectConfig(overrides: Record<string, unknown> = {}): void {
  const cfg = {
    enabled: true,
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: "sender@qq.com",
    pass: "authcode123",
    fromName: "昔涟",
    imapHost: "imap.qq.com",
    imapPort: 993,
    imapSecure: true,
    ...overrides,
  };
  setEmailConfig(
    () => cfg.enabled as boolean,
    () => cfg.host as string,
    () => cfg.port as number,
    () => cfg.secure as boolean,
    () => cfg.user as string,
    () => cfg.pass as string,
    () => cfg.fromName as string,
    () => cfg.imapHost as string,
    () => cfg.imapPort as number,
    () => cfg.imapSecure as boolean,
  );
}

/** 把数组包装成 IMAP fetch 需要的异步迭代器 */
function asyncIterable<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

// 注册工具拿到 execute
registerEmailTools();
const exec = toolRegistry.getById("send_email")!.execute;
const listExec = toolRegistry.getById("email_list")!.execute;
const readExec = toolRegistry.getById("email_read")!.execute;
const markExec = toolRegistry.getById("email_mark")!.execute;

describe("send_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestUserChoiceMock.mockResolvedValue("send");
    sendMailMock.mockResolvedValue({ messageId: "<test@localhost>" });
    existsSyncMock.mockReturnValue(true);
    injectConfig();
  });

  it("功能未启用 → 返回错误", async () => {
    injectConfig({ enabled: false });
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] 邮件功能未启用，请在设置里开启");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("SMTP 配置不完整 → 返回错误", async () => {
    injectConfig({ host: "" });
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] SMTP 配置不完整：缺少 主机/用户名/授权码");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("收件人邮箱格式无效 → 返回错误", async () => {
    const res = await exec({ to: ["not-an-email"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] 收件人邮箱无效：not-an-email");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("附件不存在 → 返回错误（前置校验，不进确认）", async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await exec({
      to: ["a@b.com"],
      subject: "标题",
      body: "正文",
      attachments: ["C:/nope.txt"],
    });
    expect(res).toBe("[错误] 附件不存在：C:/nope.txt");
    expect(requestUserChoiceMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("用户取消 → 返回取消，不调用 sendMail", async () => {
    requestUserChoiceMock.mockResolvedValue("cancel");
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[send_email] 用户取消发送");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("确认卡带 runId（run 内工具必须透传，否则渲染端 RunEventGate 丢弃）", async () => {
    await exec({ to: ["a@b.com"], subject: "标题", body: "正文" }, { runId: "run-1" } as never);
    expect(requestUserChoiceMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "cancel",
      { runId: "run-1" },
    );
  });

  it("用户确认 → 调 sendMail，参数正确（from 含 fromName 转义、cc undefined、attachments 映射）", async () => {
    const res = await exec({
      to: ["a@b.com", "c@d.com"],
      subject: "周报",
      body: "本周内容",
      attachments: ["C:/report.docx"],
    });
    expect(res).toBe("[send_email] 已发送：a@b.com, c@d.com 主题：周报");
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      auth: { user: "sender@qq.com", pass: "authcode123" },
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"昔涟" <sender@qq.com>');
    expect(mailOpts.to).toBe("a@b.com, c@d.com");
    expect(mailOpts.cc).toBeUndefined();
    expect(mailOpts.subject).toBe("周报");
    expect(mailOpts.text).toBe("本周内容");
    expect(mailOpts.attachments).toEqual([{ filename: "report.docx", path: "C:/report.docx" }]);
  });

  it("fromName 含双引号 → 转义后传入 from", async () => {
    injectConfig({ fromName: '她说"你好"' });
    await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"她说\\"你好\\"" <sender@qq.com>');
  });

  it("cc 非空 → 传入 join 后的 cc", async () => {
    await exec({ to: ["a@b.com"], cc: ["x@y.com", "z@w.com"], subject: "标题", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.cc).toBe("x@y.com, z@w.com");
  });

  it("sendMail 抛错 → 捕获返回错误字符串", async () => {
    sendMailMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] 发送失败：connect ECONNREFUSED");
  });
});

describe("email_list / email_read / email_mark（IMAP 收信）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    injectConfig();
    imapConnectMock.mockResolvedValue(undefined);
    imapLogoutMock.mockResolvedValue(undefined);
    imapCloseMock.mockResolvedValue(undefined);
    getMailboxLockMock.mockResolvedValue({ release: vi.fn() });
    flagsAddMock.mockResolvedValue(undefined);
    flagsRemoveMock.mockResolvedValue(undefined);
    searchMock.mockResolvedValue([]);
    fetchMock.mockReturnValue(asyncIterable([]));
    fetchOneMock.mockResolvedValue(null);
    simpleParserMock.mockResolvedValue({});
  });

  it("IMAP 未配置 → 可展示错误，不建连", async () => {
    injectConfig({ imapHost: "" });
    const res = await listExec({});
    expect(res).toBe("[错误] IMAP 未配置：请在设置 → 插件 → 邮件 填写 IMAP 服务器（收信与发信共用邮箱与授权码）");
    expect(imapCtorMock).not.toHaveBeenCalled();
  });

  it("email_list：搜索未读 + 取最近 N 封倒序；连接参数与账号复用 SMTP 凭据", async () => {
    searchMock.mockResolvedValue([11, 12, 13, 14]);
    fetchMock.mockReturnValue(asyncIterable([
      { uid: 14, envelope: { subject: "最新邮件", from: [{ name: "小王", address: "x@y.com" }], date: new Date("2026-09-27T08:00:00Z") }, flags: new Set() },
      { uid: 13, envelope: { subject: "第二封", from: [{ address: "a@b.com" }], date: new Date("2026-09-26T08:00:00Z") }, flags: new Set(["\\Seen"]) },
    ]));

    const res = await listExec({ unreadOnly: true, limit: 2 });
    expect(imapCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      host: "imap.qq.com",
      port: 993,
      secure: true,
      auth: { user: "sender@qq.com", pass: "authcode123" },
    }));
    expect(searchMock).toHaveBeenCalledWith({ seen: false }, { uid: true });
    expect(fetchMock.mock.calls[0][0]).toEqual([14, 13]);
    expect(res).toContain("uid=14");
    expect(res).toContain("未读");
    expect(res).toContain("发件人：小王 <x@y.com>");
    expect(res).toContain("uid=13");
    expect(res).toContain("已读");
    expect(imapLogoutMock).toHaveBeenCalled();
  });

  it("email_list：search 关键词客户端过滤（主题/发件人不匹配则跳过）", async () => {
    searchMock.mockResolvedValue([1, 2]);
    fetchMock.mockReturnValue(asyncIterable([
      { uid: 2, envelope: { subject: "账单", from: [{ address: "bill@x.com" }] }, flags: new Set() },
      { uid: 1, envelope: { subject: "会议邀请", from: [{ address: "boss@x.com" }] }, flags: new Set() },
    ]));
    const res = await listExec({ search: "会议" });
    expect(res).toContain("uid=1");
    expect(res).not.toContain("uid=2");
  });

  it("email_read：解析正文/附件并默认标记已读", async () => {
    fetchOneMock.mockResolvedValue({ uid: 7, source: Buffer.from("raw-mime") });
    simpleParserMock.mockResolvedValue({
      subject: "项目进度",
      from: { text: "小王 <x@y.com>" },
      to: { text: "sender@qq.com" },
      date: new Date("2026-09-27T09:00:00Z"),
      text: "这是正文内容",
      attachments: [{ filename: "report.pdf", size: 2048 }],
    });

    const res = await readExec({ uid: 7 });
    expect(simpleParserMock).toHaveBeenCalledWith(Buffer.from("raw-mime"));
    expect(flagsAddMock).toHaveBeenCalledWith(7, ["\\Seen"], { uid: true });
    expect(res).toContain("[email_read] uid=7");
    expect(res).toContain("主题：项目进度");
    expect(res).toContain("发件人：小王 <x@y.com>");
    expect(res).toContain("report.pdf (2KB)");
    expect(res).toContain("这是正文内容");
  });

  it("email_read：markSeen=false 不标记；非法 uid 不建连", async () => {
    fetchOneMock.mockResolvedValue({ uid: 8, source: Buffer.from("raw") });
    simpleParserMock.mockResolvedValue({ subject: "s", from: { text: "f" }, text: "t" });
    await readExec({ uid: 8, markSeen: false });
    expect(flagsAddMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const res = await readExec({ uid: "abc" });
    expect(res).toBe("[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）");
    expect(imapCtorMock).not.toHaveBeenCalled();
  });

  it("email_read：找不到 uid → 错误", async () => {
    fetchOneMock.mockResolvedValue(null);
    const res = await readExec({ uid: 99 });
    expect(res).toBe("[错误] 未找到 uid=99 的邮件（folder=INBOX）");
  });

  it("email_mark：seen=false 调 messageFlagsRemove", async () => {
    const res = await markExec({ uid: 5, seen: false });
    expect(flagsRemoveMock).toHaveBeenCalledWith(5, ["\\Seen"], { uid: true });
    expect(flagsAddMock).not.toHaveBeenCalled();
    expect(res).toBe("[email_mark] uid=5 已标记为未读（folder=INBOX）");
  });

  it("连接失败 → 返回可展示错误（不抛异常）", async () => {
    imapConnectMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND imap.qq.com"));
    const res = await listExec({});
    expect(res).toBe("[错误] 连接邮箱失败：getaddrinfo ENOTFOUND imap.qq.com");
    expect(imapCloseMock).toHaveBeenCalled();
  });
});
