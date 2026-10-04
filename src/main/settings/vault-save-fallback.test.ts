/**
 * 复审 P0 回归：掩码-保存门控一致性（宿主缺失/迁移未发生 → 保存不丢明文 key）。
 *
 * 场景：CYRENE_SECRETS_HOST=1 但宿主不可用、迁移未发生。渲染端整包回传掩码空串时，
 * saveModelSettings / saveGeneralSettings 必须把空串按「不改」处理，保旧明文 key；
 * 迁移后宿主缺失则硬失败 E_SECRETS_HOST_LOST（IKJNX1 #1）。
 * 走真实保存主链（写盘断言），非纯函数单测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
}));

const vault = new Map<string, string>();

class StubSecretsClient {
  hostUp = false;
  alive = false;
  async ensureStarted() { return this.hostUp; }
  isAlive() { return this.alive; }
  async status() { return { count: vault.size, migrated: false, migratedAt: null, protector: "stub", available: true }; }
  async get(name: string) { return vault.get(name) ?? null; }
  async put(name: string, value: string) { vault.set(name, value); }
  async remove(name: string) { return vault.delete(name); }
  async list() { return [...vault.keys()].map((name) => ({ name, createdAt: "t", updatedAt: "t" })); }
  async import(values: Record<string, string>) { for (const [k, v] of Object.entries(values)) vault.set(k, v); return Object.keys(values).length; }
  async markMigrated() { /* stub */ }
}

const MODEL_FILE = () => path.join(electronMock.userDataDir, "model-settings.json");
const GENERAL_FILE = () => path.join(electronMock.userDataDir, "app-settings.json");

function writeModelFile(): void {
  fs.writeFileSync(MODEL_FILE(), JSON.stringify({
    schemaVersion: 99,
    provider: "PA",
    apiKey: "sk-old-top",
    perProvider: { PA: { apiKey: "sk-old-p", baseUrl: "https://pa.example.com", model: "m" } },
    modelProfiles: [{ id: "pf1", provider: "PA", apiKey: "sk-old-prof", baseUrl: "https://pf.example.com", model: "m1" }],
    vision: { apiKey: "sk-old-v", baseUrl: "https://v.example.com", model: "vm" },
  }, null, 2));
}

function writeGeneralFile(): void {
  fs.writeFileSync(GENERAL_FILE(), JSON.stringify({ ttsMinimaxKey: "sk-tts-old", asrMinimaxKey: "" }, null, 2));
}

async function loadModules() {
  const secrets = await import("../dotnet-backend/secrets-client");
  secrets.__setSecretsDataDirForTests(electronMock.userDataDir); // require("electron") 在 vitest 下不可靠，显式注入
  secrets.__setSecretsHostClientForTests(new StubSecretsClient() as unknown as import("../dotnet-backend/secrets-client").SecretsHostClient);
  const model = await import("./model-settings");
  const facade = await import("./settings-facade");
  return { model, facade };
}

beforeEach(() => {
  vi.resetModules();
  electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vault-save-"));
  process.env.CYRENE_SECRETS_HOST = "1";
  vault.clear();
  writeModelFile();
  writeGeneralFile();
});

afterEach(() => {
  delete process.env.CYRENE_SECRETS_HOST;
  fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
});

describe("复审 P0：迁移前宿主缺失（未 hydrate）保存不丢明文 key", () => {
  it("saveModelSettings：掩码空串载荷（顶层/perProvider/档案/vision）→ 旧 key 全保", async () => {
    const { model } = await loadModules();
    const saved = model.saveModelSettings({
      provider: "PA",
      apiKey: "",
      perProvider: { PA: { apiKey: "" } } as never,
      // 渲染端档案保存是整包回传：除 apiKey 外字段齐全（掩码只清 key）
      modelProfiles: [{
        id: "pf1", provider: "PA", baseUrl: "https://pf.example.com", model: "m1", apiKey: "",
      }] as never,
      vision: { apiKey: "" } as never,
    });

    expect(saved.apiKey).toBe("sk-old-p");
    expect(saved.perProvider?.PA.apiKey).toBe("sk-old-p");
    expect(saved.modelProfiles?.[0].apiKey).toBe("sk-old-prof");
    expect(saved.vision?.apiKey).toBe("sk-old-v");

    const disk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect((disk.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");
    expect((disk.modelProfiles as unknown as Array<{ apiKey: string }>)[0].apiKey).toBe("sk-old-prof");
    expect((disk.vision as unknown as { apiKey: string }).apiKey).toBe("sk-old-v");
    expect(disk.apiKey).toBe("sk-old-p");
  });

  it("saveModelSettings：用户输入非空新值仍正常覆盖（不清盘语义仅限空串）", async () => {
    const { model } = await loadModules();
    const saved = model.saveModelSettings({ provider: "PA", apiKey: "sk-new" });
    expect(saved.apiKey).toBe("sk-new");
    expect(saved.modelProfiles?.[0].apiKey).toBe("sk-old-prof"); // 其它槽位不动
    const disk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as { apiKey: string };
    expect(disk.apiKey).toBe("sk-new");
  });

  it("saveGeneralSettings：掩码空串 TTS/ASR key → 旧 key 全保", async () => {
    const { facade } = await loadModules();
    const saved = facade.saveGeneralSettings({ ttsMinimaxKey: "" });
    expect(saved.ttsMinimaxKey).toBe("sk-tts-old");

    const disk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as { ttsMinimaxKey: string };
    expect(disk.ttsMinimaxKey).toBe("sk-tts-old");

    const savedNew = facade.saveGeneralSettings({ asrMinimaxKey: "sk-asr-new" });
    expect(savedNew.asrMinimaxKey).toBe("sk-asr-new");
  });
});

describe("IKJNX1 #1：迁移后宿主缺失 → 保存主链硬失败（不写明文、不清盘）", () => {
  it("盘上 migratedAt 标记 + 宿主缺失：saveModelSettings / saveGeneralSettings 抛 E_SECRETS_HOST_LOST", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    const { model, facade } = await loadModules();

    expect(() => model.saveModelSettings({ provider: "PA", apiKey: "sk-attempt" }))
      .toThrow(/E_SECRETS_HOST_LOST/);
    expect(() => facade.saveGeneralSettings({ ttsMinimaxKey: "sk-attempt" }))
      .toThrow(/E_SECRETS_HOST_LOST/);

    // 磁盘原样：既没写新值也没清旧值（文件未被触碰，保留原顶层镜像值）
    const disk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as { apiKey: string };
    expect(disk.apiKey).toBe("sk-old-top");
    const generalDisk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as { ttsMinimaxKey: string };
    expect(generalDisk.ttsMinimaxKey).toBe("sk-tts-old");
  });
});
