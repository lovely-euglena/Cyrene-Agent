/**
 * llm-host 双轨 facade 测试（复审放行条件 2：宿主拉起与双轨链路）。
 *
 * 覆盖：ensureStarted 显式拉起（P0-1——宿主不可用 → E_LLM_HOST_LOST 回退直连）、
 * submit→poll 事件翻译 → ChatResponse（文本/usage/finish 对齐直连语义）、
 * poll 丢失即 cancel（P1-11 防双计费）、路由判定（双开关 + openai + 流式）。
 * 环境：CYRENE_LLM_HOST=1 + CYRENE_SECRETS_HOST=1 + keyring 预 hydrate（桩客户端）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __setLlmHostClientForTests,
  callLLMViaLlmHost,
  shouldRouteViaLlmHost,
  type LlmHostCallOptions,
} from "./llm-host-facade";
import { hydrateKeyring, __resetKeyringForTests } from "../../settings/secrets-keyring";
import { __setSecretsHostClientForTests } from "../../dotnet-backend/secrets-client";
import type { LlmHostClient } from "../../dotnet-backend/llm-host-client";
import type { ChatVendorAdapter, ChatRequest, VendorConfig } from "./types";

let savedEnv: Record<string, string | undefined> = {};

class StubSecretsClient {
  async ensureStarted() { return true; }
  async status() { return { count: 1, migrated: true, migratedAt: null, protector: "stub", available: true }; }
  async get(name: string) { return name === "model:provider:PA" ? "sk-stub" : null; }
  async put(_name: string, _value: string) { }
  async remove(_name: string) { return true; }
  async list() { return [{ name: "model:provider:PA", createdAt: "", updatedAt: "" }]; }
  async import(v: Record<string, string>) { return Object.keys(v).length; }
  async markMigrated() { }
}

class StubLlmHostClient {
  startedCalls = 0;
  cancelledJobIds: string[] = [];
  failStart = false;
  script: Array<{ events: Array<{ type: string; text?: string; reason?: string; code?: string; message?: string; inputTokens?: number; outputTokens?: number; attempt?: number; delayMs?: number; category?: string }> }> = [];
  enabled() { return true; }
  async ensureStarted() {
    this.startedCalls++;
    if (this.failStart) return false;
    return true;
  }
  async submit(_payload: unknown): Promise<string> {
    if (this.failStart) throw new Error("host 未运行");
    return "j-test";
  }
  async poll(jobId: string, cursor: number): Promise<{
    jobId: string; cursor: number; nextCursor: number; final: boolean; events: Array<Record<string, unknown>>;
  }> {
    const frame = this.script[cursor] ?? { events: [] };
    return { jobId, cursor, nextCursor: cursor + 1, final: cursor + 1 >= this.script.length, events: frame.events };
  }
  async cancel(jobId: string) { this.cancelledJobIds.push(jobId); }
  async status() { return { jobs: 0, running: 0, queued: 0, secrets: true }; }
}

const adapter = {
  id: "stub-openai",
  transport: "openai" as const,
  capability: {} as never,
  buildRequest: (() => ({ url: "", method: "POST", headers: {}, body: "{}" })) as never,
  buildStreamRequest: (() => ({
    url: "https://api.example.com/chat/completions",
    method: "POST" as const,
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-secret" },
    body: '{"model":"m"}',
  })) as never,
  parseResponse: (() => { throw new Error("unused"); }) as never,
  appendToolResults: (() => []) as never,
  parseStreamEvent: (() => null) as never,
  testConnection: (async () => { throw new Error("unused"); }) as never,
} as unknown as ChatVendorAdapter;

const vendorConfig: VendorConfig = {
  provider: "PA",
  baseUrl: "https://api.example.com",
  model: "m-1",
  apiKey: "sk-stub",
} as VendorConfig;

const chatRequest: ChatRequest = { model: "m-1", messages: [{ role: "user", content: "hi" }], stream: true };

const options = (overrides: Partial<LlmHostCallOptions> = {}): LlmHostCallOptions => ({
  adapter,
  request: chatRequest,
  config: vendorConfig,
  timeoutMs: 60_000,
  onDelta: () => { },
  ...overrides,
});

beforeAll(async () => {
  savedEnv = { LLM: process.env.CYRENE_LLM_HOST, SECRETS: process.env.CYRENE_SECRETS_HOST };
  process.env.CYRENE_LLM_HOST = "1";
  process.env.CYRENE_SECRETS_HOST = "1";
  __setSecretsHostClientForTests(new StubSecretsClient() as unknown as import("../../dotnet-backend/secrets-client").SecretsHostClient);
  await hydrateKeyring(); // keyring 就绪（resolveVaultKeyForVendor / shouldRoute 依赖）
});

afterAll(() => {
  process.env.CYRENE_LLM_HOST = savedEnv.LLM;
  process.env.CYRENE_SECRETS_HOST = savedEnv.SECRETS;
  __setLlmHostClientForTests(null);
  __setSecretsHostClientForTests(null);
  __resetKeyringForTests();
});

describe("shouldRouteViaLlmHost（双轨路由判定）", () => {
  it("双开 + hydrate + 流式 + openai → true", () => {
    expect(shouldRouteViaLlmHost(vendorConfig, chatRequest)).toBe(true);
  });
  it("非流式 → false", () => {
    expect(shouldRouteViaLlmHost(vendorConfig, { ...chatRequest, stream: false })).toBe(false);
  });
});

describe("callLLMViaLlmHost（宿主拉起 + 事件翻译）", () => {
  it("P0-1：提交前显式 ensureStarted（幂等拉起，生产链路不空转）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "delta", text: "你好" }] },
      { events: [{ type: "finish", reason: "stop" }, { type: "usage", inputTokens: 7, outputTokens: 3 }, { type: "done" }] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await callLLMViaLlmHost(options());
    expect(stub.startedCalls).toBe(1);
  });

  it("宿主不可用 → E_LLM_HOST_LOST（回退直连信号），不发 submit", async () => {
    const stub = new StubLlmHostClient();
    stub.failStart = true;
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await expect(callLLMViaLlmHost(options())).rejects.toMatchObject({ code: "E_LLM_HOST_LOST" });
    expect(stub.startedCalls).toBe(1);
  });

  it("事件翻译：text/reasoning/finish/usage → ChatResponse（与直连同形）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "reasoning_delta", text: "思考" }, { type: "delta", text: "你好" }, { type: "delta", text: "！" }] },
      { events: [{ type: "finish", reason: "stop" }, { type: "usage", inputTokens: 7, outputTokens: 3 }, { type: "done" }] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const deltas: string[] = [];
    const resp = await callLLMViaLlmHost(options({
      onDelta: (d) => { if (d.type === "text_delta") deltas.push(d.delta); },
    }));
    expect(resp.text).toBe("你好！");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toMatchObject({ input: 7, output: 3 });
    expect(resp.assistantMessage).toMatchObject({ role: "assistant", content: "你好！" });
    expect(deltas.join("")).toBe("你好！");
    expect(resp.thinking).toBe("思考");
  });

  it("流内错误 → E_MODEL_REQUEST_FAILED（不回退、不重放）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "delta", text: "已输出" }] },
      { events: [{ type: "error", code: "E_LLM_HTTP_500", message: "上游炸了" }] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await expect(callLLMViaLlmHost(options())).rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED" });
  });

  it("P1-11：poll 失败（host 丢失）时 cancel .NET 侧作业（防双计费）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [];
    // poll 返回缺 data → 客户端抛协议错误 → cancel 兜底
    stub.poll = async () => { throw new Error("host 退出"); };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await expect(callLLMViaLlmHost(options())).rejects.toMatchObject({ code: "E_LLM_HOST_LOST" });
    expect(stub.cancelledJobIds).toEqual(["j-test"]);
  });
});
