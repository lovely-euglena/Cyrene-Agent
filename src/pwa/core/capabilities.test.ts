import { describe, expect, it } from "vitest";
import { defaultCapabilities, parseCapabilities, showPendingFor } from "./capabilities";

describe("parseCapabilities", () => {
  it("解析完整声明", () => {
    const parsed = parseCapabilities({
      impl: "cf-workers",
      protocol: "v0",
      sync: true,
      clone: true,
      cursor: "server",
      generation: "none",
      pairing: "shared-secret",
      pwa: false,
      maxBatchBytes: 1048576,
    });
    expect(parsed).toEqual({
      impl: "cf-workers",
      protocol: "v0",
      sync: true,
      clone: true,
      cursor: "server",
      generation: "none",
      pairing: "shared-secret",
      pwa: false,
      maxBatchBytes: 1048576,
    });
  });

  it("缺失/非法字段回退兼容默认（老服务端行为不变）", () => {
    const parsed = parseCapabilities({ impl: "old-server" });
    const base = defaultCapabilities();
    expect(parsed.impl).toBe("old-server");
    expect(parsed.generation).toBe(base.generation);
    expect(parsed.pwa).toBe(base.pwa);
    expect(parsed.cursor).toBe("server");
  });

  it("非对象输入返回默认", () => {
    expect(parseCapabilities(null)).toEqual(defaultCapabilities());
    expect(parseCapabilities("nope")).toEqual(defaultCapabilities());
  });

  it("generation=none 不回落（形态降级的关键字段）", () => {
    expect(parseCapabilities({ generation: "none" }).generation).toBe("none");
    expect(parseCapabilities({ generation: "bogus" }).generation).toBe("realtime");
  });

  it("cursor=file-offset 保留", () => {
    expect(parseCapabilities({ cursor: "file-offset" }).cursor).toBe("file-offset");
  });
});

describe("showPendingFor", () => {
  it("realtime / inline 显示，none 不显示", () => {
    expect(showPendingFor({ ...defaultCapabilities(), generation: "realtime" })).toBe(true);
    expect(showPendingFor({ ...defaultCapabilities(), generation: "inline" })).toBe(true);
    expect(showPendingFor({ ...defaultCapabilities(), generation: "none" })).toBe(false);
  });
});
