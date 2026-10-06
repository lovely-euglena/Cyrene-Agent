// sync-settings 单测（IKJK2I B）：electron mock + safeStorage enc: 回环 + obf: 回退 + 归一化。
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
  return await import("./sync-settings");
}

function settingsFile(): string {
  return path.join(mocks.userDataDir, "sync", "settings.json");
}

describe("sync/sync-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.storageAvailable = true;
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sync-settings-"));
  });

  it("缺失文件返回默认（默认关闭）", async () => {
    const { loadSyncSettings } = await loadModule();
    expect(loadSyncSettings()).toEqual({ enabled: false, baseUrl: "", deviceName: "", token: "" });
  });

  it("save + load：token 加密落盘（enc:）且明文不出现，回读还原", async () => {
    const { saveSyncSettings, loadSyncSettings } = await loadModule();
    const saved = saveSyncSettings({
      enabled: true,
      baseUrl: "https://cloud.example.com/",
      deviceName: " 我的桌面 ",
      token: "tok-secret",
    });
    expect(saved).toMatchObject({
      enabled: true,
      baseUrl: "https://cloud.example.com",
      deviceName: "我的桌面",
      token: "tok-secret",
    });

    const raw = fs.readFileSync(settingsFile(), "utf8");
    expect(raw).not.toContain("tok-secret");
    expect(raw).toContain('"token": "enc:');

    const loaded = loadSyncSettings();
    expect(loaded.token).toBe("tok-secret");
    expect(loaded.baseUrl).toBe("https://cloud.example.com");
    expect(loaded.deviceName).toBe("我的桌面");
  });

  it("safeStorage 不可用时回退 obf: 混淆，仍可 round-trip", async () => {
    mocks.storageAvailable = false;
    const { saveSyncSettings, loadSyncSettings } = await loadModule();
    saveSyncSettings({ enabled: true, baseUrl: "https://x", token: "tok-obf" });

    const raw = fs.readFileSync(settingsFile(), "utf8");
    expect(raw).toContain('"token": "obf:');
    expect(raw).not.toContain("tok-obf");
    expect(loadSyncSettings().token).toBe("tok-obf");
  });

  it("局部补丁不丢字段；token 空串 = 清除；已带前缀不重复加密", async () => {
    const { saveSyncSettings, loadSyncSettings } = await loadModule();
    saveSyncSettings({ enabled: true, baseUrl: "https://x", deviceName: "desk", token: "tok-1" });
    saveSyncSettings({ deviceName: "desk-2" });
    expect(loadSyncSettings()).toMatchObject({
      enabled: true,
      baseUrl: "https://x",
      deviceName: "desk-2",
      token: "tok-1",
    });

    // 密文回传（读取到的已是明文，模拟直接把 enc: 形态写回）不二次加密
    const rawBefore = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { token: string };
    saveSyncSettings({ token: rawBefore.token });
    const rawAfter = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { token: string };
    expect(rawAfter.token).toBe(rawBefore.token);

    saveSyncSettings({ token: "" });
    expect(loadSyncSettings().token).toBe("");
    expect(fs.readFileSync(settingsFile(), "utf8")).toContain('"token": ""');
  });

  it("normalize：enabled 严格布尔 / baseUrl 去尾斜杠 / 非法类型收敛", async () => {
    const { normalizeSyncSettings } = await loadModule();
    expect(normalizeSyncSettings(null)).toEqual({ enabled: false, baseUrl: "", deviceName: "", token: "" });
    expect(normalizeSyncSettings({
      enabled: "yes" as unknown as boolean,
      baseUrl: "  https://a.example.com///  ",
      deviceName: 42 as unknown as string,
      token: "t",
    })).toEqual({ enabled: false, baseUrl: "https://a.example.com", deviceName: "", token: "t" });
  });

  it("toPublicSyncConfig：剥离 token，仅 hasToken", async () => {
    const { toPublicSyncConfig } = await loadModule();
    const publicConfig = toPublicSyncConfig({
      enabled: true,
      baseUrl: "https://x",
      deviceName: "desk",
      token: "tok-secret",
    });
    expect(publicConfig).toEqual({
      enabled: true,
      baseUrl: "https://x",
      deviceName: "desk",
      hasToken: true,
    });
    expect(JSON.stringify(publicConfig)).not.toContain("tok-secret");
  });

  it("损坏 JSON 回默认，不抛", async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), "{ not json", "utf8");
    const { loadSyncSettings } = await loadModule();
    expect(loadSyncSettings()).toEqual({ enabled: false, baseUrl: "", deviceName: "", token: "" });
  });
});
