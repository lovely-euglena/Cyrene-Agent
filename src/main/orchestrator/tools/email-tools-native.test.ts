/**
 * email 四件 native 轨接线测试（IKJK3V T2 库替代批）：
 *  - send_email：校验 + 确认卡（TS/B2）→ config 帧下发（含授权码，B1 仅内存）→ native 发送（60s 看门狗）；
 *    native 失败回退 nodemailer（不再重复弹确认卡）
 *  - email_list / email_read / email_mark：config 帧下发 + native 调用 + 失败回退
 *  - 校验路径（未启用/收件人无效/取消）不触达 native
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sendMail: vi.fn(),
  requestUserChoice: vi.fn(),
  nativeCalls: [] as Array<{ tool: string; args: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }>,
  nativeResult: null as string | null,
  nativeError: null as Error | null,
}));

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: h.sendMail }) } }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    connect(): Promise<void> { return Promise.resolve(); }
    logout(): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
    getMailboxLock(): { release: () => void } { return { release: () => {} }; }
    search(): number[] { return []; }
    fetch(): AsyncIterable<never> { return (async function* () {})(); }
    fetchOne(): null { return null; }
    messageFlagsAdd(): Promise<void> { return Promise.resolve(); }
    messageFlagsRemove(): Promise<void> { return Promise.resolve(); }
  },
}));
vi.mock("mailparser", () => ({ simpleParser: async () => ({}) }));
vi.mock("../../user-choice", () => ({
  requestUserChoice: (...a: unknown[]) => h.requestUserChoice(...a),
}));

import { nativeToolHost } from "./native-tool-host";
import { registerEmailTools, setEmailConfig } from "./email-tools";
import { toolRegistry } from "./registry/tool-registry";

registerEmailTools();

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

function getTool(id: string): {
  execute: (args: Record<string, unknown>, ctx?: { runId?: string }) => Promise<string>;
} {
  const tool = toolRegistry.getById(id);
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool as never;
}

beforeEach(() => {
  h.nativeCalls.length = 0;
  h.nativeResult = null;
  h.nativeError = null;
  h.sendMail.mockReset();
  h.requestUserChoice.mockReset();
  vi.spyOn(nativeToolHost, "call").mockImplementation(
    async (tool: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => {
      h.nativeCalls.push({ tool, args, timeoutMs, signal });
      if (h.nativeError) throw h.nativeError;
      return h.nativeResult;
    },
  );
});

describe("email 四件 native 轨", () => {
  it("send_email：确认后下发配置帧并 native 发送（60s 看门狗）", async () => {
    injectConfig();
    h.requestUserChoice.mockResolvedValue("send");
    h.nativeResult = "[send_email] 已发送：to@example.com 主题：Hi";

    const out = await getTool("send_email").execute(
      { to: ["to@example.com"], subject: "Hi", body: "Hello" },
      {},
    );

    expect(out).toBe("[send_email] 已发送：to@example.com 主题：Hi");
    expect(h.requestUserChoice).toHaveBeenCalledTimes(1);
    expect(h.nativeCalls).toEqual([
      {
        tool: "send_email",
        args: { to: ["to@example.com"], cc: [], subject: "Hi", body: "Hello", attachments: [] },
        timeoutMs: 60_000,
        signal: undefined,
      },
    ]);
    expect(nativeToolHost.getRuntimeSettings().email).toEqual({
      enabled: true, smtpHost: "smtp.qq.com", smtpPort: 465, smtpSecure: true,
      user: "sender@qq.com", pass: "authcode123", fromName: "昔涟",
      imapHost: "imap.qq.com", imapPort: 993, imapSecure: true,
    });
  });

  it("send_email：用户取消 → 不触达 native", async () => {
    injectConfig();
    h.requestUserChoice.mockResolvedValue("cancel");
    const out = await getTool("send_email").execute({ to: ["a@b.com"], subject: "s", body: "b" }, {});
    expect(out).toBe("[send_email] 用户取消发送");
    expect(h.nativeCalls).toHaveLength(0);
  });

  it("send_email：校验失败（收件人无效）→ 不触达 native、不弹卡", async () => {
    injectConfig();
    const out = await getTool("send_email").execute({ to: ["bad"], subject: "s", body: "b" }, {});
    expect(out).toBe("[错误] 收件人邮箱无效：bad");
    expect(h.nativeCalls).toHaveLength(0);
    expect(h.requestUserChoice).not.toHaveBeenCalled();
  });

  it("send_email：native 失败 → 回退 nodemailer（不重复弹确认卡）", async () => {
    injectConfig();
    h.requestUserChoice.mockResolvedValue("send");
    h.nativeError = new Error("host down");
    h.sendMail.mockResolvedValue({ messageId: "m1" });

    const out = await getTool("send_email").execute(
      { to: ["to@example.com"], subject: "Hi", body: "Hello" },
      {},
    );

    expect(out).toBe("[send_email] 已发送：to@example.com 主题：Hi");
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(h.requestUserChoice).toHaveBeenCalledTimes(1); // 确认只发生一次
  });

  it("email_list：下发配置帧 + native 调用 + 结果透传", async () => {
    injectConfig();
    h.nativeResult = "[email_list] INBOX 共 2 封；最近 2 封：\n- uid=2 · 未读 · ...";
    const out = await getTool("email_list").execute({ limit: 5, unreadOnly: true }, {});
    expect(out).toBe(h.nativeResult);
    expect(h.nativeCalls).toEqual([
      { tool: "email_list", args: { limit: 5, unreadOnly: true }, timeoutMs: 60_000, signal: undefined },
    ]);
    expect(nativeToolHost.getRuntimeSettings().email?.imapHost).toBe("imap.qq.com");
  });

  it("email_read / email_mark：native 调用参数透传", async () => {
    injectConfig();
    h.nativeResult = "[email_read] uid=7（folder=INBOX）...";
    await getTool("email_read").execute({ uid: 7, markSeen: false }, {});
    h.nativeResult = "[email_mark] uid=7 已标记为未读（folder=INBOX）";
    await getTool("email_mark").execute({ uid: 7, seen: false }, {});
    expect(h.nativeCalls.map((c) => c.tool)).toEqual(["email_read", "email_mark"]);
    expect(h.nativeCalls[0].args).toEqual({ uid: 7, markSeen: false });
    expect(h.nativeCalls[1].args).toEqual({ uid: 7, seen: false });
  });

  it("email_list：native 失败 → 回退 TS（未启用时返回未启用文案）", async () => {
    injectConfig({ enabled: false });
    h.nativeError = new Error("host down");
    const out = await getTool("email_list").execute({}, {});
    expect(out).toBe("[错误] 邮件功能未启用，请在设置里开启");
  });

  it("取消（AbortError）：原样上抛", async () => {
    injectConfig();
    const err = new Error("aborted");
    err.name = "AbortError";
    h.nativeError = err;
    await expect(getTool("email_list").execute({}, {})).rejects.toThrow("aborted");
  });
});
