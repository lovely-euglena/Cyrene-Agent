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

  it("profileId 档案槽缺失 → 该档案 provider 槽兜底", async () => {
    const model = await load();
    const keyring = await import("./secrets-keyring");
    keyring.deleteSecret("model:profile:pf-b"); // keyring 与 vault 同步移除
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
