import { describe, expect, it, vi } from "vitest";
import {
  aggregateQuota,
  createDeepSeekFile,
  isDeepSeekApiBase,
  listDeepSeekFiles,
  parseDataUrlImage,
  prepareDeepSeekFileImages,
} from "./deepseek-files";

/** mock fetch：按 pathname/方法路由；upload/list handler 缺失 = 404。 */
function mockFetch(handlers: {
  upload?: (form: FormData) => Record<string, unknown>;
  list?: () => { data: Array<Record<string, unknown>>; has_more?: boolean };
}) {
  return vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => "not found" } as unknown as Response;
    if (path === "/files" && method === "POST") {
      if (!handlers.upload) return notFound;
      const body = handlers.upload(init?.body as FormData);
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
    }
    if (path === "/files" && method === "GET") {
      if (!handlers.list) return notFound;
      return { ok: true, status: 200, json: async () => handlers.list(), text: async () => "" } as unknown as Response;
    }
    return notFound;
  }) as unknown as typeof fetch;
}

const PNG_1MB = "data:image/png;base64," + Buffer.alloc(1024 * 1024, 7).toString("base64");
const PNG_30MB = "data:image/png;base64," + Buffer.alloc(30 * 1024 * 1024, 7).toString("base64");

describe("isDeepSeekApiBase", () => {
  it("官方域名命中，自建中转/代理不命中", () => {
    expect(isDeepSeekApiBase("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekApiBase("https://api.deepseek.com/v1")).toBe(true);
    expect(isDeepSeekApiBase("https://deepseek.com")).toBe(true);
    expect(isDeepSeekApiBase("https://example.com/v1")).toBe(false);
    expect(isDeepSeekApiBase("https://api.deepseek.com.evil.io")).toBe(false);
  });
});

describe("parseDataUrlImage", () => {
  it("解析支持 mime；非图片/非法 base64 拒绝", () => {
    expect(parseDataUrlImage(PNG_1MB)?.mime).toBe("image/png");
    expect(parseDataUrlImage("data:text/plain;base64,aGk=")).toBeUndefined();
    expect(parseDataUrlImage("https://example.com/a.png")).toBeUndefined();
    expect(parseDataUrlImage("data:image/png;base64,!!!")).toBeUndefined();
  });
});

describe("createDeepSeekFile", () => {
  it("multipart 带 purpose=user_data 与 expires_after（7d 默认）", async () => {
    let captured: FormData | undefined;
    const fetchImpl = mockFetch({ upload: (form) => { captured = form; return { id: "file-api-abc" }; } });
    const id = await createDeepSeekFile("https://api.deepseek.com", "sk", Buffer.alloc(10), "a.png", undefined, fetchImpl);
    expect(id).toBe("file-api-abc");
    expect(captured?.get("purpose")).toBe("user_data");
    expect(captured?.get("expires_after[anchor]")).toBe("created_at");
    expect(captured?.get("expires_after[seconds]")).toBe(String(7 * 24 * 3600));
  });

  it("HTTP 失败抛错（供上层回退）", async () => {
    const fetchImpl = mockFetch({});
    await expect(createDeepSeekFile("https://api.deepseek.com", "sk", Buffer.alloc(10), "a.png", 3600, fetchImpl))
      .rejects.toThrow(/HTTP 404/);
  });
});

describe("listDeepSeekFiles / aggregateQuota", () => {
  it("分页聚合（has_more 推进）", async () => {
    const pages: Array<Array<Record<string, unknown>>> = [
      [{ id: "f1", filename: "a.png", bytes: 10 }],
      [{ id: "f2", filename: "b.png", bytes: 20 }],
    ];
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      const current = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ data: current, has_more: page < pages.length }),
        text: async () => "",
      } as unknown as Response;
    });
    const files = await listDeepSeekFiles("https://api.deepseek.com", "sk", fetchImpl as unknown as typeof fetch);
    expect(files.map((f) => f.id)).toEqual(["f1", "f2"]);
    const quota = aggregateQuota(files);
    expect(quota.count).toBe(2);
    expect(quota.totalBytes).toBe(30);
    expect(quota.quotaCount).toBe(10000);
  });
});

describe("prepareDeepSeekFileImages", () => {
  const request = (urls: string[]) => ({
    messages: [{ role: "user", content: urls.map((u) => ({ type: "image_url", image_url: { url: u } })) }],
  });

  it("非 DS 通道不做任何转换", async () => {
    const fetchImpl = mockFetch({});
    const result = await prepareDeepSeekFileImages(request([PNG_30MB]) as never, "https://example.com", "sk", fetchImpl);
    expect(result.uploaded).toBe(0);
    expect(result.request).toBeUndefined();
  });

  it("小图不转（阈值 24 MiB）", async () => {
    const fetchImpl = mockFetch({ upload: () => ({ id: "file-api-x" }) });
    const result = await prepareDeepSeekFileImages(request([PNG_1MB]) as never, "https://api.deepseek.com", "sk", fetchImpl);
    expect(result.uploaded).toBe(0);
    expect(result.request).toBeUndefined();
  });

  it("大图上传 → file 块替换；同图二发去重复用", async () => {
    const stored = new Map<string, string>();
    const fetchImpl = mockFetch({
      upload: (form) => {
        const file = form.get("file") as File;
        const id = "file-api-" + (stored.size + 1);
        stored.set(file.name, id);
        return { id };
      },
      list: () => ({ data: [...stored.entries()].map(([name, id]) => ({ id, filename: name, bytes: 1 })) }),
    });
    const req = request([PNG_30MB]) as never;
    const first = await prepareDeepSeekFileImages(req, "https://api.deepseek.com", "sk", fetchImpl);
    expect(first.uploaded).toBe(1);
    expect(first.reused).toBe(0);
    const firstBlock = (first.request?.messages?.[0] as { content: Array<Record<string, unknown>> }).content[0];
    expect(firstBlock).toEqual({ type: "file", file_id: "file-api-1" });

    const second = await prepareDeepSeekFileImages(req, "https://api.deepseek.com", "sk", fetchImpl);
    expect(second.uploaded).toBe(0);
    expect(second.reused).toBe(1);
    const secondBlock = (second.request?.messages?.[0] as { content: Array<Record<string, unknown>> }).content[0];
    expect(secondBlock.file_id).toBe("file-api-1");
  });

  it("上传失败逐块回退 base64 原样保留", async () => {
    const fetchImpl = mockFetch({ upload: () => { throw new Error("boom"); } });
    const result = await prepareDeepSeekFileImages(request([PNG_30MB]) as never, "https://api.deepseek.com", "sk", fetchImpl);
    expect(result.fallback).toBe(1);
    expect(result.request).toBeUndefined();
  });

  it("混合块（text + 小图 + 大图）：仅大图被替换", async () => {
    const fetchImpl = mockFetch({ upload: () => ({ id: "file-api-big" }) });
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: PNG_1MB } },
        { type: "image_url", image_url: { url: PNG_30MB } },
      ],
    }];
    const result = await prepareDeepSeekFileImages({ messages } as never, "https://api.deepseek.com", "sk", fetchImpl);
    const content = (result.request?.messages?.[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
    expect(content[2]).toEqual({ type: "file", file_id: "file-api-big" });
  });
});
