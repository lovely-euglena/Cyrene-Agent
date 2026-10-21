// 远程资源放行判定与临时同意状态机契约测试（#192）
import { describe, expect, it } from "vitest";
import {
  createConsentGrants,
  extractDomain,
  judgeRemoteImage,
  type RemoteImagePolicyInput,
} from "./remote-resource-policy";

const defaultInput: RemoteImagePolicyInput = {
  blockEnabled: true,
  fileImageAllowed: false,
  whitelist: [],
};

describe("judgeRemoteImage", () => {
  it("主进程白名单映射协议直接放行（local）", () => {
    const c = createConsentGrants();
    expect(judgeRemoteImage("local-sticker://a/b.png", defaultInput, c)).toBe("local");
    expect(judgeRemoteImage("moment-media://post1/x.png", defaultInput, c)).toBe("local");
    expect(judgeRemoteImage("local-font://ui.ttf", defaultInput, c)).toBe("local");
  });

  it("拦截开启时 http(s) 远程图为 blocked（含域提取）", () => {
    const c = createConsentGrants();
    expect(judgeRemoteImage("https://evil.example.com/pixel.png", defaultInput, c)).toBe("blocked");
    expect(extractDomain("https://www.evil.example.com/pixel.png")).toBe("evil.example.com");
  });

  it("拦截关闭时 http(s) 全放行（向后兼容旧行为）", () => {
    const c = createConsentGrants();
    expect(judgeRemoteImage("https://evil.example.com/p.png", { ...defaultInput, blockEnabled: false }, c)).toBe("allowed");
  });

  it("file:// 受 chatFileImageAllowed 控制（默认 blocked，防本地路径探测）", () => {
    const c = createConsentGrants();
    expect(judgeRemoteImage("file:///C:/secret.png", defaultInput, c)).toBe("blocked");
    expect(judgeRemoteImage("file:///etc/passwd.png", { ...defaultInput, fileImageAllowed: true }, c)).toBe("allowed");
  });

  it("相对路径与 data:image/ 内联数据无外呼风险，放行", () => {
    const c = createConsentGrants();
    expect(judgeRemoteImage("assets/local.png", defaultInput, c)).toBe("allowed");
    expect(judgeRemoteImage("data:image/png;base64,AAAA", defaultInput, c)).toBe("allowed");
  });

  it("持久白名单域放行（hostname 规范化后匹配）", () => {
    const c = createConsentGrants();
    const input = { ...defaultInput, whitelist: ["cdn.example.com"] };
    expect(judgeRemoteImage("https://cdn.example.com/a.png", input, c)).toBe("allowed");
    expect(judgeRemoteImage("https://www.cdn.example.com/a.png", input, c)).toBe("allowed");
    expect(judgeRemoteImage("https://other.example.net/a.png", input, c)).toBe("blocked");
  });

  it("临时同意：本次允许（精确 URL）与回底恢复语义独立", () => {
    const c = createConsentGrants();
    const url = "https://pics.example.com/1.png";
    expect(judgeRemoteImage(url, defaultInput, c)).toBe("blocked");
    c.grantOneShot(url);
    expect(judgeRemoteImage(url, defaultInput, c)).toBe("allowed");
    // 同域不同 URL 仍是 blocked（一次性只放行那张）
    expect(judgeRemoteImage("https://pics.example.com/2.png", defaultInput, c)).toBe("blocked");
  });

  it("临时同意：本会话允许（域级）", () => {
    const c = createConsentGrants();
    c.grantSession("pics.example.com");
    expect(judgeRemoteImage("https://pics.example.com/1.png", defaultInput, c)).toBe("allowed");
    expect(judgeRemoteImage("https://www.pics.example.com/2.png", defaultInput, c)).toBe("allowed");
    expect(judgeRemoteImage("https://other.example.com/3.png", defaultInput, c)).toBe("blocked");
    c.revokeSession("pics.example.com");
    expect(judgeRemoteImage("https://pics.example.com/1.png", defaultInput, c)).toBe("blocked");
  });

  it("sessionDomains 列出运行期授权（占位卡批量操作数据源）", () => {
    const c = createConsentGrants();
    c.grantSession("a.example.com");
    c.grantSession("www.b.example.com");
    expect(c.sessionDomains()).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("createConsentGrants", () => {
  it("初态无任何授权", () => {
    const c = createConsentGrants();
    expect(c.isGranted("https://x.example.com/1.png", "x.example.com")).toBe(false);
    expect(c.sessionDomains()).toEqual([]);
  });
});
