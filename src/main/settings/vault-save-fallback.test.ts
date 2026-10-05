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
    modelProfiles: [
      { id: "pf1", provider: "PA", apiKey: "sk-old-prof", baseUrl: "https://pf.example.com", model: "m1" },
      { id: "pf2", provider: "PB", apiKey: "sk-old-prof2", baseUrl: "https://pf2.example.com", model: "m2" },
    ],
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
    // P2-3①（复审3）：档案 / vision 内存断言隔离 preserve 逻辑（空回显回填旧真值，不被 normalize 清空）
    expect(saved.modelProfiles?.[0].apiKey).toBe("sk-old-prof");
    expect(saved.vision?.apiKey).toBe("sk-old-v");

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

/**
 * PR19 复审3 P1-1 回归：内部调用方原样回显既有真值 ≠ 新密钥写入。
 * 覆盖 settings-ipc.ts:182/188/431（档案删除 / 设默认 / reranker）与
 * :343/348/352（宠物开关 general 全量展开）在 S4 与「迁移后宿主缺失」态的主链行为。
 */
describe("PR19 复审3 P1-1：内部回显不误伤（S4 / 迁移后宿主缺失）", () => {
  async function setupS4() {
    const mods = await loadModules();
    mods.stub.hostUp = true;
    mods.stub.alive = true;
    mods.stub.failImport = true; // 迁移 import 失败 → 未迁移（无 marker）；随后仍 hydrate（S4 来源）
    vault.set("model:provider:PA", "sk-vault-p");
    vault.set("model:profile:pf1", "sk-old-prof");
    vault.set("model:profile:pf2", "sk-old-prof2");
    vault.set("vision", "sk-old-v");
    vault.set("tts:minimax", "sk-tts-vault");
    const r = await mods.keyring.initSecretsVault(MODEL_FILE(), GENERAL_FILE());
    expect(r.hydrated).toBe(true);
    expect(mods.keyring.isVaultMigrated()).toBe(false);
    mods.stub.alive = false; // 宿主猝死 → authoritative 不可写
    return mods;
  }

  it("S4：档案删除 / 设默认 / reranker / 宠物开关（全量回显）均不抛且非 key 字段落盘", async () => {
    const { model, facade, keyring } = await setupS4();

    // 档案更新：掩码空 key + 其它档案真 key 回显（saveModelProfile → model-settings.ts:539 同链）
    const updated = model.saveModelProfile({
      id: "pf1", provider: "PA", baseUrl: "https://pf.example.com", model: "m1-new", apiKey: "",
    });
    const updatedPf1 = updated.settings.modelProfiles?.find((p) => p.id === "pf1");
    expect(updatedPf1?.model).toBe("m1-new");
    expect(updatedPf1?.apiKey).toBe("sk-old-prof"); // 空回显 preserve 回填旧真值，未丢

    // 档案删除：profiles 列表回显其它档案真 key（settings-ipc.ts:182 同链）
    const before = model.loadModelSettings();
    const profiles = model.listSavedModelProfiles(before).filter((p) => p.id !== "pf2");
    const deleted = model.saveModelSettings({
      modelProfiles: profiles,
      defaultModelProfileId: before.defaultModelProfileId === "pf2" ? "pf1" : before.defaultModelProfileId,
    });
    expect(deleted.modelProfiles?.map((p) => p.id)).toEqual(["pf1"]);
    expect(deleted.modelProfiles?.[0].apiKey).toBe("sk-old-prof");

    // 设默认：{...profile} 展开（档案 key 落到顶层镜像，跨槽回显；settings-ipc.ts:188 同链）
    const defaulted = model.setDefaultModelProfile("pf1");
    expect(defaulted.defaultModelProfileId).toBe("pf1");

    // reranker：{...current} 全量展开（settings-ipc.ts:431 同链）
    const reranked = model.saveModelSettings({ ...model.loadModelSettings(), rerankerMode: "none" });
    expect(reranked.rerankerMode).toBe("none");

    // 宠物开关：general 全量展开含 TTS/ASR 真 key（settings-ipc.ts:343/348/352 同链）
    const general = facade.saveGeneralSettings({
      ...facade.loadGeneralSettings(), petAlwaysOnTop: false, petVisible: false, petZoom: 1.5,
    });
    expect(general.petAlwaysOnTop).toBe(false);
    expect(general.petVisible).toBe(false);
    expect(general.petZoom).toBe(1.5);

    // 磁盘：非 key 字段生效；key 槽保持磁盘原值（不写 keyring 真值、不被空串覆盖）
    const modelDisk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect(modelDisk.rerankerMode).toBe("none");
    expect((modelDisk.modelProfiles as unknown as Array<{ id: string; apiKey: string }>).map((p) => p.id)).toEqual(["pf1"]);
    expect((modelDisk.modelProfiles as unknown as Array<{ apiKey: string }>)[0].apiKey).toBe("sk-old-prof");
    expect(modelDisk.apiKey).toBe("sk-old-top");
    expect((modelDisk.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");
    expect((modelDisk.vision as unknown as { apiKey: string }).apiKey).toBe("sk-old-v");
    const generalDisk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as Record<string, unknown>;
    expect(generalDisk.petAlwaysOnTop).toBe(false);
    expect(generalDisk.ttsMinimaxKey).toBe("sk-tts-old");

    // 真正的新 key（与既有值不同）/ SENTINEL：仍硬失败
    for (const bad of ["sk-brand-new", keyring.SECRET_CLEAR_SENTINEL]) {
      expect(() => model.saveModelSettings({ provider: "PA", apiKey: bad })).toThrow(/E_SECRETS_HOST_LOST/);
      expect(() => model.saveModelSettings({ modelProfiles: [{ id: "pf1", apiKey: bad }] })).toThrow(/E_SECRETS_HOST_LOST/);
      expect(() => facade.saveGeneralSettings({ ttsMinimaxKey: bad })).toThrow(/E_SECRETS_HOST_LOST/);
    }
  });

  it("迁移后宿主缺失（盘上 marker、未 hydrate）：同四类回显不抛；新 key / SENTINEL 仍抛", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    const { model, facade, keyring } = await loadModules();
    expect(keyring.isVaultAuthoritative()).toBe(true); // 事实源在 vault（不可写）

    // 档案更新：掩码空 key + 其它档案真 key 回显（saveModelProfile → model-settings.ts:539 同链）
    const updated = model.saveModelProfile({
      id: "pf1", provider: "PA", baseUrl: "https://pf.example.com", model: "m1-new", apiKey: "",
    });
    expect(updated.settings.modelProfiles?.find((p) => p.id === "pf1")?.apiKey).toBe("sk-old-prof");

    const before = model.loadModelSettings();
    const profiles = model.listSavedModelProfiles(before).filter((p) => p.id !== "pf2");
    const deleted = model.saveModelSettings({ modelProfiles: profiles, defaultModelProfileId: "pf1" });
    expect(deleted.modelProfiles?.map((p) => p.id)).toEqual(["pf1"]);
    expect(deleted.modelProfiles?.[0].apiKey).toBe("sk-old-prof"); // 未 hydrate 回退态内存持明文

    const defaulted = model.setDefaultModelProfile("pf1");
    expect(defaulted.defaultModelProfileId).toBe("pf1");

    const reranked = model.saveModelSettings({ ...model.loadModelSettings(), rerankerMode: "none" });
    expect(reranked.rerankerMode).toBe("none");

    const general = facade.saveGeneralSettings({ ...facade.loadGeneralSettings(), petAlwaysOnTop: false });
    expect(general.petAlwaysOnTop).toBe(false);

    const modelDisk = JSON.parse(fs.readFileSync(MODEL_FILE(), "utf8")) as Record<string, never>;
    expect(modelDisk.rerankerMode).toBe("none");
    expect(modelDisk.apiKey).toBe("sk-old-top");
    expect((modelDisk.perProvider as unknown as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-old-p");
    const generalDisk = JSON.parse(fs.readFileSync(GENERAL_FILE(), "utf8")) as Record<string, unknown>;
    expect(generalDisk.petAlwaysOnTop).toBe(false);
    expect(generalDisk.ttsMinimaxKey).toBe("sk-tts-old");

    for (const bad of ["sk-brand-new", keyring.SECRET_CLEAR_SENTINEL]) {
      expect(() => model.saveModelSettings({ provider: "PA", apiKey: bad })).toThrow(/E_SECRETS_HOST_LOST/);
      expect(() => facade.saveGeneralSettings({ ttsMinimaxKey: bad })).toThrow(/E_SECRETS_HOST_LOST/);
    }
  });
});
