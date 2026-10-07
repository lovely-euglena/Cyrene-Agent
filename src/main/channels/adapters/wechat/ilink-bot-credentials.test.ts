// iLink 微信凭据加密落盘单测（IKJSNE）：electron mock + safeStorage enc: 回环 +
// obf: 回退 + 历史明文迁移回写 + 坏数据返回 null（照 sync-settings.test.ts 的 mock 方式）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  storageAvailable: true,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
    getName: () => "cyrene-test",
    isReady: () => true,
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.storageAvailable,
    encryptString: (plain: string) => Buffer.from(`ENC(${plain})`),
    decryptString: (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("ENC(") || !text.endsWith(")")) throw new Error("mock decrypt failed");
      return text.slice(4, -1);
    },
  },
}));

async function loadModule() {
  return await import("./ilink-bot-adapter");
}

function credentialsFile(): string {
  return path.join(mocks.userDataDir, "weixin", "credentials.json");
}

const CREDS = {
  botToken: "bot-token-secret",
  ilinkBotId: "bot-123",
  baseUrl: "https://ilinkai.weixin.qq.com",
  ilinkUserId: "wx-user-9",
};

describe("ilink bot credentials", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.storageAvailable = true;
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-ilink-cred-"));
  });

  it("save + load：凭据加密落盘（enc:）且磁盘无明文，回读还原", async () => {
    const { saveCredentials, loadCredentials } = await loadModule();
    await saveCredentials(CREDS);

    const raw = fs.readFileSync(credentialsFile(), "utf8");
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("bot-token-secret");
    expect(raw).not.toContain("ilinkBotId");

    await expect(loadCredentials()).resolves.toEqual(CREDS);
  });

  it("safeStorage 不可用时回退 obf: 混淆，仍可 round-trip", async () => {
    mocks.storageAvailable = false;
    const { saveCredentials, loadCredentials } = await loadModule();
    await saveCredentials(CREDS);

    const raw = fs.readFileSync(credentialsFile(), "utf8");
    expect(raw.startsWith("obf:")).toBe(true);
    expect(raw).not.toContain("bot-token-secret");
    await expect(loadCredentials()).resolves.toEqual(CREDS);
  });

  it("历史明文凭据读入后按新格式回写迁移", async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify(CREDS, null, 2), "utf8");

    const { loadCredentials } = await loadModule();
    await expect(loadCredentials()).resolves.toEqual(CREDS);

    const raw = fs.readFileSync(credentialsFile(), "utf8");
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("bot-token-secret");
    // 迁移后的文件仍可正常回读
    await expect(loadCredentials()).resolves.toEqual(CREDS);
  });

  it("坏数据返回 null：损坏 JSON / 无法解密的 enc: / 缺字段都不抛且不误迁移", async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    const { loadCredentials } = await loadModule();

    fs.writeFileSync(credentialsFile(), "{ not json", "utf8");
    await expect(loadCredentials()).resolves.toBeNull();

    fs.writeFileSync(credentialsFile(), "enc:bm90LWEtdmFsaWQtcGF5bG9hZA==", "utf8");
    await expect(loadCredentials()).resolves.toBeNull();

    // 字段不完整的明文：返回 null，且不把残缺内容迁移加密写盘
    fs.writeFileSync(credentialsFile(), JSON.stringify({ botToken: "only-token" }), "utf8");
    await expect(loadCredentials()).resolves.toBeNull();
    expect(fs.readFileSync(credentialsFile(), "utf8")).toBe(JSON.stringify({ botToken: "only-token" }));
  });

  it.skipIf(process.platform === "win32")("凭据文件与目录权限加固（0600 / 0700，复审 P2-1）", async () => {
    const { saveCredentials } = await loadModule();
    await saveCredentials(CREDS);

    expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(credentialsFile())).mode & 0o777).toBe(0o700);
  });
});
