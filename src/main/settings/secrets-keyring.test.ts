/**
 * secrets-keyring 纯函数测试（A2/A3/A4 语义）。
 *
 * 覆盖：vaultify（空=不改 / SENTINEL=清 / 新值入 vault）、stripKeysForDisk 清痕、
 * maskForUi 掩码 + hasKey、applyKeyring 回填、collectPlaintextKeys + 迁移清痕幂等。
 * 环境开关 CYRENE_SECRETS_HOST=1 进入 vault 模式；宿主客户端注入内存桩。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hydrateKeyring,
  initSecretsVault,
  isVaultMigrated,
  onKeyringHydrated,
  SECRET_CLEAR_SENTINEL,
  SECRET_GENERAL_FIELDS,
  VAULT_KEY_VISION,
  applyKeyringToGeneralSettings,
  applyKeyringToModelSettings,
  collectPlaintextKeys,
  maskGeneralSettingsForUi,
  maskModelSettingsForUi,
  migratePlaintextKeys,
  setSecret,
  stripKeysForDisk,
  vaultifyGeneralSettingsForSave,
  vaultifyModelSettingsForSave,
  __resetKeyringForTests,
} from "./secrets-keyring";
import {
  __setSecretsDataDirForTests,
  __setSecretsHostClientForTests,
  type SecretsHostClient,
} from "../dotnet-backend/secrets-client";

const vault = new Map<string, string>();

class StubSecretsClient {
  hostUp = true;
  alive = true;
  async ensureStarted() { return this.hostUp; }
  isAlive() { return this.alive; }
  async status() { return { count: vault.size, migrated: true, migratedAt: "2026-10-04T00:00:00Z", protector: "stub", available: true }; }
  async get(name: string) { return vault.get(name) ?? null; }
  async put(name: string, value: string) { vault.set(name, value); }
  async remove(name: string) { return vault.delete(name); }
  async list() {
    return [...vault.keys()].map((name) => ({ name, createdAt: "t", updatedAt: "t" }));
  }
  async import(values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) vault.set(k, v);
    return Object.keys(values).length;
  }
  async markMigrated() { /* stub */ }
}

const ENV_KEYS = ["CYRENE_SECRETS_HOST"] as const;

const stub = new StubSecretsClient();

beforeAll(() => {
  for (const k of ENV_KEYS) process.env[k] = "1";
  __setSecretsHostClientForTests(stub as unknown as SecretsHostClient);
});

afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __setSecretsHostClientForTests(null);
  __setSecretsDataDirForTests(null);
  __resetKeyringForTests();
});

function reset(): void {
  vault.clear();
  __resetKeyringForTests();
  stub.hostUp = true;
  stub.alive = true;
}

describe("vaultifyModelSettingsForSave（空=不改 / SENTINEL=清 / 新值入 vault）", () => {
  it("非空新值 → 入 vault 并保留原字段（最终由 stripKeysForDisk 清盘）", async () => {
    reset();
    await hydrateKeyring(); // isVaultActive 门控：hydrated 才走 vault 路径
    const incoming: Record<string, unknown> = { provider: "MiniMax（稀宇科技）", apiKey: "  sk-new-1  " };
    vaultifyModelSettingsForSave(incoming);
    expect(vault.get("model:provider:MiniMax（稀宇科技）")).toBe("sk-new-1");
    expect(incoming.apiKey).toBe("  sk-new-1  "); // 原样保留，内存缓存持真值
  });

  it("空串 → 摘除字段（=不改，掩码回传不丢 key）", async () => {
    reset();
    await hydrateKeyring();
    setSecret("model:provider:P1", "sk-old");
    const incoming: Record<string, unknown> = { provider: "P1", apiKey: "" };
    vaultifyModelSettingsForSave(incoming);
    expect("apiKey" in incoming).toBe(false);
    expect(vault.get("model:provider:P1")).toBe("sk-old");
  });

  it("SENTINEL → 删 vault key + 字段置空（显式清除）", async () => {
    reset();
    await hydrateKeyring();
    setSecret("model:provider:P1", "sk-old");
    const incoming: Record<string, unknown> = { provider: "P1", apiKey: SECRET_CLEAR_SENTINEL };
    vaultifyModelSettingsForSave(incoming);
    expect(vault.has("model:provider:P1")).toBe(false);
    expect(incoming.apiKey).toBe("");
  });

  it("perProvider / profiles / vision 各槽位同语义", async () => {
    reset();
    await hydrateKeyring();
    const incoming: Record<string, unknown> = {
      perProvider: { PV: { apiKey: "sk-pv" } },
      modelProfiles: [{ id: "prof1", apiKey: "" }],
      vision: { apiKey: SECRET_CLEAR_SENTINEL },
    };
    vaultifyModelSettingsForSave(incoming);
    expect(vault.get("model:provider:PV")).toBe("sk-pv");
    expect("apiKey" in (incoming.modelProfiles as Array<Record<string, unknown>>)[0]).toBe(false);
    expect((incoming.vision as Record<string, unknown>).apiKey).toBe("");
    expect(vault.has(VAULT_KEY_VISION)).toBe(false);
  });
});

describe("stripKeysForDisk（A2 清痕）", () => {
  it("四类槽位全部置空，其余字段不受影响", () => {
    const settings = {
      provider: "P",
      apiKey: "sk-top",
      perProvider: { P: { apiKey: "sk-p", model: "m" } },
      modelProfiles: [{ id: "1", apiKey: "sk-prof" }],
      vision: { apiKey: "sk-v", baseUrl: "u", model: "vm" },
      temperature: 0.7,
    };
    const disk = stripKeysForDisk(settings);
    expect(disk.apiKey).toBe("");
    expect((disk.perProvider as Record<string, Record<string, unknown>>).P.apiKey).toBe("");
    expect((disk.perProvider as Record<string, Record<string, unknown>>).P.model).toBe("m");
    expect((disk.modelProfiles as Array<Record<string, unknown>>)[0].apiKey).toBe("");
    expect((disk.vision as Record<string, unknown>).apiKey).toBe("");
    expect((disk.vision as Record<string, unknown>).baseUrl).toBe("u");
    expect(disk.temperature).toBe(0.7);
    // 原对象不受影响（内存持真值）
    expect(settings.apiKey).toBe("sk-top");
  });
});

describe("maskModelSettingsForUi / maskGeneralSettingsForUi（A3）", () => {
  it("model：vault 激活时 key → '' + hasApiKey", async () => {
    reset();
    await hydrateKeyring(); // 复审 P0：掩码门控 = isVaultActive（须已 hydrate）
    const masked = maskModelSettingsForUi({
      apiKey: "sk-x",
      perProvider: { P: { apiKey: "sk-y" } },
      vision: { apiKey: "sk-z" },
    });
    expect(masked.apiKey).toBe("");
    expect(masked.hasApiKey).toBe(true);
    expect((masked.perProvider as Record<string, Record<string, unknown>>).P.apiKey).toBe("");
    expect((masked.perProvider as Record<string, Record<string, unknown>>).P.hasApiKey).toBe(true);
    expect((masked.vision as Record<string, unknown>).apiKey).toBe("");
  });

  it("空 key → hasApiKey=false", async () => {
    reset();
    await hydrateKeyring();
    const masked = maskModelSettingsForUi({ apiKey: "" });
    expect(masked.apiKey).toBe("");
    expect(masked.hasApiKey).toBe(false);
  });

  it("复审 P0：宿主缺失（未 hydrate）不掩码——渲染端持明文，回传不会清盘", () => {
    reset(); // 未 hydrate = vault 未激活（宿主缺失/迁移未发生）
    const settings = { apiKey: "sk-plain", perProvider: { P: { apiKey: "sk-p" } } };
    const masked = maskModelSettingsForUi(settings);
    expect(masked).toBe(settings); // 原样返回（同一引用）
    expect(masked.apiKey).toBe("sk-plain");
  });

  it("general：vault 激活时 TTS/ASR 字段掩码 + has<Field>", async () => {
    reset();
    await hydrateKeyring();
    const masked = maskGeneralSettingsForUi({ ttsMinimaxKey: "sk-t", asrMinimaxKey: "" });
    expect(masked.ttsMinimaxKey).toBe("");
    expect((masked as Record<string, unknown>).hasTtsMinimaxKey).toBe(true);
    expect((masked as Record<string, unknown>).hasAsrMinimaxKey).toBe(false);
    expect(SECRET_GENERAL_FIELDS.length).toBeGreaterThanOrEqual(6);
  });

  it("复审 P0：宿主缺失时 general 不掩码", () => {
    reset();
    const settings = { ttsMinimaxKey: "sk-plain" };
    expect(maskGeneralSettingsForUi(settings).ttsMinimaxKey).toBe("sk-plain");
  });
});

describe("applyKeyring（hydrate 后回填）", () => {
  it("model / general 加载路径从 keyring 回填真值", async () => {
    reset();
    vault.set("model:provider:PA", "sk-a");
    vault.set("model:profile:pf1", "sk-pf");
    vault.set(VAULT_KEY_VISION, "sk-v");
    vault.set("tts:mimo", "sk-tts");
    // 模拟 hydrateKeyring（真实路径：list → get → 灌 keyring → hydrated=true）
    await hydrateKeyring();

    const modelSettings = {
      provider: "PA",
      perProvider: { PA: { apiKey: "" } },
      modelProfiles: [{ id: "pf1", apiKey: "" }],
      vision: { apiKey: "" },
    };
    applyKeyringToModelSettings(modelSettings as never);
    expect((modelSettings.perProvider as Record<string, { apiKey: string }>).PA.apiKey).toBe("sk-a");
    expect((modelSettings.modelProfiles as Array<{ apiKey: string }>)[0].apiKey).toBe("sk-pf");
    expect((modelSettings.vision as { apiKey: string }).apiKey).toBe("sk-v");

    const generalSettings: Record<string, unknown> = { ttsMimoKey: "" };
    applyKeyringToGeneralSettings(generalSettings);
    expect(generalSettings.ttsMimoKey).toBe("sk-tts");
  });
});

describe("复审 P0-8 / P0-6（host 缺失保存回退 + 冷启动回填）", () => {
  it("host 缺失（未 hydrate）保存 → 整体回退明文语义：不清盘、不丢 key", () => {
    reset(); // 不 hydrate → isVaultActive=false（宿主缺失/迁移未发生）
    const incoming: Record<string, unknown> = { provider: "PA", apiKey: "sk-keep-me" };
    vaultifyModelSettingsForSave(incoming); // no-op（门控）
    expect(incoming.apiKey).toBe("sk-keep-me"); // 用户输入原样保留
    const final = { provider: "PA", apiKey: "sk-keep-me", perProvider: { PA: { apiKey: "sk-keep-me" } } };
    const disk = stripKeysForDisk(final); // 未激活 → 原样返回（不清痕）
    expect((disk as { apiKey: string }).apiKey).toBe("sk-keep-me"); // 磁盘不丢 key
  });

  it("onKeyringHydrated：先建缓存场景（pre-ready），hydrate 完成触发回调（冷启动回填依据）", async () => {
    reset();
    let fired = false;
    onKeyringHydrated(() => { fired = true; });
    vault.set("tts:mimo", "sk-cold");
    await hydrateKeyring();
    expect(fired).toBe(true); // index.ts 据此调 refreshGeneral/ModelSettingsFromKeyring
    const cached: Record<string, unknown> = { ttsMimoKey: "" }; // 模拟 pre-ready 已建的空缓存
    applyKeyringToGeneralSettings(cached);
    expect(cached.ttsMimoKey).toBe("sk-cold");
  });
});

describe("IKJNX1 #1：迁移后宿主缺失 → 保存硬失败（E_SECRETS_HOST_LOST，设计 §4.5/§8 用例 5）", () => {
  it("启动即迁移后（盘上 migratedAt 标记）+ 宿主缺失：vaultify/strip 均抛错，不动传入对象、不写 vault", async () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-marker-"));
    __setSecretsDataDirForTests(dir);
    writeFileSync(
      path.join(dir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    stub.hostUp = false;
    stub.alive = false;
    try {
      const r = await initSecretsVault(path.join(dir, "model-settings.json"), path.join(dir, "general-settings.json"));
      expect(r.hostUp).toBe(false);
      expect(r.hydrated).toBe(false);
      expect(isVaultMigrated()).toBe(true); // 宿主缺失但盘上标记命中

      const incoming: Record<string, unknown> = { provider: "PA", apiKey: "sk-new" };
      expect(() => vaultifyModelSettingsForSave(incoming)).toThrow(/E_SECRETS_HOST_LOST/);
      expect(incoming.apiKey).toBe("sk-new"); // 不丢输入

      const general: Record<string, unknown> = { ttsMimoKey: "sk-tts" };
      expect(() => vaultifyGeneralSettingsForSave(general)).toThrow(/E_SECRETS_HOST_LOST/);
      expect(general.ttsMimoKey).toBe("sk-tts");

      const final = { provider: "PA", apiKey: "sk-new" };
      expect(() => stripKeysForDisk(final)).toThrow(/E_SECRETS_HOST_LOST/); // 纵深防御：不清盘
      expect(final.apiKey).toBe("sk-new");
      expect(vault.size).toBe(0); // 未写明文也未写 vault
    } finally {
      __setSecretsDataDirForTests(null);
      reset();
    }
  });

  it("会话内宿主死亡（已 hydrate）：vaultify/strip 抛错；宿主恢复后回 vault 路径", async () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-alive-"));
    try {
      const r = await initSecretsVault(path.join(dir, "model-settings.json"), path.join(dir, "general-settings.json"));
      expect(r.hostUp).toBe(true);
      expect(isVaultMigrated()).toBe(true);

      stub.alive = false; // 会话内进程死亡
      const incoming: Record<string, unknown> = { provider: "PA", apiKey: "sk-new" };
      expect(() => vaultifyModelSettingsForSave(incoming)).toThrow(/E_SECRETS_HOST_LOST/);
      expect(incoming.apiKey).toBe("sk-new");
      expect(() => stripKeysForDisk({ apiKey: "sk-new" })).toThrow(/E_SECRETS_HOST_LOST/);

      stub.alive = true; // 恢复后正常走 vault
      vaultifyModelSettingsForSave(incoming);
      expect(vault.get("model:provider:PA")).toBe("sk-new");
    } finally {
      reset();
    }
  });

  it("内存态未迁移但盘上 marker 在（status 曾失败场景）：宿主死亡仍硬失败", () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-marker2-"));
    __setSecretsDataDirForTests(dir);
    writeFileSync(
      path.join(dir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    stub.hostUp = false;
    stub.alive = false;
    try {
      expect(isVaultMigrated()).toBe(false); // 未经 init，内存态未标记
      const incoming: Record<string, unknown> = { provider: "PA", apiKey: "sk-new" };
      expect(() => vaultifyModelSettingsForSave(incoming)).toThrow(/E_SECRETS_HOST_LOST/);
      expect(incoming.apiKey).toBe("sk-new");
      expect(() => stripKeysForDisk({ apiKey: "sk-new" })).toThrow(/E_SECRETS_HOST_LOST/);
    } finally {
      __setSecretsDataDirForTests(null);
      reset();
    }
  });

  it("marker 读取：文件缺失 / 坏 JSON → 按未迁移（回退明文，不抛）", async () => {
    for (const raw of [null, "{ not json"]) {
      reset();
      const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-nomarker-"));
      __setSecretsDataDirForTests(dir);
      if (raw !== null) writeFileSync(path.join(dir, "secrets-vault.json"), raw);
      stub.hostUp = false;
      try {
        await initSecretsVault(path.join(dir, "model-settings.json"), path.join(dir, "general-settings.json"));
        expect(isVaultMigrated()).toBe(false);
        const incoming: Record<string, unknown> = { provider: "PA", apiKey: "sk-keep" };
        expect(() => vaultifyModelSettingsForSave(incoming)).not.toThrow();
        expect(incoming.apiKey).toBe("sk-keep");
      } finally {
        __setSecretsDataDirForTests(null);
        reset();
      }
    }
  });
});

describe("collectPlaintextKeys + migratePlaintextKeys（A4：import→校验→.bak→清空）", () => {
  it("收集→导入→源清空→.bak 存在→grep 无明文→幂等", async () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-test-"));
    const modelPath = path.join(dir, "model-settings.json");
    const generalPath = path.join(dir, "general-settings.json");
    writeFileSync(modelPath, JSON.stringify({
      provider: "PA",
      apiKey: "sk-mirror",
      perProvider: { PA: { apiKey: "sk-real" } },
      modelProfiles: [{ id: "pf1", apiKey: "sk-prof" }],
      vision: { apiKey: "sk-vis" },
    }));
    writeFileSync(generalPath, JSON.stringify({ ttsMinimaxKey: "sk-tts", asrMinimaxKey: "sk-asr" }));

    const hits = collectPlaintextKeys(
      JSON.parse(readFileSync(modelPath, "utf8")) as Record<string, unknown>,
      JSON.parse(readFileSync(generalPath, "utf8")) as Record<string, unknown>,
    );
    expect(hits.length).toBeGreaterThanOrEqual(5);

    const migrated = await migratePlaintextKeys(modelPath, generalPath);
    expect(migrated).toBeGreaterThanOrEqual(5);
    expect(existsSync(`${modelPath}.pre-secrets.bak`)).toBe(true);
    expect(existsSync(`${generalPath}.pre-secrets.bak`)).toBe(true);

    const modelRaw = readFileSync(modelPath, "utf8");
    const generalRaw = readFileSync(generalPath, "utf8");
    for (const secret of ["sk-real", "sk-prof", "sk-vis", "sk-tts", "sk-asr"]) {
      expect(modelRaw.includes(secret) || generalRaw.includes(secret), `明文残留: ${secret}`).toBe(false);
    }

    // 幂等：二次迁移 0 条
    expect(await migratePlaintextKeys(modelPath, generalPath)).toBe(0);
  });
});
