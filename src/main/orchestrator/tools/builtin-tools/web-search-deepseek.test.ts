// DeepSeek Search 适配测试（#173）：mock fetch，不发真实网络请求。
// 覆盖：结果解析（正常/空态/summary 空回落 content——need_content=false 时恒空）、
// ori_question 透传（ctx.userQuery 截 128）、key 缺失、语法透传、后端过滤。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchCache, setSearchConfig, webSearchTool } from "./web-search-tool";
import { shouldExposeSearchTool } from "../../search-backend-filter";

function makeDsResp(results: Array<{ title: string; url: string; summary?: string; content?: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ results }),
  } as unknown as Response;
}

beforeEach(() => clearWebSearchCache());
afterEach(() => {
  vi.unstubAllGlobals();
  setSearchConfig(() => "off", () => "", () => "", () => "");
});

describe("deepseekSearch（#173）", () => {
  it("解析 results：title/url/summary → WebSearchResult", async () => {
    const fetchMock = vi.fn(async () => makeDsResp([
      { title: "结果一", url: "https://example.com/1", summary: "摘要一" },
      { title: "结果二", url: "https://example.com/2", summary: "摘要二" },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    setSearchConfig(() => "deepseek", () => "", () => "", () => "", () => "sk-ds-key");
    const out = JSON.parse(await webSearchTool.execute!({ query: "site:example.com 测试" }, undefined) as string);
    expect(out.success).toBe(true);
    expect(out.resultCount).toBe(2);
    expect(out.results[0]).toEqual({ title: "结果一", url: "https://example.com/1", snippet: "摘要一" });
    // 请求体：Bearer 同 key + 语法透传 + need_content:false + count
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe("site:example.com 测试");
    expect(body.count).toBe(8);
    expect(body.need_content).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ds-key");
  });

  it("空 results / summary 空且 content 空 → snippet 空串，不炸", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeDsResp([
      { title: "空结果", url: "https://example.com/3" },
      { title: "双空", url: "https://example.com/4", summary: "", content: "" },
    ])));
    setSearchConfig(() => "deepseek", () => "", () => "", () => "", () => "k");
    const out = JSON.parse(await webSearchTool.execute!({ query: "q" }, undefined) as string);
    expect(out.resultCount).toBe(2);
    expect(out.results.every((r: { snippet: string }) => r.snippet === "")).toBe(true);
  });

  it("ori_question 透传 ctx.userQuery（截 128）", async () => {
    const fetchMock = vi.fn(async () => makeDsResp([]));
    vi.stubGlobal("fetch", fetchMock);
    setSearchConfig(() => "deepseek", () => "", () => "", () => "", () => "k");
    const longQuery = "用户原始问题".repeat(40); // 240 字符 → 截 128
    await webSearchTool.execute!({ query: "新闻" }, { userQuery: longQuery, signal: undefined } as never);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.ori_question).toBe(longQuery.slice(0, 128));
  });

  it("key 缺失 → E_SEARCH_KEY_MISSING", async () => {
    setSearchConfig(() => "deepseek", () => "", () => "", () => "", () => "");
    await expect(webSearchTool.execute!({ query: "q" }, undefined)).rejects.toThrow("E_SEARCH_KEY_MISSING");
  });
});

describe("deepseek 后端互斥过滤（#173）", () => {
  it("deepseek 后端：web_search 暴露；minimax 专属不适用；非搜索工具不受影响", () => {
    expect(shouldExposeSearchTool("web_search", "deepseek")).toBe(true);
    expect(shouldExposeSearchTool("web_search", "bocha")).toBe(true);
    expect(shouldExposeSearchTool("minimax-web-search-1", "deepseek")).toBe(false);
    expect(shouldExposeSearchTool("run_shell", "deepseek")).toBe(true);
  });
});
