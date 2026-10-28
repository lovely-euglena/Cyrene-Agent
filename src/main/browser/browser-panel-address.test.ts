import { describe, expect, it } from "vitest";

import { normalizeAddressInput } from "./browser-panel-controller";

describe("normalizeAddressInput（issue #142 地址栏输入规范化）", () => {
  it("完整 http(s) URL 直通", () => {
    expect(normalizeAddressInput("https://example.com/a?b=1").href).toBe("https://example.com/a?b=1");
    expect(normalizeAddressInput(" http://1.2.3.4:8080/x ").href).toBe("http://1.2.3.4:8080/x");
  });

  it("无协议域名补 https 重试", () => {
    expect(normalizeAddressInput("example.com").href).toBe("https://example.com/");
    expect(normalizeAddressInput("sub.example.co.jp/path").href).toBe("https://sub.example.co.jp/path");
    expect(normalizeAddressInput("8.137.20.111:443").href).toBe("https://8.137.20.111/"); // 443=https 默认端口，URL 序列化省略
  });

  it("搜索词回退 Bing（含空格或不含点）", () => {
    const q = normalizeAddressInput("天气");
    expect(q?.hostname).toBe("www.bing.com");
    expect(q?.searchParams.get("q")).toBe("天气");
    const phrase = normalizeAddressInput("how to open file");
    expect(phrase?.searchParams.get("q")).toBe("how to open file");
  });

  it("引擎参数生效（issue #142 设置项：google/baidu）", () => {
    expect(normalizeAddressInput("天气", "google")?.hostname).toBe("www.google.com");
    expect(normalizeAddressInput("天气", "baidu")?.hostname).toBe("www.baidu.com");
    expect(normalizeAddressInput("天气", "baidu")?.searchParams.get("wd")).toBe("天气");
    expect(normalizeAddressInput("天气", "not-an-engine" as never)?.hostname).toBe("www.bing.com"); // 未知回退默认
  });

  it("首尾点号的畸形输入不硬当域名（走搜索回退）", () => {
    expect(normalizeAddressInput(".")?.hostname).toBe("www.bing.com");
    expect(normalizeAddressInput("a..")?.hostname).toBe("www.bing.com"); // 结尾点——搜索回退
  });

  it("显式非 http 协议报 null（unsupported 由调用方判定）", () => {
    expect(normalizeAddressInput("ftp://example.com")).toBeNull();
    expect(normalizeAddressInput("javascript:alert(1)")).toBeNull();
    expect(normalizeAddressInput("file:///etc/passwd")).toBeNull();
  });

  it("空输入 null", () => {
    expect(normalizeAddressInput("")).toBeNull();
    expect(normalizeAddressInput("   ")).toBeNull();
  });
});
