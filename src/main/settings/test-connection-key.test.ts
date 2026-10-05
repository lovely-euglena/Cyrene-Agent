/**
 * 复审 P1-6 回归：测试连接真 key 回填（按 profileId/上下文解析 vault 槽）。
 *
 * 覆盖：profileId 精确命中 → provider 槽兜底 → provider+baseUrl+model 档案匹配 →
 * 同 provider 档案槽 → 测试其它 provider 不拿活跃 provider 的 key（凭据不跨端点）。
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
  async ensureStarted() { return true; }
  isAlive() { return true; }
  async status() { return { count: vault.size, migrated: true, migratedAt: "t", protector: "stub", available: true }; }
  async get(name: string) { return vault.get(name) ?? null; }
  async put(name: string, value: string) { vault.set(name, value); }
  async remove(name: string) { return vault.delete(name); }
  async list() { return [...vault.keys()].map((name) => ({ name, createdAt: "t", updatedAt: "t" })); }
  async import(values: Record<string, string>) { for (const [k, v] of Object.entries(values)) vault.set(k, v); return Object.keys(values).length; }
  async markMigrated() { /* stub */ }
}

async function load() {
  const secrets = await import("../dotnet-backend/secrets-client");
  secrets.__setSecretsDataDirForTests(electronMock.userDataDir);
  secrets.__setSecretsHostClientForTests(new StubSecretsClient() as unknown as import("../dotnet-backend/secrets-client").SecretsHostClient);
  const model = await import("./model-settings");
  const keyring = await import("./secrets-keyring");
  await keyring.hydrateKeyring();
  return model;
}

/** 明文回退态：宿主缺失、迁移未发生、keyring 未 hydrate（PR19 P1-2）。 */
async function loadWithoutHydrate() {
  const secrets = await import("../dotnet-backend/secrets-client");
  secrets.__setSecretsDataDirForTests(electronMock.userDataDir);
  secrets.__setSecretsHostClientForTests(new StubSecretsClient() as unknown as import("../dotnet-backend/secrets-client").SecretsHostClient);
  return await import("./model-settings");
}

function writeModelFile(): void {
  fs.writeFileSync(path.join(electronMock.userDataDir, "model-settings.json"), JSON.stringify({
    schemaVersion: 99,
    provider: "PA",
    apiKey: "sk-pa-provider",
    perProvider: {
      PA: { apiKey: "sk-pa-provider", baseUrl: "https://pa.example.com", model: "m-a" },
      PB: { apiKey: "", baseUrl: "https://pb.example.com", model: "m-b" },
    },
    modelProfiles: [
      { id: "pf-a", provider: "PA", apiKey: "sk-pa-profile", baseUrl: "https://pa.example.com", model: "m-a" },
      { id: "pf-b", provider: "PB", apiKey: "sk-pb-profile", baseUrl: "https://pb.example.com", model: "m-b" },
    ],
  }, null, 2));
}

beforeEach(() => {
  vi.resetModules();
  electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-testconn-"));
  process.env.CYRENE_SECRETS_HOST = "1";
  vault.clear();
  vault.set("model:profile:pf-a", "sk-pa-profile");
  vault.set("model:profile:pf-b", "sk-pb-profile");
  vault.set("model:provider:PB", "sk-pb-provider");
  writeModelFile();
});

afterEach(() => {
  delete process.env.CYRENE_SECRETS_HOST;
  fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
});

describe("resolveTestConnectionApiKey（复审 P1-6）", () => {
  it("profileId 精确命中 → 档案槽真 key（顶层镜像为空也能解析）", async () => {
    const model = await load();
    expect(model.resolveTestConnectionApiKey({
      provider: "PB", profileId: "pf-b", baseUrl: "https://pb.example.com", model: "m-b", apiKey: "",
    })).toBe("sk-pb-profile");
  });

  it("profileId 档案槽 keyring 缺失 → 回退内存/盘上明文档案槽（PR19 P1-2）", async () => {
    const model = await load();
    const keyring = await import("./secrets-keyring");
    keyring.deleteSecret("model:profile:pf-b"); // keyring 与 vault 同步移除；内存/盘上明文仍在
    expect(model.resolveTestConnectionApiKey({
      provider: "PB", profileId: "pf-b", baseUrl: "https://pb.example.com", model: "m-b", apiKey: "",
    })).toBe("sk-pb-profile");
  });

  it("profileId 档案槽 keyring+明文均缺失 → 该档案 provider 槽兜底", async () => {
    const model = await load();
    const keyring = await import("./secrets-keyring");
    keyring.deleteSecret("model:profile:pf-b");
    const settings = model.loadModelSettings();
    const profile = settings.modelProfiles?.find((item) => item.id === "pf-b");
    if (profile) profile.apiKey = ""; // 模拟档案明文槽也为空
    expect(model.resolveTestConnectionApiKey({
      provider: "PB", profileId: "pf-b", baseUrl: "https://pb.example.com", model: "m-b", apiKey: "",
    })).toBe("sk-pb-provider");
  });

  it("无 profileId：provider+baseUrl+model 匹配档案 → 档案槽", async () => {
    const model = await load();
    expect(model.resolveTestConnectionApiKey({
      provider: "PA", baseUrl: "https://pa.example.com", model: "m-a", apiKey: "",
    })).toBe("sk-pa-profile");
  });

  it("测试其它 provider（无档案无槽）不拿活跃 provider 的 key（凭据不跨端点）", async () => {
    const model = await load();
    expect(model.resolveTestConnectionApiKey({
      provider: "PC", baseUrl: "https://pc.example.com", model: "m-c", apiKey: "",
    })).toBe("");
  });

  it("P2-8：sameProvider 兜底直测——无 profileId、无精确匹配 → 同 provider 档案槽", async () => {
    const model = await load();
    expect(model.resolveTestConnectionApiKey({
      provider: "PA", baseUrl: "https://not-exact.example.com", model: "m-x", apiKey: "",
    })).toBe("sk-pa-profile");
  });

  it("P1-2 明文回退态（未 hydrate）：keyring 解析不到 → 回退内存/盘上明文槽，不跨端点", async () => {
    // 覆盖 beforeEach 的默认文件：PD 只有 provider 明文槽、没有档案
    fs.writeFileSync(path.join(electronMock.userDataDir, "model-settings.json"), JSON.stringify({
      schemaVersion: 99,
      provider: "PD",
      apiKey: "sk-pd-top",
      perProvider: { PD: { apiKey: "sk-pd-provider", baseUrl: "https://pd.example.com", model: "m-pd" } },
      modelProfiles: [],
    }, null, 2));
    const model = await loadWithoutHydrate();
    // provider 明文槽兜底（顶层镜像经 normalize 折叠进 perProvider）
    expect(model.resolveTestConnectionApiKey({
      provider: "PD", baseUrl: "https://pd.example.com", model: "m-pd", apiKey: "",
    })).toBe("sk-pd-provider");
    // 不跨端点：无关 provider 不拿活跃 provider 的明文 key
    expect(model.resolveTestConnectionApiKey({ provider: "PE", apiKey: "" })).toBe("");
  });

  it("P1-2：vision 掩码空 key → keyring vision 槽回填（WPF/Electron 同口径）", async () => {
    const model = await load();
    const keyring = await import("./secrets-keyring");
    keyring.setSecret("vision", "sk-vision"); // keyring + vault 同步
    expect(model.resolveVisionTestApiKey("")).toBe("sk-vision");
    expect(model.resolveVisionTestApiKey("   ")).toBe("sk-vision");
    expect(model.resolveVisionTestApiKey("sk-typed")).toBe("sk-typed"); // 非空入参原样
  });

  it("非空入参原样返回；vault 关闭时不做回填", async () => {
    const model = await load();
    expect(model.resolveTestConnectionApiKey({
      provider: "PA", profileId: "pf-a", apiKey: "sk-typed",
    })).toBe("sk-typed");

    delete process.env.CYRENE_SECRETS_HOST;
    vi.resetModules();
    const secrets = await import("../dotnet-backend/secrets-client");
    secrets.__setSecretsDataDirForTests(electronMock.userDataDir);
    secrets.__setSecretsHostClientForTests(new StubSecretsClient() as unknown as import("../dotnet-backend/secrets-client").SecretsHostClient);
    const model2 = await import("./model-settings");
    expect(model2.resolveTestConnectionApiKey({ provider: "PA", profileId: "pf-a", apiKey: "" })).toBe("");
  });
});
