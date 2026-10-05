/**
 * secrets-keyring 纯函数测试（A2/A3/A4 语义）。
 *
 * 覆盖：vaultify（空=不改 / SENTINEL=清 / 新值入 vault）、stripKeysForDisk 清痕、
 * maskForUi 掩码 + hasKey、applyKeyring 回填、collectPlaintextKeys + 迁移清痕幂等。
 * 环境开关 CYRENE_SECRETS_HOST=1 进入 vault 模式；宿主客户端注入内存桩。
 */
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  hydrateKeyring,
  initSecretsVault,
  isVaultAuthoritative,
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
  available = true;
  async ensureStarted() { return this.hostUp; }
  isAlive() { return this.alive; }
  async status() { return { count: vault.size, migrated: true, migratedAt: "2026-10-04T00:00:00Z", protector: "stub", available: this.available }; }
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
  stub.available = true;
}

describe("vaultifyModelSettingsForSave（空=不改 / SENTINEL=清 / 新值入 vault）", () => {
  it("非空新值 → 入 vault 并保留原字段（最终由 stripKeysForDisk 清盘）", async () => {
    reset();
    await hydrateKeyring(); // isVaultWritable 门控：hydrated + 宿主存活才走 vault 路径
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
    await hydrateKeyring(); // 复审 P0 + PR19 P1-1：掩码门控 = isVaultAuthoritative（hydrated 即事实源在 vault）
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
    reset(); // 不 hydrate → 非 authoritative（宿主缺失/迁移未发生）
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

  it("P2-2⑦：单个 hydrate 回调抛错不阻断其余回调（回填链独立）", async () => {
    reset();
    const fired: string[] = [];
    onKeyringHydrated(() => { fired.push("a"); throw new Error("boom"); });
    onKeyringHydrated(() => { fired.push("b"); });
    vault.set("tts:mimo", "sk-cold");
    await hydrateKeyring();
    expect(fired).toEqual(["a", "b"]);
  });

  it("P2-2⑦：保护器不可用（status.available=false）→ 不迁移、不 hydrate（保存维持明文回退）", async () => {
    reset();
    stub.available = false;
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-noprotector-"));
    const modelPath = path.join(dir, "model-settings.json");
    writeFileSync(modelPath, JSON.stringify({ provider: "PA", perProvider: { PA: { apiKey: "sk-plain" } } }));
    try {
      const r = await initSecretsVault(modelPath, path.join(dir, "general-settings.json"));
      expect(r.hostUp).toBe(true);
      expect(r.hydrated).toBe(false); // 不 hydrate：掩码不激活，UI 持明文
      expect(vault.size).toBe(0);     // 未尝试迁移（put 必失败）
      const raw = readFileSync(modelPath, "utf8");
      expect(raw.includes("sk-plain")).toBe(true); // 源明文未被清痕
    } finally {
      reset();
    }
  });
});

describe("IKJNX1 #1 + PR19 P1-1：宿主缺失保存门控（含 key 硬失败 / 非 key 不连坐 / strip 磁盘对齐）", () => {
  it("启动即迁移后（盘上 migratedAt 标记）+ 宿主缺失：含 key 的 vaultify 抛错；strip 不抛且不泄漏", async () => {
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

      // PR19 P2-6：非 key patch 不连坐
      expect(() => vaultifyModelSettingsForSave({ provider: "PA", model: "m" })).not.toThrow();
      expect(() => vaultifyGeneralSettingsForSave({ petWindowX: 1 })).not.toThrow();

      // PR19 P1-1：strip 不再抛——authoritative 不可写 → key 槽取磁盘原值（无路径 = 磁盘无值 → ""）
      const final = { provider: "PA", apiKey: "sk-new" };
      const disk = stripKeysForDisk(final);
      expect((disk as { apiKey: string }).apiKey).toBe("");
      expect(final.apiKey).toBe("sk-new"); // 原对象不动
      expect(vault.size).toBe(0); // 未写明文也未写 vault
    } finally {
      __setSecretsDataDirForTests(null);
      reset();
    }
  });

  it("会话内宿主死亡（已 hydrate）：含 key 抛错、非 key 不抛；宿主恢复后回 vault 路径", async () => {
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
      // PR19 P2-6：非 key patch 不连坐
      expect(() => vaultifyModelSettingsForSave({ provider: "PA", model: "m" })).not.toThrow();
      // PR19 P1-1：strip 三分支——不可写时返回磁盘原值副本（无路径 = ""），不抛
      const disk = stripKeysForDisk({ apiKey: "sk-new" });
      expect((disk as { apiKey: string }).apiKey).toBe("");

      stub.alive = true; // 恢复后正常走 vault
      vaultifyModelSettingsForSave(incoming);
      expect(vault.get("model:provider:PA")).toBe("sk-new");
    } finally {
      reset();
    }
  });

  it("内存态未迁移但盘上 marker 在（status 曾失败场景）：含 key 硬失败、非 key 不连坐", () => {
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
      expect(() => vaultifyModelSettingsForSave({ provider: "PA", model: "m" })).not.toThrow();
      expect((stripKeysForDisk({ apiKey: "sk-new" }) as { apiKey: string }).apiKey).toBe("");
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

describe("PR19 P1-1：hydrate 后宿主猝死 + 未迁移（无 marker）", () => {
  it("掩码仍按 vaultAuthoritative；非 key vaultify 不抛，含 key/SENTINEL 抛 E_SECRETS_HOST_LOST", async () => {
    reset();
    await hydrateKeyring(); // 宿主曾活 → hydrated；无 marker、未迁移
    stub.alive = false;     // 宿主猝死（S4）
    expect(isVaultMigrated()).toBe(false);
    expect(isVaultAuthoritative()).toBe(true);
    // 掩码与保存同判据：事实源在 vault（keyring 内存真值）→ 继续掩码
    const masked = maskModelSettingsForUi({ apiKey: "sk-x", vision: { apiKey: "sk-v" } });
    expect(masked.apiKey).toBe("");
    expect((masked.vision as Record<string, unknown>).apiKey).toBe("");
    // P2-6：非 key patch 不连坐
    expect(() => vaultifyModelSettingsForSave({ provider: "PA", model: "m" })).not.toThrow();
    expect(() => vaultifyGeneralSettingsForSave({ petWindowX: 1 })).not.toThrow();
    // 含非空 key / SENTINEL：硬失败（不清盘、不写明文）
    for (const key of ["sk-new", SECRET_CLEAR_SENTINEL]) {
      expect(() => vaultifyModelSettingsForSave({ provider: "PA", apiKey: key })).toThrow(/E_SECRETS_HOST_LOST/);
      expect(() => vaultifyModelSettingsForSave({ vision: { apiKey: key } })).toThrow(/E_SECRETS_HOST_LOST/);
      expect(() => vaultifyGeneralSettingsForSave({ ttsMinimaxKey: key })).toThrow(/E_SECRETS_HOST_LOST/);
    }
  });

  it("已迁移（盘上 marker）+ 未 hydrate：仍掩码——事实源在 vault，UI 不回明文", () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-mask-marker-"));
    __setSecretsDataDirForTests(dir);
    writeFileSync(
      path.join(dir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    try {
      expect(isVaultAuthoritative()).toBe(true);
      expect(maskModelSettingsForUi({ apiKey: "sk-x" }).apiKey).toBe("");
      expect(maskGeneralSettingsForUi({ ttsMinimaxKey: "sk-t" }).ttsMinimaxKey).toBe("");
    } finally {
      __setSecretsDataDirForTests(null);
      reset();
    }
  });

  it("stripKeysForDisk：key 槽逐槽取磁盘原值（不取内存/keyring、不空串覆盖）", async () => {
    reset();
    await hydrateKeyring();
    stub.alive = false;
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-diskkeys-"));
    try {
      const modelPath = path.join(dir, "model-settings.json");
      writeFileSync(modelPath, JSON.stringify({
        provider: "PA",
        apiKey: "sk-disk-top",
        perProvider: { PA: { apiKey: "sk-disk-p" }, PB: { apiKey: "sk-disk-pb" } },
        modelProfiles: [{ id: "pf1", apiKey: "sk-disk-prof" }],
        vision: { baseUrl: "u", apiKey: "sk-disk-v", model: "vm" },
      }));
      const memory = {
        provider: "PA",
        apiKey: "sk-mem-top",
        perProvider: { PA: { apiKey: "sk-mem-p" } },
        modelProfiles: [{ id: "pf1", apiKey: "sk-mem-prof" }, { id: "pf2", apiKey: "sk-mem-2" }],
        vision: { apiKey: "sk-mem-v" },
      };
      const disk = stripKeysForDisk(memory, modelPath);
      expect(disk.apiKey).toBe("sk-disk-top");
      expect(disk.perProvider.PA.apiKey).toBe("sk-disk-p");
      expect((disk.perProvider as Record<string, { apiKey: string }>).PB.apiKey).toBe("sk-disk-pb"); // 磁盘独有槽补回
      expect(disk.modelProfiles[0].apiKey).toBe("sk-disk-prof");
      expect(disk.modelProfiles[1].apiKey).toBe(""); // 磁盘无该档案 → ""
      expect(disk.vision?.apiKey).toBe("sk-disk-v");
      // 原对象不动（内存持真值）
      expect(memory.apiKey).toBe("sk-mem-top");
      expect(memory.perProvider.PA.apiKey).toBe("sk-mem-p");

      const generalPath = path.join(dir, "app-settings.json");
      writeFileSync(generalPath, JSON.stringify({ ttsMinimaxKey: "sk-disk-tts" }));
      const general = stripKeysForDisk({ ttsMinimaxKey: "sk-mem-tts", asrMinimaxKey: "sk-mem-asr" }, generalPath);
      expect(general.ttsMinimaxKey).toBe("sk-disk-tts");
      expect(general.asrMinimaxKey).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      reset();
    }
  });
});

describe("PR19 P2-7：.pre-secrets.bak 权限 0600", () => {
  function withLinuxPlatform(fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    return fn().finally(() => {
      if (original) Object.defineProperty(process, "platform", original);
    });
  }

  it("Linux 迁移：对 model/general 的 .pre-secrets.bak 都 chmod 0600", async () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-mode-"));
    const modelPath = path.join(dir, "model-settings.json");
    const generalPath = path.join(dir, "general-settings.json");
    writeFileSync(modelPath, JSON.stringify({ provider: "PA", perProvider: { PA: { apiKey: "sk-mode" } } }));
    writeFileSync(generalPath, JSON.stringify({ ttsMinimaxKey: "sk-tts-mode" }));
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => { /* no-op */ });
    try {
      await withLinuxPlatform(async () => {
        await migratePlaintextKeys(modelPath, generalPath);
      });
      expect(chmodSpy).toHaveBeenCalledWith(`${modelPath}.pre-secrets.bak`, 0o600);
      expect(chmodSpy).toHaveBeenCalledWith(`${generalPath}.pre-secrets.bak`, 0o600);
      expect(existsSync(`${modelPath}.pre-secrets.bak`)).toBe(true);
    } finally {
      chmodSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      reset();
    }
  });

  it("chmod 失败：console.warn 告警但不阻断迁移", async () => {
    reset();
    const dir = mkdtempSync(path.join(tmpdir(), "cyrene-secrets-mode-warn-"));
    const modelPath = path.join(dir, "model-settings.json");
    writeFileSync(modelPath, JSON.stringify({ provider: "PA", perProvider: { PA: { apiKey: "sk-mode-warn" } } }));
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => { throw new Error("EACCES"); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* no-op */ });
    try {
      const migrated = await withLinuxPlatform(async () => migratePlaintextKeys(modelPath, path.join(dir, "general-settings.json")));
      expect(migrated).toBeGreaterThan(0);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("收紧文件权限失败"))).toBe(true);
      expect(existsSync(`${modelPath}.pre-secrets.bak`)).toBe(true);
    } finally {
      chmodSpy.mockRestore();
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      reset();
    }
  });
});

describe("collectPlaintextKeys 边界（复审 P2-4③④）", () => {
  it("perProvider[provider] 存在但 apiKey 为空 → 顶层 apiKey 仍入库（不被清痕丢失）", () => {
    const hits = collectPlaintextKeys({
      provider: "PA",
      apiKey: "sk-top-only",
      perProvider: { PA: { apiKey: "", model: "m" } },
    }, null);
    expect(hits.some((h) => h.vaultKey === "model:provider:PA" && h.value === "sk-top-only")).toBe(true);
  });

  it("perProvider[provider] 有非空 key → 顶层镜像不重复入库", () => {
    const hits = collectPlaintextKeys({
      provider: "PA",
      apiKey: "sk-mirror",
      perProvider: { PA: { apiKey: "sk-real" } },
    }, null);
    const pa = hits.filter((h) => h.vaultKey === "model:provider:PA");
    expect(pa).toHaveLength(1);
    expect(pa[0].value).toBe("sk-real");
  });

  it("PROVIDER_RENAMES 同步建槽（旧名 key 以新名入 vault，normalize 后可见）", () => {
    const hits = collectPlaintextKeys({
      provider: "DeepSeek",
      apiKey: "",
      perProvider: { "DeepSeek": { apiKey: "sk-ds" }, "MiniMax": { apiKey: "sk-mm" } },
    }, null);
    expect(hits.some((h) => h.vaultKey === "model:provider:DeepSeek（深度求索）" && h.value === "sk-ds")).toBe(true);
    expect(hits.some((h) => h.vaultKey === "model:provider:MiniMax（稀宇科技）" && h.value === "sk-mm")).toBe(true);
    expect(hits.some((h) => h.vaultKey.includes("DeepSeek") && !h.vaultKey.includes("深度求索"))).toBe(false);
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
