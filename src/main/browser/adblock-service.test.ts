import * as fs from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildAllowlistRulesText,
  initAdblock,
  loadAdblockConfig,
  parseAllowlist,
  invalidateStaleEngineCache,
  type AdblockDeps,
} from "./adblock-service";

/** #143 广告拦截服务：纯函数 + applyConfig 状态机（mock 引擎）。
 * initAdblock(session, deps, getConfig)——applyConfig 每次从 getConfig
 * 重读配置，签名（enabled|allowlist 排序）未变则跳过重装。 */

function makeDeps(overrides: Partial<AdblockDeps> = {}): AdblockDeps & { calls: string[] } {
  const calls: string[] = [];
  const engine = () => ({
    enableBlockingInSession: () => calls.push("enable"),
    disableBlockingInSession: () => calls.push("disable"),
  });
  return {
    calls,
    loadPrebuilt: vi.fn(async () => engine()),
    parseRules: vi.fn((text: string) => { calls.push(`parse:${text}`); return engine(); }),
    mergeEngines: vi.fn((engines) => { calls.push(`merge:${engines.length}`); return engine(); }),
    deserialize: vi.fn(() => engine()),
    cachePath: "/tmp/adblock-engine-test.bin",
    ...overrides,
  };
}

describe("allowlist 解析与规则文本", () => {
  it("逗号/换行混排解析 + 去空去重 + host 规整（去协议/路径/大小写）", () => {
    expect(parseAllowlist("example.com, news.example.org\n\nads.net,")).toEqual([
      "example.com", "news.example.org", "ads.net",
    ]);
    expect(parseAllowlist("  https://Example.com/page  ")).toEqual(["example.com"]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("例外规则文本：ABP 语法 @@||host^$document", () => {
    expect(buildAllowlistRulesText(["example.com", "news.example.org"]))
      .toBe("@@||example.com^$document\n@@||news.example.org^$document");
    expect(buildAllowlistRulesText([])).toBe("");
  });
});

describe("loadAdblockConfig", () => {
  it("settings 原始字段 → AdblockConfig", () => {
    expect(loadAdblockConfig({ adblockEnabled: true, adblockAllowlist: "a.com, b.com" }))
      .toEqual({ enabled: true, allowlist: ["a.com", "b.com"] });
    expect(loadAdblockConfig({ adblockEnabled: false, adblockAllowlist: "" }).enabled).toBe(false);
  });
});

describe("initAdblock applyConfig 状态机", () => {
  const fakeSession = {} as unknown;
  let currentConfig = { enabled: false, allowlist: [] as string[] };

  beforeEach(() => {
    currentConfig = { enabled: false, allowlist: [] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response)));
  });
  afterEach(() => {
    clearShellCache();
    vi.unstubAllGlobals();
  });
  function clearShellCache(): void {
    try { fs.rmSync("/tmp/adblock-engine-test.bin", { force: true }); } catch { /* 忽略 */ }
  }
  function makeService(deps = makeDeps()) {
    const service = initAdblock(fakeSession, deps, () => currentConfig);
    return { service, deps };
  }

  it("enabled=true：预编译引擎装配并 enable；allowlist 变化走 merge", async () => {
    const { service, deps } = makeService();
    currentConfig = { enabled: true, allowlist: [] };
    await service.applyConfig();
    expect(deps.calls).toContain("enable");

    currentConfig = { enabled: true, allowlist: ["example.com"] };
    await service.applyConfig();
    expect(deps.calls.some((c) => c.startsWith("parse:@@||example.com^$document"))).toBe(true);
    expect(deps.calls).toContain("merge:2");
    service.dispose();
  });

  it("签名未变不重装（重复 apply 同配置只 enable 一次）", async () => {
    const { service, deps } = makeService();
    currentConfig = { enabled: true, allowlist: [] };
    await service.applyConfig();
    await service.applyConfig();
    expect(deps.calls.filter((c) => c === "enable").length).toBe(1);
    service.dispose();
  });

  it("enabled=false：先 disable 再清引擎；再次启用重装", async () => {
    const { service, deps } = makeService();
    currentConfig = { enabled: true, allowlist: [] };
    await service.applyConfig();
    currentConfig = { enabled: false, allowlist: [] };
    await service.applyConfig();
    expect(deps.calls[deps.calls.indexOf("enable") + 1]).toBe("disable");
    currentConfig = { enabled: true, allowlist: [] };
    await service.applyConfig();
    expect(deps.calls.filter((c) => c === "enable").length).toBe(2);
    service.dispose();
  });

  it("预编译拉取失败回退 deserialize 旧缓存；全失败则无拦截不抛错", async () => {
    currentConfig = { enabled: true, allowlist: [] };
    const deps = makeDeps({
      loadPrebuilt: vi.fn(async () => { throw new Error("offline"); }),
    });
    const { service } = makeService(deps);
    await service.applyConfig(); // 无缓存文件：readFile 失败 → 全失败路径不抛错
    expect(deps.deserialize).not.toHaveBeenCalled();
    service.dispose();

    const deps2 = makeDeps({
      loadPrebuilt: vi.fn(async () => { throw new Error("offline"); }),
      deserialize: vi.fn(() => ({ enableBlockingInSession: () => undefined, disableBlockingInSession: () => undefined })),
    });
    deps2.cachePath = "/tmp/adblock-test-cache.bin";
    fs.writeFileSync(deps2.cachePath, Buffer.from("engine"));
    const { service: service2 } = makeService(deps2);
    await service2.applyConfig();
    expect(deps2.deserialize).toHaveBeenCalled();
    service2.dispose();
    fs.rmSync(deps2.cachePath, { force: true });
  });

  it("stale 缓存：invalidateStaleEngineCache 删过期文件，不存在不抛", async () => {
    const p = "/tmp/adblock-stale-test.bin";
    fs.writeFileSync(p, Buffer.from("x"));
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(p, new Date(old), new Date(old));
    invalidateStaleEngineCache(p);
    expect(fs.existsSync(p)).toBe(false);
    invalidateStaleEngineCache("/tmp/adblock-nonexistent.bin");
  });
});
