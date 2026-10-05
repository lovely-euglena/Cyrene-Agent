/**
 * PR19 P1-2 回归：WPF 原生快照密钥门控与 Electron maskForUi 统一为 vaultAuthoritative。
 *
 *  - 非 authoritative（vault 开但未 hydrate 且未迁移）→ 快照保留明文（迁移前回退明文）；
 *  - authoritative（已迁移/盘上 migratedAt 标记）→ API 配置/档案/vision 及 TTS/ASR key
 *    全部掩码为空串（与 saveModelSettings「空=不改」语义配套）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
}));

beforeEach(() => {
  vi.resetModules();
  electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-native-gate-"));
  process.env.CYRENE_SECRETS_HOST = "1";
});

afterEach(() => {
  delete process.env.CYRENE_SECRETS_HOST;
  fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
});

function modelSettings(overrides: Record<string, unknown> = {}): import("./model-settings").ModelSettings {
  return {
    mode: "manual",
    provider: "PA",
    displayName: "主力",
    baseUrl: "https://pa.example.com",
    model: "m-a",
    apiKey: "sk-x",
    explicitTransport: "openai",
    perProvider: {},
    modelProfiles: [],
    defaultModelProfileId: "p1",
    vision: { baseUrl: "https://v", apiKey: "sk-v", model: "vl" },
    multimodal: true,
    contextWindowTokens: 256000,
    ...overrides,
  } as import("./model-settings").ModelSettings;
}

function profile(): import("./model-catalog").SavedModelProfile {
  return {
    id: "p1",
    provider: "PA",
    displayName: "备选",
    baseUrl: "https://pa.example.com",
    model: "m-a",
    apiKey: "sk-y",
    explicitTransport: "openai",
  } as import("./model-catalog").SavedModelProfile;
}

async function loadSections() {
  const secrets = await import("../dotnet-backend/secrets-client");
  secrets.__setSecretsDataDirForTests(electronMock.userDataDir);
  return await import("./native-settings-sections");
}

describe("WPF 快照密钥门控（PR19 P1-2）", () => {
  it("非 authoritative（未 hydrate 且未迁移）：快照保留明文 key（与 Electron 一致）", async () => {
    const sections = await loadSections();
    const snapshot = sections.buildApiSectionSnapshot(modelSettings(), [profile()]);
    expect(snapshot.config.apiKey).toBe("sk-x");
    expect(snapshot.config.vision.apiKey).toBe("sk-v");
    expect(snapshot.profiles[0].apiKey).toBe("sk-y");
    expect(sections.buildTtsSectionSnapshot({ ttsMinimaxKey: "sk-tts" }).minimaxKey).toBe("sk-tts");
  });

  it("authoritative（盘上 migratedAt 标记，未 hydrate）：快照 key 全部掩码为空（与 Electron 一致）", async () => {
    fs.writeFileSync(
      path.join(electronMock.userDataDir, "secrets-vault.json"),
      JSON.stringify({ version: 1, migratedAt: "2026-10-05T00:00:00Z", entries: {} }),
    );
    const sections = await loadSections();
    const snapshot = sections.buildApiSectionSnapshot(modelSettings(), [profile()]);
    expect(snapshot.config.apiKey).toBe("");
    expect(snapshot.config.vision.apiKey).toBe("");
    expect(snapshot.profiles[0].apiKey).toBe("");
    expect(sections.buildTtsSectionSnapshot({ ttsMinimaxKey: "sk-tts" }).minimaxKey).toBe("");
    expect(sections.buildAsrSectionSnapshot({ asrAliyunAppKey: "sk-asr", ttsMosslandKey: "sk-moss" }).aliyunAppKey).toBe("");
  });
});
