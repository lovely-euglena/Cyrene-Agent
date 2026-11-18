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

describe("zhipuSearch（#186 扩展）", () => {
  it("解析 search_result：title/link/content 首段 → WebSearchResult，media 作 source", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ search_result: [
        { title: "智谱结果", content: "正文第一段\n正文第二段", link: "https://example.cn/1", media: "ExampleCN" },
        { content: "无标题条目", link: "https://example.cn/2" },
      ] }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    setSearchConfig(() => "zhipu", () => "", () => "", () => "", () => "", () => "zhipu-key");
    const output = JSON.parse(await webSearchTool.execute!({ query: "经济事件" }, undefined) as string);
    expect(output.success).toBe(true);
    expect(output.resultCount).toBe(2);
    expect(output.results[0]).toEqual({ title: "智谱结果", url: "https://example.cn/1", snippet: "正文第一段", source: "ExampleCN" });
    expect(output.results[1].title).toBe("https://example.cn/2");
    // 请求体断言：search-prime 引擎 + query 透传
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.search_engine).toBe("search-prime");
    expect(body.search_query).toBe("经济事件");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer zhipu-key");
  });

  it("空态：search_result 缺失/空数组 → resultCount 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeDsResp({}) as unknown as Response));
    setSearchConfig(() => "zhipu", () => "", () => "", () => "", () => "", () => "k");
    const output = JSON.parse(await webSearchTool.execute!({ query: "q" }, undefined) as string);
    expect(output.resultCount).toBe(0);
  });

  it("key 缺失（shared 渠道未配/单独为空）→ E_SEARCH_KEY_MISSING", async () => {
    setSearchConfig(() => "zhipu", () => "", () => "", () => "", () => "", () => "");
    await expect(webSearchTool.execute!({ query: "q" }, undefined)).rejects.toThrow("E_SEARCH_KEY_MISSING");
  });

  it("zhipu 后端：web_search 暴露；非搜索工具不受影响", () => {
    expect(shouldExposeSearchTool("web_search", "zhipu")).toBe(true);
    expect(shouldExposeSearchTool("minimax-web-search-1", "zhipu")).toBe(false);
    expect(shouldExposeSearchTool("run_shell", "zhipu")).toBe(true);
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
