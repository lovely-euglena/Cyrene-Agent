import { describe, expect, it } from "vitest";
import { SyncClient, SyncHttpError, type FetchLike } from "./sync-client";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(handler: (record: Recorded) => Response | Promise<Response>): { fetchFn: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[key] = String(value);
    }
    const record: Recorded = { url: input, method: init?.method ?? "GET", headers, body: init?.body as string | undefined };
    calls.push(record);
    return handler(record);
  };
  return { fetchFn, calls };
}

const validEvent = {
  eventId: "e1",
  sessionId: "s1",
  type: "message.append",
  lamport: 1,
  deviceId: "dev-a",
  seq: 1,
  ts: "2026-10-04T00:00:00.000Z",
  payload: { role: "user", text: "hi", turnId: "t1" },
};

describe("SyncClient.pair", () => {
  it("POST /v1/pair 并解析结果", async () => {
    const { fetchFn, calls } = mockFetch(() => jsonResponse({ deviceId: "d1", name: "手机", token: "tok" }));
    const client = new SyncClient("", fetchFn);
    await expect(client.pair("123456", "手机")).resolves.toEqual({ deviceId: "d1", name: "手机", token: "tok" });
    expect(calls[0].url).toBe("/v1/pair");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ code: "123456", deviceName: "手机" });
  });

  it("错误码映射为 SyncHttpError", async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({ code: "E_PAIR_CODE" }, 400));
    const client = new SyncClient("", fetchFn);
    const error = await client.pair("bad", "手机").catch((caught) => caught);
    expect(error).toBeInstanceOf(SyncHttpError);
    expect(error).toMatchObject({ status: 400, code: "E_PAIR_CODE" });
  });
});

describe("SyncClient.fetchPage", () => {
  it("解析事件并丢弃协议校验失败项", async () => {
    const { fetchFn, calls } = mockFetch(() =>
      jsonResponse({ events: [validEvent, { bogus: true }], cursor: "7", hasMore: true }),
    );
    const client = new SyncClient("", fetchFn);
    const page = await client.fetchPage("tok", 3, 50);
    expect(page.cursor).toBe(7);
    expect(page.hasMore).toBe(true);
    expect(page.dropped).toBe(1);
    expect(page.events.map((item) => item.eventId)).toEqual(["e1"]);
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].url).toBe("/v1/sync/fetch?since=3&limit=50");
  });

  it("sessionId 透传", async () => {
    const { fetchFn, calls } = mockFetch(() => jsonResponse({ events: [], cursor: "0", hasMore: false }));
    const client = new SyncClient("", fetchFn);
    await client.fetchPage("tok", 0, 200, "s1");
    expect(calls[0].url).toBe("/v1/sync/fetch?since=0&limit=200&sessionId=s1");
  });
});

describe("SyncClient.fetchAll", () => {
  it("循环分页直到 hasMore=false，onPage 逐页回调", async () => {
    let call = 0;
    const { fetchFn, calls } = mockFetch(() => {
      call++;
      return call === 1
        ? jsonResponse({ events: [validEvent], cursor: "5", hasMore: true })
        : jsonResponse({ events: [{ ...validEvent, eventId: "e2", seq: 2 }], cursor: "9", hasMore: false });
    });
    const client = new SyncClient("", fetchFn);
    const pages: number[] = [];
    const result = await client.fetchAll("tok", 0, (page) => pages.push(page.events.length));
    expect(result.cursor).toBe(9);
    expect(result.events.map((item) => item.eventId)).toEqual(["e1", "e2"]);
    expect(pages).toEqual([1, 1]);
    expect(calls).toHaveLength(2);
  });
});

describe("SyncClient.push", () => {
  it("JSONL 批 + ndjson Content-Type + Bearer", async () => {
    const { fetchFn, calls } = mockFetch(() => jsonResponse({ accepted: 1, duplicates: 0, cursor: "3" }));
    const client = new SyncClient("", fetchFn);
    const result = await client.push("tok", [validEvent as never]);
    expect(result).toEqual({ accepted: 1, duplicates: 0, cursor: 3 });
    expect(calls[0].headers["Content-Type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    const lines = (calls[0].body ?? "").split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).eventId).toBe("e1");
  });
});
