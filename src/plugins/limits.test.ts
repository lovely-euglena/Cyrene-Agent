import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PLUGIN_MEMORY_LIMIT_MB,
  DEFAULT_PLUGIN_STORAGE_QUOTA_MB,
  resolvePluginMemoryLimitMb,
  resolvePluginStorageQuotaMb,
} from "./limits";

afterEach(() => {
  delete process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB;
  delete process.env.CYRENE_PLUGIN_MEMORY_LIMIT_MB;
});

describe("插件资源限制解析（设置 > 环境变量 > 默认）", () => {
  it("未配置时回退环境变量，再回退默认", () => {
    expect(resolvePluginStorageQuotaMb()).toBe(DEFAULT_PLUGIN_STORAGE_QUOTA_MB);
    expect(resolvePluginMemoryLimitMb()).toBe(DEFAULT_PLUGIN_MEMORY_LIMIT_MB);

    process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB = "8";
    process.env.CYRENE_PLUGIN_MEMORY_LIMIT_MB = "512";
    expect(resolvePluginStorageQuotaMb()).toBe(8);
    expect(resolvePluginMemoryLimitMb()).toBe(512);
  });

  it("设置页配置优先于环境变量；0 表示不限", () => {
    process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB = "8";
    process.env.CYRENE_PLUGIN_MEMORY_LIMIT_MB = "512";
    expect(resolvePluginStorageQuotaMb(0)).toBe(0);
    expect(resolvePluginStorageQuotaMb(128)).toBe(128);
    expect(resolvePluginMemoryLimitMb(0)).toBe(0);
    expect(resolvePluginMemoryLimitMb(1024)).toBe(1024);
  });

  it("非法环境变量回退默认；负数配置按 0（不限）处理", () => {
    process.env.CYRENE_PLUGIN_STORAGE_QUOTA_MB = "abc";
    process.env.CYRENE_PLUGIN_MEMORY_LIMIT_MB = "-3";
    expect(resolvePluginStorageQuotaMb()).toBe(DEFAULT_PLUGIN_STORAGE_QUOTA_MB);
    expect(resolvePluginMemoryLimitMb()).toBe(DEFAULT_PLUGIN_MEMORY_LIMIT_MB);
    expect(resolvePluginStorageQuotaMb(-5)).toBe(0);
    expect(resolvePluginMemoryLimitMb(-5)).toBe(0);
  });
});
