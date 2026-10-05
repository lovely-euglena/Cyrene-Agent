/**
 * 复审 P0 + PR19 P1-1/P2-6 回归：掩码-保存门控一致性（主链写盘断言）。
 *
 * 场景 A（明文回退）：CYRENE_SECRETS_HOST=1 但宿主不可用、迁移未发生。渲染端整包
 * 回传掩码空串时，saveModelSettings / saveGeneralSettings 把空串按「不改」处理，保旧明文 key。
 * 场景 B（S4）：hydrate 成功后宿主猝死 + 未迁移（迁移失败仍 hydrate，secrets-keyring.ts:220）——
 * 非 key patch 正常落盘且不抛；含非空 key / SENTINEL 抛 E_SECRETS_HOST_LOST；磁盘 key 槽
 * 逐槽保持磁盘原值（不取内存/keyring、不被空串覆盖）。
 * 场景 C（迁移后宿主缺失）：含 key 硬失败；非 key patch 不连坐。
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
  failImport = false;
  async ensureStarted() { return this.hostUp; }
  isAlive() { return this.alive; }
  async status() { return { count: vault.size, migrated: false, migratedAt: null, protector: "stub", available: true }; }
  async get(name: string) { return vault.get(name) ?? null; }
  async put(name: string, value: string) { vault.set(name, value); }
  async remove(name: string) { return vault.delete(name); }
  async list() { return [...vault.keys()].map((name) => ({ name, createdAt: "t", updatedAt: "t" })); }
  async import(values: Record<string, string>) {
    if (this.failImport) throw new Error("stub import failure");
    for (const [k, v] of Object.entries(values)) vault.set(k, v);
    return Object.keys(values).length;
  }
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

let stub: StubSecretsClient;

async function loadModules() {
  const secrets = await import("../dotnet-backend/secrets-client");
  secrets.__setSecretsDataDirForTests(electronMock.userDataDir); // require("electron") 在 vitest 下不可靠，显式注入
  stub = new StubSecretsClient();
  secrets.__setSecretsHostClientForTests(stub as unknown as import("../dotnet-backend/secrets-client").SecretsHostClient);
  const model = await import("./model-settings");
  const facade = await import("./settings-facade");
  const keyring = await import("./secrets-keyring");
  return { model, facade, keyring, stub };
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

describe("IKJNX1 #1 + PR19 P2-6：迁移后宿主缺失 → 含 key 硬失败；非 key 保存不连坐", () => {
  it("盘上 migratedAt 标记 + 宿主缺失：含 key 的 saveModelSettings / saveGeneralSettings 抛 E_SECRETS_HOST_LOST", async () => {
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

  it("P2-6：同态下非 key 保存正常落盘（宠物位置/缓存目录等不连坐），磁盘 key 槽保持原值", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    const { model, facade } = await loadModules();

    const saved = model.saveModelSettings({ provider: "PA", model: "m-marker" });
    expect(saved.model).toBe("m-marker");
    const modelDisk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect(modelDisk.model).toBe("m-marker");
    expect(modelDisk.apiKey).toBe("sk-old-top"); // key 槽磁盘原值（不取内存明文、不被空串覆盖）
    expect((modelDisk.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");

    const general = facade.saveGeneralSettings({ petWindowX: 7, cacheDirOverride: "D:/cache" });
    expect(general.petWindowX).toBe(7);
    const generalDisk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as Record<string, unknown>;
    expect(generalDisk.petWindowX).toBe(7);
    expect(generalDisk.ttsMinimaxKey).toBe("sk-tts-old"); // key 槽磁盘原值
  });
});

describe("PR19 P1-1：hydrate 成功后宿主猝死 + 未迁移（S4）主链写盘", () => {
  it("掩码空串整包保存：非 key 字段落盘；磁盘 key 槽保持原值（不取内存/keyring、不空串覆盖）", async () => {
    const { model, keyring, stub } = await loadModules();
    stub.hostUp = true;
    stub.alive = true;
    stub.failImport = true; // 迁移 import 失败 → 未迁移、无 marker；随后仍无条件 hydrate（S4 来源）
    vault.set("model:provider:PA", "sk-vault-p"); // keyring 有值（与磁盘明文不同）→ 回填后内存持 vault 真值
    const r = await keyring.initSecretsVault(MODEL_FILE(), GENERAL_FILE());
    expect(r.hydrated).toBe(true);
    expect(keyring.isVaultMigrated()).toBe(false);
    expect(keyring.isVaultAuthoritative()).toBe(true);
    stub.alive = false; // 宿主猝死 → vault 不可写

    // 渲染端掩码整包回传：apiKey 全空（陈旧掩码），模型名改为 m-new
    const saved = model.saveModelSettings({
      provider: "PA",
      model: "m-new",
      apiKey: "",
      perProvider: { PA: { apiKey: "", baseUrl: "https://pa.example.com", model: "m" } } as never,
      modelProfiles: [{ id: "pf1", provider: "PA", baseUrl: "https://pf.example.com", model: "m1", apiKey: "" }] as never,
      vision: { baseUrl: "https://v.example.com", model: "vm", apiKey: "" } as never,
    });

    // ① 非 key patch 正常落盘且不抛；内存持 keyring 真值
    expect(saved.model).toBe("m-new");
    expect(saved.apiKey).toBe("sk-vault-p");
    expect(saved.perProvider?.PA.apiKey).toBe("sk-vault-p");

    // ③ 磁盘 key 槽：全部保持磁盘原值（不写 keyring 真值、不被空串覆盖）
    const disk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect(disk.model).toBe("m-new");
    expect(disk.apiKey).toBe("sk-old-top");
    expect((disk.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");
    expect((disk.modelProfiles as unknown as Array<{ apiKey: string }>)[0].apiKey).toBe("sk-old-prof");
    expect((disk.vision as unknown as { apiKey: string }).apiKey).toBe("sk-old-v");

    // ② 含非空 key / SENTINEL 的 patch：抛 E_SECRETS_HOST_LOST 且磁盘 key 原值不变
    expect(() => model.saveModelSettings({ provider: "PA", apiKey: "sk-attempt" }))
      .toThrow(/E_SECRETS_HOST_LOST/);
    expect(() => model.saveModelSettings({ provider: "PA", apiKey: keyring.SECRET_CLEAR_SENTINEL }))
      .toThrow(/E_SECRETS_HOST_LOST/);
    const diskAfter = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect(diskAfter.apiKey).toBe("sk-old-top");
    expect((diskAfter.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");
  });

  it("general：非 key 保存不连坐（P2-6）；含 key/SENTINEL 抛错且磁盘 key 原值不变", async () => {
    const { facade, keyring, stub } = await loadModules();
    stub.hostUp = true;
    stub.alive = true;
    stub.failImport = true;
    vault.set("tts:minimax", "sk-tts-vault"); // keyring 真值与磁盘明文不同
    const r = await keyring.initSecretsVault(MODEL_FILE(), GENERAL_FILE());
    expect(r.hydrated).toBe(true);
    stub.alive = false;

    const saved = facade.saveGeneralSettings({ petWindowX: 12 });
    expect(saved.petWindowX).toBe(12);
    expect(saved.ttsMinimaxKey).toBe("sk-tts-vault"); // 内存持 keyring 真值

    const disk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as Record<string, unknown>;
    expect(disk.petWindowX).toBe(12);
    expect(disk.ttsMinimaxKey).toBe("sk-tts-old"); // 磁盘 key 槽原值（不写 keyring 真值、不空串覆盖）

    expect(() => facade.saveGeneralSettings({ ttsMinimaxKey: "sk-attempt" })).toThrow(/E_SECRETS_HOST_LOST/);
    expect(() => facade.saveGeneralSettings({ ttsMinimaxKey: keyring.SECRET_CLEAR_SENTINEL })).toThrow(/E_SECRETS_HOST_LOST/);
    expect((JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as { ttsMinimaxKey: string }).ttsMinimaxKey)
      .toBe("sk-tts-old");
  });
});
