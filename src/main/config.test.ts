import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetConfigCache, resolveDotnetConfig, toBool } from "./config";

const originalAgentHost = process.env.CYRENE_AGENT_HOST;

afterEach(() => {
  resetConfigCache();
  if (originalAgentHost === undefined) delete process.env.CYRENE_AGENT_HOST;
  else process.env.CYRENE_AGENT_HOST = originalAgentHost;
});

describe("toBool", () => {
  it("显式真假词（大小写/空白不敏感）", () => {
    for (const value of ["1", "true", "on", "yes", "TRUE", " On "]) {
      expect(toBool(value)).toBe(true);
    }
    for (const value of ["0", "false", "off", "no", "OFF"]) {
      expect(toBool(value)).toBe(false);
    }
  });

  it("非法值回落 fallback（不再把 abc 当启用）", () => {
    expect(toBool("abc", false)).toBe(false);
    expect(toBool("abc", true)).toBe(true);
    expect(toBool(undefined, true)).toBe(true);
    expect(toBool(null, false)).toBe(false);
    expect(toBool({}, true)).toBe(true);
  });

  it("布尔 / 数字直接判定", () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(false, true)).toBe(false);
    expect(toBool(0, true)).toBe(false);
    expect(toBool(2, false)).toBe(true);
  });
});

describe("resolveDotnetConfig（env > conf > 默认）", () => {
  it("默认启用；0/false/off 关闭；非法值回落默认", () => {
    delete process.env.CYRENE_AGENT_HOST;
    expect(resolveDotnetConfig({ configPath: "missing.conf" }).agentHost).toBe(true);

    process.env.CYRENE_AGENT_HOST = "0";
    expect(resolveDotnetConfig({ configPath: "missing.conf" }).agentHost).toBe(false);

    process.env.CYRENE_AGENT_HOST = "false";
    expect(resolveDotnetConfig({ configPath: "missing.conf" }).agentHost).toBe(false);

    process.env.CYRENE_AGENT_HOST = "off";
    expect(resolveDotnetConfig({ configPath: "missing.conf" }).agentHost).toBe(false);

    process.env.CYRENE_AGENT_HOST = "abc";
    expect(resolveDotnetConfig({ configPath: "missing.conf" }).agentHost).toBe(true);
  });

  it("配置文件兜底，环境变量优先", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-conf-"));
    const confPath = path.join(dir, "cyrene.conf");
    fs.writeFileSync(confPath, "# 注释\nagent-host = off\n", "utf8");

    delete process.env.CYRENE_AGENT_HOST;
    expect(resolveDotnetConfig({ configPath: confPath }).agentHost).toBe(false);

    process.env.CYRENE_AGENT_HOST = "1";
    expect(resolveDotnetConfig({ configPath: confPath }).agentHost).toBe(true);
  });

  it("配置缺省键 → 默认；空环境变量视为未设置（回落到文件）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-conf-"));
    const confPath = path.join(dir, "cyrene.conf");
    fs.writeFileSync(confPath, "agentHost = off\n", "utf8");

    process.env.CYRENE_AGENT_HOST = "";
    expect(resolveDotnetConfig({ configPath: confPath }).agentHost).toBe(false);
    delete process.env.CYRENE_AGENT_HOST;
    expect(resolveDotnetConfig({ configPath: confPath }).agentHost).toBe(false);
  });
});
