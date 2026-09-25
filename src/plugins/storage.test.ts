import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginStorage } from "./storage";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("createPluginStorage", () => {
  it("get/set 落盘并可读回；缺失返回 undefined", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp);
    s.set("cfg", { a: 1 });
    expect(s.get<{ a: number }>("cfg")).toEqual({ a: 1 });
    expect(s.get("missing")).toBeUndefined();
    expect(s.rootDir()).toBe(tmp);
  });

  it("非法 key 抛错", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp);
    expect(() => s.set("../evil", 1)).toThrow(/非法存储 key/);
    expect(() => s.get("a/b")).toThrow(/非法存储 key/);
  });

  it("超过配额拒绝写入且不留半成品；替换按增量计算", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp, { quotaBytes: 1024 });
    s.set("cfg", { a: 1 });
    expect(() => s.set("big", "x".repeat(4000))).toThrow(/超出配额/);
    expect(s.get("big")).toBeUndefined();
    // 替换已有 key：不把旧尺寸重复计入，也不会因旧值大而误判
    s.set("cfg", { a: 2 });
    expect(s.get<{ a: number }>("cfg")).toEqual({ a: 2 });
    expect(existsSync(path.join(tmp, "cfg.json.tmp"))).toBe(false);
  });

  it("CYRENE_PLUGIN_STORAGE_QUOTA_MB=0 关闭配额；环境变量作为缺省生效", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB = "0";
    try {
      const unlimited = createPluginStorage(tmp);
      unlimited.set("big", "x".repeat(4096));
      expect(unlimited.get<string>("big")).toHaveLength(4096);
    } finally {
      delete process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB;
    }
  });

  it("环境变量配额以 MiB 为单位生效", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB = "1";
    try {
      const s = createPluginStorage(tmp);
      s.set("ok", "x");
      expect(() => s.set("too-big", "y".repeat(2 * 1024 * 1024))).toThrow(/超出配额/);
    } finally {
      delete process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB;
    }
  });
});
