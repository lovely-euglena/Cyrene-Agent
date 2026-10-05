/**
 * llm-host 双轨 facade 测试（复审放行条件 2：宿主拉起与双轨链路）。
 *
 * 覆盖：ensureStarted 显式拉起（P0-1——宿主不可用 → E_LLM_HOST_LOST 回退直连）、
 * submit→poll 事件翻译 → ChatResponse（文本/usage/finish/tool_calls 对齐直连语义）、
 * poll 丢失即 cancel（P1-11 防双计费）、路由判定（双开关 + openai + 流式）、
 * 取消窗口（P1-4/P2-5）、业务码分类与 retryable 透传（P1-3/P2-4）、dropped 告警口径（P2-2）。
 * 环境：CYRENE_LLM_HOST=1 + CYRENE_SECRETS_HOST=1 + keyring 预 hydrate（桩客户端）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  submitPayloads: Array<Record<string, unknown>> = [];
  submitImpl: ((payload: Record<string, unknown>) => Promise<string>) | null = null;
  /** P2-5 用例：挂起 ensureStarted（冷启动窗口）。 */
  startImpl: (() => Promise<boolean>) | null = null;
  script: Array<{
    events: Array<{ type: string; text?: string; reason?: string; code?: string; message?: string; inputTokens?: number; outputTokens?: number; attempt?: number; delayMs?: number; category?: string; retryable?: boolean; calls?: unknown }>;
    dropped?: number;
    truncated?: boolean;
  }> = [];
  enabled() { return true; }
  async ensureStarted() {
    this.startedCalls++;
    if (this.startImpl) return this.startImpl();
    if (this.failStart) return false;
    return true;
  }
  async submit(payload: unknown): Promise<string> {
    this.submitPayloads.push(payload as Record<string, unknown>);
    if (this.submitImpl) return this.submitImpl(payload as Record<string, unknown>);
    if (this.failStart) throw new Error("host 未运行");
    return "j-test";
  }
  async poll(jobId: string, cursor: number): Promise<{
    jobId: string; cursor: number; nextCursor: number; final: boolean; events: Array<Record<string, unknown>>;
    dropped?: number; truncated?: boolean;
  }> {
    const frame = this.script[cursor] ?? { events: [] };
    return {
      jobId, cursor, nextCursor: cursor + 1, final: cursor + 1 >= this.script.length, events: frame.events,
      ...(frame.dropped !== undefined ? { dropped: frame.dropped } : {}),
      ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    };
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

afterEach(() => { vi.restoreAllMocks(); });

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

  it("P2-8：tool_calls_delta 聚合（OpenAI 原样透传：index 对齐 + id/name 首块 + 参数分片拼接）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "tool_calls_delta", calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } }] }] },
      { events: [
        { type: "tool_calls_delta", calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] },
        { type: "finish", reason: "tool_calls" }, { type: "done" },
      ] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const resp = await callLLMViaLlmHost(options());
    expect(resp.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }]);
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.assistantMessage.toolCalls).toEqual(resp.toolCalls);
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

describe("复审 P1-3：submit/poll 错误码分类（业务码不回退直连）", () => {
  it("submit 业务码（E_LLM_HOST_BAD_REQUEST）→ E_MODEL_REQUEST_FAILED，非 host-lost", async () => {
    const stub = new StubLlmHostClient();
    stub.submitImpl = async () => {
      throw Object.assign(new Error("submit 帧解析失败"), { errorCode: "E_LLM_HOST_BAD_REQUEST", retryable: false });
    };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const err = await callLLMViaLlmHost(options()).catch((e: unknown) => e) as { code?: string; message?: string };
    expect(err.code).toBe("E_MODEL_REQUEST_FAILED");
    expect(err.message).toContain("E_LLM_HOST_BAD_REQUEST");
  });

  it("poll 业务码（E_LLM_HOST_JOB_MISSING，无可见增量）→ E_MODEL_REQUEST_FAILED + 尽力 cancel", async () => {
    const stub = new StubLlmHostClient();
    stub.poll = async () => {
      throw Object.assign(new Error("job not found"), { errorCode: "E_LLM_HOST_JOB_MISSING" });
    };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const err = await callLLMViaLlmHost(options()).catch((e: unknown) => e) as { code?: string; message?: string };
    expect(err.code).toBe("E_MODEL_REQUEST_FAILED");
    expect(err.message).toContain("E_LLM_HOST_JOB_MISSING");
    expect(stub.cancelledJobIds).toEqual(["j-test"]);
  });

  it("P2-4：业务码 retryable 透传（E_LLM_HOST_LANE_FULL retryable:true 不丢可重试信号）", async () => {
    const stub = new StubLlmHostClient();
    stub.submitImpl = async () => {
      throw Object.assign(new Error("low lane queue is full"), { errorCode: "E_LLM_HOST_LANE_FULL", retryable: true });
    };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const err = await callLLMViaLlmHost(options()).catch((e: unknown) => e) as { code?: string; modelFailure?: { category?: string; retryable?: boolean } };
    expect(err.code).toBe("E_MODEL_REQUEST_FAILED");
    expect(err.modelFailure).toMatchObject({ category: "SERVER_ERROR", retryable: true });
  });

  it("无 errorCode（进程失败）仍归宿主丢失 → E_LLM_HOST_LOST（回退直连）", async () => {
    const stub = new StubLlmHostClient();
    stub.submitImpl = async () => { throw new Error("host 退出"); };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await expect(callLLMViaLlmHost(options())).rejects.toMatchObject({ code: "E_LLM_HOST_LOST" });
  });
});

describe("复审 P1-4：取消窗口（入口预检 + submit 期间补发 cancel）", () => {
  it("入口已中止 signal → 不拉宿主、不 submit，抛取消", async () => {
    const stub = new StubLlmHostClient();
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const ac = new AbortController();
    ac.abort();
    await expect(callLLMViaLlmHost(options({ signal: ac.signal }))).rejects.toThrow(/E_SOUL_ONLY_CANCELLED/);
    expect(stub.startedCalls).toBe(0);
    expect(stub.submitPayloads.length).toBe(0);
  });

  it("submit 窗口内中止 → 作业创建后立即 cancel（不让 .NET 跑到自然终态）", async () => {
    const stub = new StubLlmHostClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stub.submitImpl = async () => { await gate; return "j-test"; };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const ac = new AbortController();
    const pending = callLLMViaLlmHost(options({ signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 10)); // 让 submit 挂起
    ac.abort();
    release();
    await expect(pending).rejects.toThrow(/E_SOUL_ONLY_CANCELLED/);
    expect(stub.cancelledJobIds).toEqual(["j-test"]);
  });

  it("P2-5：ensureStarted 窗口内中止 → 预检拦截，不 submit、不建 .NET 作业", async () => {
    const stub = new StubLlmHostClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stub.startImpl = async () => { await gate; return true; };
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const ac = new AbortController();
    const pending = callLLMViaLlmHost(options({ signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 10)); // 让 ensureStarted 挂起
    ac.abort();
    release();
    await expect(pending).rejects.toThrow(/E_SOUL_ONLY_CANCELLED/);
    expect(stub.startedCalls).toBe(1);
    expect(stub.submitPayloads.length).toBe(0);
    expect(stub.cancelledJobIds).toEqual([]);
  });
});

describe("复审 P1-5 / P2-2：maxRetries 透传与错误分类消费", () => {
  it("maxRetries 同值透传 submit 与 retry 事件分母", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "retry", attempt: 2, delayMs: 1000, category: "RATE_LIMIT" }] },
      { events: [{ type: "delta", text: "ok" }, { type: "finish", reason: "stop" }, { type: "done" }] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const statuses: Array<{ maxRetries: number; retryNumber: number }> = [];
    await callLLMViaLlmHost(options({
      maxRetries: 7,
      onRetryStatus: (s) => statuses.push({ maxRetries: s.maxRetries, retryNumber: s.retryNumber }),
    }));
    expect(stub.submitPayloads[0].maxRetries).toBe(7);
    expect(statuses).toEqual([{ maxRetries: 7, retryNumber: 2 }]);
  });

  it("终态 error 事件消费 C# category/retryable（不再固定 SERVER_ERROR）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [{ events: [{ type: "error", code: "E_LLM_HTTP_0", message: "断网", category: "NETWORK", retryable: false }] }];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const err = await callLLMViaLlmHost(options()).catch((e: unknown) => e) as { modelFailure?: { category?: string; retryable?: boolean } };
    expect(err.modelFailure?.category).toBe("NETWORK");
    expect(err.modelFailure?.retryable).toBe(false);
  });

  it("取消与 E_LLM_CANCELLED 竞态 → 归取消（不显示为模型错误）", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [{ events: [{ type: "error", code: "E_LLM_CANCELLED", message: "cancelled" }] }];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    await expect(callLLMViaLlmHost(options())).rejects.toThrow(/E_SOUL_ONLY_CANCELLED/);
  });
});

describe("复审 P2-2：dropped/truncated 告警口径（回收累计 ≠ 缺口）", () => {
  it("dropped>0 但 truncated=false → 提示性告警（无缺口），每次作业只告警一次", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "delta", text: "a" }], dropped: 3 },
      { events: [{ type: "finish", reason: "stop" }, { type: "done" }], dropped: 4 },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const resp = await callLLMViaLlmHost(options());
    expect(resp.text).toBe("a");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("无增量缺口");
    expect(String(warn.mock.calls[0][0])).toContain("3");
  });

  it("truncated=true（请求 cursor 落在已丢弃段）→ 缺口告警", async () => {
    const stub = new StubLlmHostClient();
    stub.script = [
      { events: [{ type: "delta", text: "a" }], dropped: 5, truncated: true },
      { events: [{ type: "finish", reason: "stop" }, { type: "done" }] },
    ];
    __setLlmHostClientForTests(stub as unknown as LlmHostClient);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    await callLLMViaLlmHost(options());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("增量缺口");
    expect(String(warn.mock.calls[0][0])).toContain("已丢弃段");
  });
});
