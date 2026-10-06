// http-client 单测（IKJK2I B）：fetchImpl 注入，不依赖真实网络。
// 覆盖：URL / 头 / 错误码映射 / 401 / 429 / push 分块 / token 不泄漏 / clone 流解析。
import { describe, expect, it, vi } from "vitest";
import {
  chunkJsonLines,
  createSyncHttpClient,
  normalizeDotNetExpiresAt,
  SyncHttpError,
  SYNC_PUSH_MAX_BYTES,
  SYNC_PUSH_MAX_EVENT_BYTES,
  type SyncFetchLike,
} from "./http-client";
import type { SyncEventV0 } from "./sync-protocol";

function event(id: string, lamport: number, overrides: Partial<SyncEventV0> = {}): SyncEventV0 {
  return {
    eventId: id,
    sessionId: "c1",
    type: "message.append",
    lamport,
    deviceId: "desk-local",
    seq: lamport,
    ts: "2026-10-06T00:00:00.000Z",
    payload: { role: "user", text: `hello-${id}`, turnId: `turn-${id}` },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const BASE = "https://cloud.example.com";

describe("sync/http-client", () => {
  it("pair：POST /v1/pair（公开，无 Authorization），解析 deviceId/name/token", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () =>
      jsonResponse({ deviceId: "dev_1", name: "我的桌面", token: "tok-1" }));
    const client = createSyncHttpClient({ baseUrl: `${BASE}/`, token: "", fetchImpl });

    const result = await client.pair("ABCD-1234", "我的桌面");

    expect(result).toEqual({ deviceId: "dev_1", name: "我的桌面", token: "tok-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/pair`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ code: "ABCD-1234", deviceName: "我的桌面" });
  });

  it("createPairCode：POST /v1/pair/code 带 Bearer；expiresAt 归一化为毫秒 ISO", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () =>
      jsonResponse({ code: "WXYZ-5678", expiresAt: "2026-10-06T12:34:56.1234567+00:00" }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const result = await client.createPairCode();

    expect(result).toEqual({ code: "WXYZ-5678", expiresAt: "2026-10-06T12:34:56.123Z" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/pair/code`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("capabilities：公开只读，不带 Authorization", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse({ protocol: "v0", maxBatchBytes: 10_000_000 }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const result = await client.capabilities();

    expect(result).toMatchObject({ protocol: "v0", maxBatchBytes: 10_000_000 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/capabilities`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("push：JSONL + ndjson Content-Type + Bearer；聚合 accepted/duplicates/cursor", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse({ accepted: 2, duplicates: 0, cursor: 9 }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const result = await client.push([event("e1", 1), event("e2", 2)]);

    expect(result).toEqual({ accepted: 2, duplicates: 0, cursor: "9" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/sync/push`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok-1",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    });
    const lines = String(init?.body).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ eventId: "e1" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ eventId: "e2" });
  });

  it("push：按序列化字节 ≤5 MiB 分块（两条 3 MiB 事件 → 两批）", async () => {
    const bigText = "x".repeat(3 * 1024 * 1024);
    const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse({ accepted: 1, duplicates: 0, cursor: 1 }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    await client.push([
      event("big-1", 1, { payload: { role: "user", text: bigText, turnId: "t1" } }),
      event("big-2", 2, { payload: { role: "user", text: bigText, turnId: "t2" } }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      const body = String(call[1]?.body);
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(SYNC_PUSH_MAX_BYTES);
    }
  });

  it("chunkJsonLines：按字节上限切分，单条超限独占一批", () => {
    const chunks = chunkJsonLines(["aa", "bb", "cccccccccc"], 5);
    expect(chunks).toEqual([["aa", "bb"], ["cccccccccc"]]);
  });

  it("push：单事件超过服务端单事件上限 → oversize_event（message 含 eventId，不发请求）", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse({ accepted: 1, duplicates: 0, cursor: 1 }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });
    const huge = event("huge-1", 1, {
      payload: { role: "user", text: "x".repeat(SYNC_PUSH_MAX_EVENT_BYTES + 16), turnId: "t1" },
    });

    // 超限事件位于批中第二位也必须整批拦下（否则前置事件白白推进，超限事件永久停滞）
    const error = await client.push([event("ok-1", 0), huge]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).code).toBe("oversize_event");
    expect((error as SyncHttpError).message).toContain("huge-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetch：since/limit/sessionId 查询参数 + 事件校验 + cursor/hasMore", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () =>
      jsonResponse({
        events: [event("e1", 1), { bad: true }],
        cursor: "55",
        hasMore: true,
      }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const page = await client.fetch("10", { sessionId: "c1", limit: 50 });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.eventId).toBe("e1");
    expect(page.dropped).toBe(1);
    expect(page.cursor).toBe("55");
    expect(page.hasMore).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/sync/fetch?since=10&limit=50&sessionId=c1`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("clone：NDJSON 流式解析 + X-Sync-Cursor + 坏行丢弃 + 规范排序", async () => {
    const lines = [
      JSON.stringify(event("e2", 2)),
      "{半截坏行",
      JSON.stringify(event("e1", 1)),
      "",
    ].join("\n");
    const fetchImpl = vi.fn<SyncFetchLike>(async () =>
      new Response(lines, { status: 200, headers: { "X-Sync-Cursor": "42" } }));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const result = await client.clone();

    expect(result.cursor).toBe("42");
    expect(result.dropped).toBe(1);
    expect(result.events.map((item) => item.eventId)).toEqual(["e1", "e2"]);
  });

  it("clone：无 body 流时退化为整体文本解析", async () => {
    const text = `${JSON.stringify(event("e1", 1))}\n`;
    const fetchImpl = vi.fn<SyncFetchLike>(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "x-sync-cursor" ? "7" : null) },
      text: async () => text,
    }) as unknown as Response);
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    const result = await client.clone();

    expect(result.cursor).toBe("7");
    expect(result.events.map((item) => item.eventId)).toEqual(["e1"]);
  });

  it("readJson：response.text() 失败 → network（不按空 body 记成功）", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new TypeError("stream broken"); },
    }) as unknown as Response);
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    await expect(client.fetch("1")).rejects.toMatchObject({ code: "network" });
  });

  it("clone：无 body 流且 text() 失败 → network（不返回空事件集）", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "7" },
      text: async () => { throw new TypeError("stream broken"); },
    }) as unknown as Response);
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });

    await expect(client.clone()).rejects.toMatchObject({ code: "network" });
  });

  it("错误映射：401 unauthorized / 429 rate_limited / 400 batch_invalid / 400 E_PAIR_CODE / 404 / 421", async () => {
    const cases: Array<{ status: number; body: unknown; expected: string }> = [
      { status: 401, body: { code: "E_UNAUTHORIZED" }, expected: "unauthorized" },
      { status: 429, body: { code: "E_RATE_LIMITED" }, expected: "rate_limited" },
      { status: 400, body: { code: "E_SYNC_BATCH_INVALID" }, expected: "batch_invalid" },
      { status: 400, body: { code: "E_SYNC_BATCH_REJECTED" }, expected: "batch_rejected" },
      { status: 400, body: { code: "E_PAIR_CODE" }, expected: "invalid_config" },
      { status: 400, body: { code: "E_SYNC_CURSOR" }, expected: "cursor" },
      { status: 404, body: { code: "E_DEVICE_NOT_FOUND" }, expected: "not_found" },
      { status: 421, body: { code: "E_HOST_NOT_ALLOWED" }, expected: "forbidden" },
      { status: 500, body: {}, expected: "http" },
    ];
    for (const testCase of cases) {
      const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse(testCase.body, testCase.status));
      const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-1", fetchImpl });
      const error = await client.fetch("1").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SyncHttpError);
      expect((error as SyncHttpError).code).toBe(testCase.expected);
      expect((error as SyncHttpError).status).toBe(testCase.status);
    }
  });

  it("错误文本脱敏：剥离 token 与 baseUrl，不含请求 URL", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () =>
      jsonResponse(
        { code: "E_UNAUTHORIZED", error: `token tok-secret rejected at ${BASE}/v1/sync/fetch` },
        401,
      ));
    const client = createSyncHttpClient({ baseUrl: BASE, token: "tok-secret", fetchImpl });

    const error = await client.fetch("1").catch((err: unknown) => err as SyncHttpError);

    expect(error.message).not.toContain("tok-secret");
    expect(error.message).not.toContain(BASE);
    expect(error.message).toContain("***");
    expect(error.message).toContain("<server>");
    expect(error.message).toContain("E_UNAUTHORIZED");
  });

  it("invalid_config：缺 baseUrl / 缺 token 直接抛（不发请求）", async () => {
    const fetchImpl = vi.fn<SyncFetchLike>(async () => jsonResponse({}));
    const noBase = createSyncHttpClient({ baseUrl: "", token: "tok", fetchImpl });
    await expect(noBase.fetch("1")).rejects.toMatchObject({ code: "invalid_config" });

    const noToken = createSyncHttpClient({ baseUrl: BASE, token: "", fetchImpl });
    await expect(noToken.fetch("1")).rejects.toMatchObject({ code: "invalid_config" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("network / timeout / aborted 映射", async () => {
    const network = createSyncHttpClient({
      baseUrl: BASE,
      token: "tok",
      fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }),
    });
    await expect(network.fetch("1")).rejects.toMatchObject({ code: "network" });

    const timeout = createSyncHttpClient({
      baseUrl: BASE,
      token: "tok",
      fetchImpl: vi.fn(async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    });
    await expect(timeout.fetch("1")).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    controller.abort();
    const aborted = createSyncHttpClient({
      baseUrl: BASE,
      token: "tok",
      signal: controller.signal,
      fetchImpl: vi.fn(async () => { throw new DOMException("Aborted", "AbortError"); }),
    });
    await expect(aborted.fetch("1")).rejects.toMatchObject({ code: "aborted" });
  });

  it("normalizeDotNetExpiresAt：7 位小数裁剪 / 时区偏移 / 无小数 / 非法输入", () => {
    expect(normalizeDotNetExpiresAt("2026-10-06T12:34:56.1234567+00:00")).toBe("2026-10-06T12:34:56.123Z");
    expect(normalizeDotNetExpiresAt("2026-10-06T14:34:56.9999999+02:00")).toBe("2026-10-06T12:34:56.999Z");
    expect(normalizeDotNetExpiresAt("2026-10-06T12:34:56Z")).toBe("2026-10-06T12:34:56.000Z");
    expect(normalizeDotNetExpiresAt("not-a-date")).toBe("");
    expect(normalizeDotNetExpiresAt(null)).toBe("");
  });
});
